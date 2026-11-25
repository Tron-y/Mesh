#!/usr/bin/env node
/**
 * yang-harness — 会自己找同事的 agent，一个项目多个会话并行开发。
 *
 * 核心机制
 *   工人池   agents/*.md（frontmatter 的 tags 就是「能力描述」）
 *   路由     按 tag 找人（priority 高者优先），找不到就报错而不是瞎派
 *   隔离     每个任务一个 git worktree + 一条分支 yang/<run>/<task>
 *   并行     同一波（依赖都满足）的任务同时开跑，波内互不干扰
 *   闸门     verify 由 yang 自己跑，非 0 就是没完成，重试后仍红就停
 *   交接     上一棒的 handoff.md 自动注入下一棒的 prompt
 *   合并     每波跑完按序 merge 回 base，冲突立刻停并指出是谁的活
 *
 *   yang registry
 *   yang resolve 前端
 *   yang plan "做一个带登录的待办应用"        # 默认 --parallel=1 的串行 also ok
 *   yang run examples/plan.json --parallel 3  # worktree 隔离 + 并行 + 自动合并
 *   yang view
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite' // 写 Codex 桌面应用的项目库（Node 22+ 内置）

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const AGENTS = path.join(HERE, 'agents')
const RUNS = path.join(ROOT, 'runs')
const ORCHESTRA = process.env.ORCHESTRA_URL || 'http://127.0.0.1:7788/api/ingest'

/* ══ 机器相关的配置：换一台电脑只改这一个文件 ══════════════════
 * 别人的机器上，codex / dsh / claude 装在哪各不相同，所以全部走"三级解析"：
 *   ① loom.config.json 里写死的路径（最优先，用户自己填）
 *   ② 环境变量（LOOM_DSH_BIN、CODEX_BIN、CLAUDE_BIN …）
 *   ③ 自动探测（PATH + 各客户端默认安装位置）
 * 一个都没命中时，doctor 会告诉你它找了哪些位置、该怎么填。
 */
const CONFIG_FILE = process.env.LOOM_CONFIG || path.join(ROOT, 'loom.config.json')

function loadConfig() {
  const empty = { bins: {}, dsh: {}, defaults: {} }
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...empty, _missing: true }
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return { bins: raw.bins || {}, dsh: raw.dsh || {}, defaults: raw.defaults || {}, _raw: raw }
  } catch (e) {
    console.log(`⚠ 读不懂 ${CONFIG_FILE}：${e.message}（先按自动探测走）`)
    return { ...empty, _broken: String(e.message) }
  }
}
let CONFIG = loadConfig()
function reloadConfig() { CONFIG = loadConfig(); return CONFIG }

/** PATH 上有没有这个可执行文件（Windows 会补 PATHEXT） */
function onPath(bin) {
  if (!bin) return false
  if (bin.includes('/') || bin.includes('\\')) return fs.existsSync(bin)
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const p of String(process.env.PATH || '').split(path.delimiter)) {
    if (!p) continue
    for (const e of exts) {
      try { if (fs.existsSync(path.join(p, bin + e))) return true } catch { }
    }
  }
  return false
}

/** 按目录模式找可执行文件，取最新的那个（同一台机可能有多个版本目录） */
function globBins(dirs, rel) {
  const out = []
  for (const d of dirs) {
    if (!d) continue
    try {
      if (!fs.existsSync(d)) continue
      for (const entry of fs.readdirSync(d)) {
        const p = path.join(d, entry, rel)
        if (fs.existsSync(p)) out.push(p)
      }
    } catch { }
  }
  return out.sort()
}

const BIN_SPECS = {
  dsh: {
    label: 'DeepSeek Harness',
    env: ['LOOM_DSH_BIN', 'DSH_BIN'],
    // dsh 的入口特殊：要么是包里的 dsh.cmd，要么是 "DeepSeek Harness.exe" + cli.js（见 dshLauncher）
    detect: () => {
      const roots = [
        CONFIG.dsh?.root,
        process.env.LOOM_DSH_HOME,
        process.env.DSH_HOME,
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'deepseek harness'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'),
        'C:/Program Files/deepseek harness',
        'D:/develop/deepseek harness',
      ].filter(Boolean)
      for (const r of roots) {
        const cmd = path.join(r, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
        if (fs.existsSync(cmd)) return cmd
        const exe = path.join(r, 'DeepSeek Harness.exe')
        if (fs.existsSync(exe)) return exe
      }
      if (onPath('dsh')) return 'dsh'
      return ''
    },
    hint: '装好 DeepSeek Harness 桌面端，或在 loom.config.json 里写 "dsh": { "root": "你的安装目录" }',
  },
  codex: {
    label: 'Codex',
    env: ['LOOM_CODEX_BIN', 'CODEX_BIN'],
    detect: () => {
      // 桌面端：%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe
      const base = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
      const found = base ? globBins([base], 'codex.exe') : []
      if (found.length) return found.pop()
      if (onPath('codex')) return 'codex'
      return ''
    },
    hint: '装 Codex 客户端，或写 "codex": "<codex.exe 绝对路径>"',
  },
  claude: { label: 'Claude Code', env: ['LOOM_CLAUDE_BIN', 'CLAUDE_BIN'], detect: () => (onPath('claude') ? 'claude' : ''), hint: 'npm i -g @anthropic-ai/claude-code，或写 "claude": "<路径>"' },
  cursor: { label: 'Cursor Agent', env: ['LOOM_CURSOR_BIN'], detect: () => (onPath('cursor-agent') ? 'cursor-agent' : ''), hint: '装 cursor-agent，或写 "cursor": "<路径>"' },
  opencode: { label: 'OpenCode', env: ['LOOM_OPENCODE_BIN'], detect: () => (onPath('opencode') ? 'opencode' : ''), hint: '装 opencode，或写 "opencode": "<路径>"' },
  gemini: { label: 'Gemini CLI', env: ['LOOM_GEMINI_BIN'], detect: () => (onPath('gemini') ? 'gemini' : ''), hint: '装 gemini CLI，或写 "gemini": "<路径>"' },
}

/** 解析某个 agent 家族的可执行文件，返回 { bin, from } 或 { bin: '', from: 'missing', hint } */
function resolveAgentBin(kind) {
  const spec = BIN_SPECS[kind]
  if (!spec) return { bin: kind, from: 'adapter 原名' }
  for (const e of spec.env) if (process.env[e]) return { bin: process.env[e], from: `环境变量 ${e}` }
  const cfg = CONFIG.bins?.[kind]
  if (cfg) return { bin: cfg, from: CONFIG_FILE.replace(ROOT + path.sep, '') }
  const auto = spec.detect()
  if (auto) return { bin: auto, from: '自动探测' }
  return { bin: '', from: 'missing', hint: spec.hint }
}

/* ══ 工人池 ══════════════════════════════════════════════ */

function parseCard(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  const meta = {}
  let body = raw
  if (m) {
    body = m[2]
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
      if (!kv) continue
      let v = kv[2].trim()
      if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      else if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1)
      meta[kv[1]] = v
    }
  }
  return {
    id: meta.name || path.basename(file, '.md'),
    name: meta.name || path.basename(file, '.md'),
    tags: meta.tags || [],
    adapter: meta.adapter || 'shell',
    verify: meta.verify || '',
    writes: meta.writes || [],
    model: meta.model || '',
    priority: Number(meta.priority || 0),
    command: meta.command || '',
    description: meta.description || '',
    body: body.trim(),
    file,
  }
}

function registry() {
  if (!fs.existsSync(AGENTS)) return []
  return fs.readdirSync(AGENTS)
    .filter((f) => f.endsWith('.md'))
    .map((f) => parseCard(path.join(AGENTS, f)))
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
}

/**
 * 工人的 CLI 在不在本机。不可用的工人不进池子：否则 LLM 规划看到 roster 里有人就会派，
 * 派了又 spawn ENOENT，白白浪费一次规划（而且很丑）。
 * 判定依据跟 adapterCommand 里真正用的那个 cmd 保持一致：
 *   - codex-exec → codexBin()（藏在 %LOCALAPPDATA% 里，不在 PATH）
 *   - dsh-headless → dshLauncher().cmd（Electron as node）
 *   - exec / shell → 不需要外部 CLI，恒可用
 *   - 其它 → where/which 查 PATH；.ps1 shim 不算（spawn 不走 shell 解析不了）
 */
const AVAIL_CACHE = new Map()
function agentAvailable(agent) {
  if (AVAIL_CACHE.has(agent.name)) return AVAIL_CACHE.get(agent.name)
  let ok = true
  let why = ''
  const onPath = (bin) => {
    if (!bin) return false
    if (bin.includes('\\') || bin.includes('/')) return fs.existsSync(bin)
    const r = process.platform === 'win32' ? spawnSync('where', [bin], { encoding: 'utf8', windowsHide: true }) : spawnSync('which', [bin], { encoding: 'utf8' })
    return r.status === 0
  }
  // npm 风格 CLI：resolveBin 能解析出 .exe 或 node 脚本才算可用（.ps1 shim 不算，spawn 起不来）
  const hasBin = (bin) => { const b = resolveBin(bin); return !!(b.script || (b.cmd && fs.existsSync(b.cmd))) }
  switch (agent.adapter) {
    case 'dsh-headless': { const d = dshLauncher(); ok = fs.existsSync(d.cmd) || onPath(d.cmd); break }
    case 'codex-exec': ok = onPath(codexBin()); break
    case 'claude-print': ok = hasBin('claude'); break
    case 'cursor-agent': ok = hasBin('cursor-agent'); break
    case 'opencode-run': ok = hasBin('opencode'); break
    case 'gemini-print': ok = hasBin('gemini'); break
    case 'exec': ok = true; break
    case 'shell': ok = true; break
    default: ok = onPath(agent.adapter)
  }
  if (!ok) why = `${agent.adapter} 的 CLI 不在本机`
  AVAIL_CACHE.set(agent.name, ok)
  agent.unavailable = why
  return ok
}

/**
 * 可用工人的池子（规划 / 路由都用它）。
 *   --all    不过滤（排查用）
 *   --demo   允许把 demo-* 的夹具工人卖给真实任务；默认排除
 * demo-* 的 verify 多半是恒真（演示用），派给真实需求会"假装成功"，所以默认不进池子。
 * 注意：yang run <plan.json> 走的是 includeDemo: true —— 显式写好的计划（含 demo 项目）要保持能跑。
 */
function liveRegistry(opts = {}) {
  const all = registry().filter((a) => opts.all || agentAvailable(a))
  return opts.includeDemo ? all : all.filter((a) => !/^demo-/.test(a.id))
}

function resolve(role, pool = registry()) {
  const r = String(role || '').toLowerCase()
  // 点名优先：role 直接写工人的 name 就精确命中，不做标签竞争
  const byName = pool.find((a) => a.id.toLowerCase() === r)
  if (byName) return { agent: byName, how: `点名 ${byName.id}` }
  const exact = pool
    .filter((a) => a.tags.map((t) => t.toLowerCase()).includes(r))
    .sort((a, b) => b.priority - a.priority)[0]
  if (exact) return { agent: exact, how: `tag=${r}` }
  const fuzzy = pool.find(
    (a) => a.id.toLowerCase().includes(r) || a.tags.some((t) => t.toLowerCase().includes(r)) || (a.description || '').toLowerCase().includes(r),
  )
  if (fuzzy) return { agent: fuzzy, how: `模糊匹配 "${r}"` }
  return { agent: null, how: `没有工人能接 "${r}"` }
}

/* ══ git ═════════════════════════════════════════════════ */

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true })
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() }
}
/** Codex 客户端的 CLI 藏在 %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe 里，不在 PATH 上。
 *  换机器时由 loom.config.json / CODEX_BIN / 自动探测决定（见 resolveAgentBin）。 */
function codexBin() {
  const r = resolveAgentBin('codex')
  return r.bin || 'codex'
}

/** 从 ~/.dsh/.credentials.yaml 取一个凭据（只读、不落盘、不打印）。 */
function credValue(name) {
  if (process.env[name]) return process.env[name]
  try {
    const f = path.join(process.env.USERPROFILE || '', '.dsh', '.credentials.yaml')
    const line = fs.readFileSync(f, 'utf8').split(/\r?\n/).find((l) => new RegExp('^\\s*' + name + '\\s*:').test(l))
    if (line) return line.replace(new RegExp('^\\s*' + name + '\\s*:\\s*'), '').trim().replace(/^["']|["']$/g, '')
  } catch { }
  return ''
}

/**
 * 从你的 DSH 桌面端配置里抄一份路由给 headless 用：
 * - providers（含中转站 baseURL / 模型清单 / apiKeyEnv）
 * - agent-default-model（你在客户端里配的默认模型）
 * 内联 apiKey 会被剔除，密钥改走环境变量，避免把 key 写进工作区文件。
 * 这样你在桌面端换了默认模型，下一次派活就跟着换。
 */
function dshRoute(modelOverride) {
  const desktop = path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
  const fallback = path.join(HERE, 'dsh-headless-route.yml')
  const PERM = [
    '# 无人值守预设：审批无人可答 → never；写入限制在工作区内',
    '- id: permission',
    '  config:',
    '    presets:',
    '      yang-auto:',
    '        sandbox: workspace-write',
    '        approval: never',
    '        description: yang 无人值守：工作区可写、不弹审批',
    '    defaultPreset: yang-auto',
  ].join('\n')

  if (!fs.existsSync(desktop)) return { patch: fallback, env: { XFTECH_API_KEY: credValue('XFTECH_API_KEY') }, model: '(fallback)', provider: 'xftech', source: '静态兜底' }

  const text = fs.readFileSync(desktop, 'utf8')
  const lines = text.split(/\r?\n/)
  const entry = (id) => {
    const start = lines.findIndex((l) => new RegExp('^-\\s+id:\\s*' + id + '\\s*$').test(l))
    if (start < 0) return ''
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) if (/^-\s+id:/.test(lines[i])) { end = i; break }
    return lines.slice(start, end).join('\n').trimEnd()
  }
  const providers = entry('llm-pi-ai')
  const defaultModel = entry('agent-default-model')
  if (!providers || !defaultModel) return { patch: fallback, env: { XFTECH_API_KEY: credValue('XFTECH_API_KEY') }, model: '(fallback)', provider: 'xftech', source: '桌面配置里没找到模型段' }

  // 剔除内联 apiKey:'!!js ...' 行，保留 apiKeyEnv
  const cleanProviders = providers.split(/\r?\n/).filter((l) => !/^\s+apiKey:\s/.test(l)).join('\n')

  const provider = (defaultModel.match(/provider:\s*([\w.-]+)/) || [])[1] || 'xftech'
  const envModel = modelOverride || process.env.YANG_DSH_MODEL
  let model = (defaultModel.match(/model:\s*([\w.\-+/]+)/) || [])[1] || ''
  let source = '桌面端 agent-default-model'
  if (envModel) { model = envModel; source = modelOverride ? '会话/命令指定' : '环境变量 YANG_DSH_MODEL' }

  // 覆盖默认模型段（当用 env 指定时）
  const modelBlock = envModel
    ? ['- id: agent-default-model', '  name: "@deepseek-ai/dsh-agent-default-model"', '  config:', `    provider: ${provider}`, `    model: ${model}`].join('\n')
    : defaultModel

  const out = [`# 由 yang 从桌面端配置动态生成（${new Date().toISOString()}）`, `# provider=${provider}  model=${model}  source=${source}`, '', cleanProviders, '', modelBlock, '', PERM, ''].join('\n')

  const safe = String(model || 'default').replace(/[^\w.-]+/g, '_')
  const dest = path.join(RUNS, '.yang', 'dsh-route.' + safe + '.yml')
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, out)
  } catch {
    return { patch: fallback, env: { XFTECH_API_KEY: credValue('XFTECH_API_KEY') }, model, provider, source: '写临时补丁失败，用静态兜底' }
  }

  // 所有 apiKeyEnv 声明的变量，都从凭据库里取值注入子进程
  const env = {}
  for (const m of out.matchAll(/apiKeyEnv:\s*([A-Za-z0-9_]+)/g)) {
    const v = credValue(m[1])
    if (v) env[m[1]] = v
  }
  return { patch: dest, env, model, provider, source }
}

/** DSH 的可执行入口：dsh.cmd 里其实是 Electron-as-node 跑 cli.js；headless 用 --patch 挂客户端的同款路由。
 *  安装位置因机器而异：loom.config.json 的 dsh.root / LOOM_DSH_HOME / 自动探测，见 BIN_SPECS.dsh。 */
function dshHome() {
  const cands = [
    CONFIG.dsh?.root,
    process.env.LOOM_DSH_HOME,
    process.env.DSH_HOME,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'deepseek harness'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'),
    'C:/Program Files/deepseek harness',
    'D:/develop/deepseek harness',
  ].filter(Boolean)
  for (const r of cands) {
    if (fs.existsSync(path.join(r, 'DeepSeek Harness.exe'))) return r
    if (fs.existsSync(path.join(r, 'resources', 'app.asar'))) return r
  }
  return ''
}

function dshLauncher(model) {
  const route = dshRoute(model)
  const patchArgs = fs.existsSync(route.patch) ? ['--patch', route.patch] : []
  const baseEnv = { ELECTRON_RUN_AS_NODE: '1', ...(route.env || {}) }
  // ① 显式给的 dsh 可执行（配置文件 / 环境变量）
  const explicit = resolveAgentBin('dsh')
  if (explicit.bin && explicit.from !== '自动探测') {
    return { cmd: explicit.bin, prefix: ['headless', ...patchArgs], shell: /\.(cmd|bat)$/i.test(explicit.bin), route, from: explicit.from }
  }
  // ② 安装目录 + Electron-as-node
  const root = dshHome()
  if (root) {
    const exe = path.join(root, 'DeepSeek Harness.exe')
    const cli = path.join(root, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
    if (fs.existsSync(exe) && fs.existsSync(cli)) {
      return { cmd: exe, prefix: ['--expose-internals', cli, 'headless', ...patchArgs], env: baseEnv, route, from: `安装目录 ${root}` }
    }
    const cmd = path.join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
    if (fs.existsSync(cmd)) return { cmd, prefix: ['headless', ...patchArgs], shell: true, route, from: `安装目录 ${root}` }
  }
  // ③ 最后赌 PATH 上的 dsh
  return { cmd: 'dsh', prefix: ['headless', ...patchArgs], shell: true, route, from: 'PATH（没找到安装目录）' }
}
const GIT_ID = ['-c', 'user.name=yang-harness', '-c', 'user.email=yang@local']
const isRepo = (cwd) => git(cwd, ['rev-parse', '--is-inside-work-tree']).out.includes('true')
const head = (cwd) => git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out

function changedIn(cwd) {
  // git() 把 stderr 也并进 out：非 git 目录会返回 "fatal: not a git repository"，
  // 不按退出码过滤的话，这句错误会被当成"改动了一个文件"。
  const r = git(cwd, ['status', '--porcelain'])
  if (r.code !== 0 || !r.out) return []
  return r.out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^\S+\s+/, ''))
}

/* ══ 计划 ════════════════════════════════════════════════ */

/**
 * 默认计划：契约先行 → 后端∥前端 → 联调。
 * 关键点：T2 只依赖 T0（契约），不依赖 T1（后端实现），所以能和 T1 并行。
 */
const RULE_PLAN = (goal) => ({
  goal,
  planner: 'rule',
  tasks: [
    {
      id: 'T0', role: 'backend', title: '契约冻结（只出接口定义）',
      brief: '只产出 CONTRACT/openapi.yaml 与 CONTRACT/types.ts，不写实现。接口要覆盖需求里所有实体与动作，字段命名与错误结构定死。',
      depends: [], writes: ['CONTRACT/**'], gate: false,
    },
    {
      id: 'T1', role: 'backend', title: '后端实现',
      brief: `按 CONTRACT/** 实现后端与数据层：${goal}`,
      depends: ['T0'], writes: ['src/api/**', 'server/**'], gate: true,
    },
    {
      id: 'T2', role: 'frontend', title: '前端实现（按契约，可用 mock 并行）',
      brief: '按 CONTRACT/openapi.yaml 与 CONTRACT/types.ts 实现界面；接口未就绪用 mock，字段与契约一致。',
      depends: ['T0'], writes: ['src/web/**', 'public/**'], gate: true,
    },
    {
      id: 'T3', role: 'qa', title: '联调 + 验收',
      brief: '起服务、跑 e2e、逐条核对契约与实现一致；失败要归因到后端/前端/契约。',
      depends: ['T1', 'T2'], writes: ['e2e/**', 'REPORT.md'], gate: true,
    },
  ],
})

/**
 * 从模型输出里抠出第一个完整的顶层 JSON 对象。
 * 按括号深度扫描而不是用贪婪正则：模型经常在 JSON 后面再解释两句，贪婪正则会把它们一起吞进去。
 * 跳过字符串字面量里的括号和转义引号。
 */
function extractJson(text) {
  const s = String(text || '')
  const start = s.indexOf('{')
  if (start < 0) return ''
  let depth = 0
  let inStr = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1) }
  }
  return ''
}

/**
 * 让 LLM 把用户的一句话拆成任务。
 * 关键：用户原话里常常已经写了「谁做什么」（"dsh 做格式设计，codex 做内容填充"），
 * 所以 prompt 里把工人池连 adapter / description 一起给它，并允许任务直接用 agent 字段点名。
 * 点名 > tag：runOne 里会先看 task.agent。
 */
function planByLLM(goal, pool, opts = {}) {
  const projectDir = opts.cwd ? path.resolve(opts.cwd) : ''
  // 每种适配器的"启动开销"差很多：dsh 十几秒能动手，codex 每次要先读 skills/AGENTS.md，
  // 一个建单行 txt 的活也要两分钟。把这个事实告诉规划器，它才会把碎活派给快的工人。
  const SPEED = {
    'dsh-headless': '快（十几秒就能动手）',
    'codex-exec': '慢（每次启动 1–3 分钟，会先读配置和技能文档）',
    'claude-print': '中（十几秒到一分钟）',
    'opencode-run': '中',
    'cursor-agent': '中',
    'gemini-print': '中',
    'exec': '快',
    'shell': '快',
  }
  const roster = pool
    .map((a) => `- ${a.id} | tags: ${a.tags.join(',') || '-'} | adapter: ${a.adapter}（${SPEED[adapterFamily(a.adapter)] || '未知速度'}） | ${a.description || ''}`)
    .join('\n')
  const models = opts.models || {}
  const modelHint = Object.keys(models).length
    ? `\n本会话用户指定了模型：${Object.entries(models).map(([k, v]) => `${k}=${v}`).join('，')}。写 brief 时不用提模型，派活时会自动带上。`
    : ''
  const prompt = [
    '你是任务编排器。把用户的一句话拆成有依赖的任务，分派给工人池里的 agent。',
    '',
    '用户原话里如果已经说了"谁做什么"（例如"dsh 做格式设计，codex 做内容填充"），必须照办：',
    '  - 在对应任务里写 "agent": "<工人 name>" 直接点名；',
    '  - 把用户说的分工原封不动写进 brief 的开头，例如 "用户要求：用 dsh 做格式设计。"',
    '用户没点名时，用 role 字段填一个工人的 tag。',
    '',
    '只输出一个 JSON 对象，不要解释、不要 markdown 代码块：',
    '{"goal":"...","tasks":[{"id":"T1","agent":"frontend-codex","role":"frontend","title":"...","brief":"...","verify":"node -e \\"process.exit(require(\'fs\').existsSync(\'index.html\')?0:1)\\"","depends":[],"writes":["src/**"],"gate":true}]}',
    '',
    '规则：',
    '1. 任务数量 1–5 个，id 用 T0、T1…；能并行就并行（depends 只写真正必须先完成的）。',
    '2. brief 要自包含：工人看不到用户原话，只看得到 brief。把目标、分工、产出文件、验收标准都写进去。',
    '3. writes 写这个任务允许改的路径（glob），不同任务的 writes 尽量不重叠。',
    '4. verify 是这个任务的验收命令：在项目目录里跑，退出码 0 才算完成。必须针对本任务真正要产出的东西，'
      + '例如产出 hello.txt 就用 node -e "process.exit(require(\'fs\').existsSync(\'hello.txt\')?0:1)"。'
      + '一条命令、单行、只依赖 node 和标准库（不要 npm install、不要起服务器、不要跑网络）。实在想不出就省略，用工人卡自带的 verify。',
    '5. gate: true 表示完成后要跑 verify 做闸门。',
    '6. 单个小任务（例如只做一个 html）就一个任务，不要硬拆成流水线。',
    '7. 只能从下面"工人池"里选，name 必须一字不差；不要选名字带 demo 的（那是演示夹具，不会真干活）。',
    '8. 看 adapter 后面的速度：建一个文件、改一行字这种碎活，派给快的工人（dsh 十几秒）；'
      + 'codex 每次启动要 1–3 分钟，留给真正需要多文件改造/大量生成的活。'
      + '用户明确点名"用 codex"时照办，不要自作主张换人。',
    '',
    '项目目录：' + (projectDir || '(当前目录)'),
    '写 brief 时用相对路径（"项目根目录下 / src/…"）。**不要写死绝对路径**——工人执行时会被明确告知真实工作目录，',
    '你把调度器自己的路径写进去，工人就会跑去改别的项目。',
    '',
    '工人池：', roster, modelHint, '', '用户目标：', goal,
  ].filter(Boolean).join('\n')
  const d = dshLauncher(models.planner || models.dsh)
  const startedAt = Date.now()
  const r = spawnSync(d.cmd, [...d.prefix, prompt], {
    encoding: 'utf8', shell: !!d.shell, timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...(d.env || {}) }, windowsHide: true,
  })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const json = extractJson(out)
  if (!json) throw new Error(`LLM 规划失败（没找到 JSON）：\n${out.slice(0, 800)}`)
  let plan
  try { plan = JSON.parse(json) } catch (e) { throw new Error(`LLM 规划失败（JSON 解析：${e.message}）：\n${json.slice(0, 800)}`) }
  if (!plan || !Array.isArray(plan.tasks) || !plan.tasks.length) throw new Error('LLM 规划结果里没有 tasks')
  plan.planner = 'llm'
  // 记下是谁拆的活，界面上要显示（用户能一眼看出调度用的是哪个模型）
  plan.plannerModel = d.route?.model || ''
  plan.plannerProvider = d.route?.provider || ''
  plan.plannerMs = Date.now() - startedAt
  // 规划时就把"谁来做"定下来：点名优先，其次按 role 找 tag
  for (const t of plan.tasks) {
    const pick = t.agent ? resolve(t.agent, pool) : resolve(t.role, pool)
    if (!pick.agent) throw new Error(`LLM 规划的任务 ${t.id} 找不到工人：${t.agent || t.role}（${pick.how}）`)
    t.agent = pick.agent.id
  }
  return plan
}

/** 按依赖深度分层：同一层 = 可并行的一波。 */
function waves(tasks) {
  const depth = new Map()
  const calc = (t, seen = new Set()) => {
    if (depth.has(t.id)) return depth.get(t.id)
    if (seen.has(t.id)) throw new Error(`依赖成环：${t.id}`)
    seen.add(t.id)
    const deps = (t.depends || []).map((d) => tasks.find((x) => x.id === d)).filter(Boolean)
    const d = deps.length ? 1 + Math.max(...deps.map((x) => calc(x, seen))) : 0
    depth.set(t.id, d)
    return d
  }
  const buckets = []
  for (const t of tasks) {
    const d = calc(t)
    ;(buckets[d] ||= []).push(t)
  }
  return buckets.filter(Boolean)
}

/* ══ 执行 ════════════════════════════════════════════════ */

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

/** 适配器 → 会话模型配置里的键名（plan.models.dsh / plan.models.codex ...）。 */
function adapterFamily(adapter) {
  const map = {
    'dsh-headless': 'dsh',
    'codex-exec': 'codex',
    'claude-print': 'claude',
    'cursor-agent': 'cursor',
    'opencode-run': 'opencode',
    'gemini-print': 'gemini',
  }
  return map[adapter] || 'default'
}

/**
 * Windows 上 npm 装的 CLI 是 `foo.cmd`（在 %APPDATA%\npm），CreateProcess 不认 .cmd，
 * spawn 不走 shell 会 ENOENT。而且走 shell 时几千字的中文 prompt 拼到命令行上会遇到
 * 引号转义和 8191 字符上限。
 * 所以：把 npm 的 .cmd shim 解析开——它本质是 `node "...\node_modules\xxx\cli.js" %*`——
 * 直接拿到 { node 脚本绝对路径 }，用 process.execPath 去跑，不走 shell。
 * 解析不出来再退回 .cmd + shell:true。
 */
function resolveBin(bin) {
  if (!bin) return { cmd: '', shell: false }
  if (bin.includes('\\') || bin.includes('/')) {
    if (fs.existsSync(bin)) return { cmd: bin, shell: /\.(cmd|bat)$/i.test(bin) }
    return { cmd: bin, shell: false }
  }
  if (process.platform !== 'win32') return { cmd: bin, shell: false }
  const r = spawnSync('where', [bin], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) return { cmd: bin, shell: false }
  const hits = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const exe = hits.find((h) => /\.exe$/i.test(h))
  if (exe) return { cmd: exe, shell: false }
  const script = hits.find((h) => /\.(cmd|bat)$/i.test(h))
  if (!script) return { cmd: bin, shell: false }
  // 解析 npm shim：典型一行是  "%_prog%"  "%dp0%\node_modules\xxx\bin\xxx" %*
  // 入口可能没有 .js 后缀（如 opencode-ai/bin/opencode），也可能直接是 .exe（claude-code）。
  // %dp0%\ 和 %~dp0\ 都展开为 shim 所在目录。.exe 直接跑；.js/无后缀脚本用 node 跑。
  try {
    const text = fs.readFileSync(script, 'utf8')
    const dir = path.dirname(script)
    const cands = [...text.matchAll(/"%(?:~?dp0%?)\\([^"\r\n]+)"/gi)].map((m) => path.join(dir, m[1].replace(/\//g, '\\')))
    const entry = cands.find((p) => fs.existsSync(p))
    if (entry) return /\.exe$/i.test(entry) ? { cmd: entry, shell: false } : { cmd: process.execPath, script: entry, shell: false }
  } catch { /* 读不到就退回 shell */ }
  return { cmd: script, shell: true }
}

/** adapterCommand 的辅助：如果 resolveBin 解析出了 node 脚本，args 前面要插上脚本路径。 */
function withBin(b, args) {
  return { cmd: b.cmd, args: (p) => [...(b.script ? [b.script] : []), ...args(p)], shell: b.shell }
}

function adapterCommand(agent, task = {}) {
  switch (agent.adapter) {
    case 'dsh-headless': {
      const d = dshLauncher(task.model)
      return { cmd: d.cmd, args: (p) => [...d.prefix, p], shell: !!d.shell, env: d.env || {}, route: d.route }
    }
    // Claude Code：-p + --output-format=stream-json 必须带 --verbose，否则直接报错退出
    case 'claude-print': return { ...withBin(resolveBin(resolveAgentBin('claude').bin || 'claude'), (p) => ['-p', p, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']), route: { provider: 'claude', model: task.model || '(客户端默认)', source: task.model ? '会话指定' : '客户端默认' } }
    case 'codex-exec': {
      const m = task.model ? ['-m', task.model] : []
      return { cmd: codexBin(), args: (p) => ['exec', p, ...m, '--json', '--skip-git-repo-check', '-s', 'workspace-write'], route: { provider: 'codex', model: task.model || '(桌面端 config.toml)', source: task.model ? '会话指定' : '桌面端默认' } }
    }
    case 'cursor-agent': return withBin(resolveBin(resolveAgentBin('cursor').bin || 'cursor-agent'), (p) => ['-p', p])
    case 'opencode-run': return withBin(resolveBin(resolveAgentBin('opencode').bin || 'opencode'), (p) => ['run', p])
    case 'gemini-print': return withBin(resolveBin(resolveAgentBin('gemini').bin || 'gemini'), (p) => ['-p', p])
    case 'exec': return { cmd: agent.command, args: () => [], shell: true, env: true }
    case 'shell': return { cmd: '', args: (p) => [p], shell: true }
    default: return { cmd: agent.adapter, args: (p) => [p] }
  }
}

/** 别人的留言：发给我、又不是我自己发的（派活消息除外）→ 注入我的 prompt。 */
function busInbox(agentName, limit = 5) {
  if (!fs.existsSync(BUS)) return []
  const out = []
  for (const line of fs.readFileSync(BUS, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let m
    try { m = JSON.parse(line) } catch { continue }
    if ((m.to || []).includes(agentName) && m.from !== agentName && m.kind !== 'dispatch') out.push(m)
  }
  return out.slice(-limit)
}

function buildPrompt(agent, task, ctx, slot) {
  // ⚠ 第一行必须是任务本身：codex / claude / dsh 都把首次用户消息的开头当会话标题/预览。
  // 一旦模板说明排在最前面，被调用的那个客户端里看到的就全是"你是团队里的一个工人…"，
  // 而不是"写一个前端登录页面"——留痕就等于没有。
  const title = String(task.title || task.role || task.id || '').trim()
  const parts = [
    title,
    '',
    '（这是 Trony harness 派给你的活。下面先讲这一棒要做什么，再讲你的岗位说明。）',
    '',
    '───── 任务 ─────',
    `# ${task.id} ${title}`,
    task.brief || '',
    '',
    // 岗位说明是写给"这个工人一贯怎么干活"的，常常写死在某个历史项目上（例如"只写后端、不要写 HTML"）。
    // 不声明优先级的话，agent 会拿它去否决本轮任务，然后交回一段"我没做，因为冲突"的说明。
    '───── 岗位说明 ─────',
    '以下描述你的分工和风格，来自其它项目。岗位说明里的"只写 X / 不要动 Y"这类历史约束，',
    '如果和上面的任务冲突，**一律按任务执行**；只有任务没提到的部分才参考它。',
    '',
    agent.body,
  ]
  // 工作目录必须写死给它：不定的话 agent 会自己往父目录猜（实测 claude 把文件写到了项目根外面的上一层，
  // 然后被它自己的"只能在允许目录内写"拦住，任务失败得很冤枉）
  const worksIn = slot.worktree
  parts.push('', `───── 工作目录 ─────`, `本次只在下面这个目录里干活，读写文件都不许跑到它的父目录或别的项目：`, worksIn)
  parts.push(slot.branch
    ? `这是独立 worktree（分支 ${slot.branch}，基于 ${ctx.base}）：只改属于自己的文件，完成后会被合并回 ${ctx.base}。`
    : `（没有开分支隔离，直接在这个目录里改。）`)
  if (task.writes?.length) parts.push('', `可写范围：${task.writes.join(', ')}（超出范围先说明理由）`)
  for (const dep of task.depends || []) {
    const h = ctx.handoffs[dep]
    if (!h) continue
    parts.push('', `───── 上游交接 · ${dep}（${h.agent}）─────`, h.summary, h.files?.length ? `产出文件：${h.files.join(', ')}` : '')
    // 上游写的说明文档直接把原文贴进来：下游不用去翻文件，更不用人转交
    for (const d of h.docs || []) {
      parts.push('', `───── 上游文档 · ${d.path}（${dep} 写的，原文，直接按它对标准实现）─────`, d.text)
    }
  }
  const inbox = busInbox(agent.name)
  if (inbox.length) {
    parts.push('', '───── 别人给你留的消息 ─────',
      ...inbox.map((m) => `[${m.from} · ${m.kind}] ${String(m.text).split('\n')[0]}`))
  }
  parts.push('', `验收命令（必须自己跑通）：${task.verify || agent.verify || '(未设置)'}`)
  parts.push('', '完成后用 3–8 行说明：改了什么 / 没做什么 / 已知风险 / 交接给下一棒要注意什么。')
  return parts.join('\n')
}

async function emit(agentName, kind, payload) {
  try {
    await fetch(ORCHESTRA, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: agentName, kind, time: Date.now(), ...payload }),
      signal: AbortSignal.timeout(1500),
    })
  } catch { /* 观察台没起 */ }
}

/* ── 对话总线：agent 之间「说话」的那一层 ─────────────── */
const BUS = path.join(RUNS, 'bus.ndjson')

function busMsg(from, to, text, extra = {}) {
  const targets = Array.isArray(to) ? to : [to]
  const rec = { time: Date.now(), from, to: targets, text: String(text || ''), ...extra }
  try {
    fs.mkdirSync(RUNS, { recursive: true })
    fs.appendFileSync(BUS, JSON.stringify(rec) + '\n')
  } catch { /* 落盘失败不阻塞执行 */ }
  console.log(`  💬 ${from} → ${targets.join(',')}: ${rec.text.split('\n')[0].slice(0, 110)}`)
  return rec
}

function runShell(cmd, cwd) {
  return new Promise((resolve) => {
    // shell:true 会经 cmd.exe，不设 windowsHide 每跑一次 verify 就闪一个黑框
    const child = spawn(cmd, { cwd, shell: true, windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })
}

/* ── 运行状态 + 外部控制（中台 → yang） ───────────────── */

const statePath = (ctx) => path.join(ctx.dir, 'state.json')

function setState(ctx, taskId, state, agentName) {
  try {
    const file = statePath(ctx)
    const cur = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : { runId: ctx.id, cwd: ctx.cwd, base: ctx.base, planner: ctx.plan?.planner, models: ctx.plan?.models || {}, tasks: [], status: 'running' }
    cur.updatedAt = Date.now()
    cur.child = [...(ctx.children?.entries() || [])].map(([taskId2, v]) => ({ taskId: taskId2, agent: v.agent, pid: v.child?.pid || null }))
    if (taskId) {
      const t = cur.tasks.find((x) => x.id === taskId) || (() => { const n = { id: taskId, role: '', title: '' }; cur.tasks.push(n); return n })()
      if (state) {
        t.state = state
        const now = Date.now()
        if (state === 'running' && !t.startedAt) t.startedAt = now
        if ((state === 'ok' || state === 'failed' || state === 'paused' || state === 'blocked') && !t.endedAt) t.endedAt = now
      }
      if (agentName) t.agent = agentName
    }
    fs.writeFileSync(file, JSON.stringify(cur, null, 2))
  } catch { /* 状态写失败不影响执行 */ }
}

function patchTask(ctx, taskId, obj) {
  try {
    const file = statePath(ctx)
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'))
    const row = cur.tasks.find((x) => x.id === taskId)
    if (row) {
      Object.assign(row, obj)
      // 结束时间在这里补：任务收尾走的是 patchTask，不走 setState，缺了它界面上算不出用时
      const terminal = ['ok', 'failed', 'paused', 'blocked'].includes(row.state)
      if (terminal && !row.endedAt) row.endedAt = Date.now()
      if (row.startedAt && row.endedAt && !row.ms) row.ms = row.endedAt - row.startedAt
    }
    cur.updatedAt = Date.now()
    fs.writeFileSync(file, JSON.stringify(cur, null, 2))
  } catch { /* ignore */ }
}

function finalizeState(ctx, status) {
  if (ctx.heartbeat) { clearInterval(ctx.heartbeat); ctx.heartbeat = null }
  try {
    const file = statePath(ctx)
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'))
    cur.status = status
    cur.updatedAt = Date.now()
    cur.child = []
    fs.writeFileSync(file, JSON.stringify(cur, null, 2))
  } catch { /* ignore */ }
}

/** 杀整棵进程树：shell:true 时子进程是 cmd，孙进程才是真 agent，必须 /T 一起杀。 */
function killTree(child) {
  if (!child || !child.pid) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else child.kill('SIGTERM')
  } catch {
    try { child.kill() } catch { /* already gone */ }
  }
}

/** 盯 runs/<id>/control.ndjson：中台写一行，yang 下一拍就执行。顺便每 5 秒心跳一次。 */
function watchControl(ctx, onPause, onStop) {
  const file = path.join(ctx.dir, 'control.ndjson')
  let offset = 0
  let beat = 0
  const timer = setInterval(() => {
    if (++beat % 16 === 0) {
      // 心跳：只刷新时间戳，不改任何状态
      try {
        const p = statePath(ctx)
        const cur = JSON.parse(fs.readFileSync(p, 'utf8'))
        cur.updatedAt = Date.now()
        cur.child = [...(ctx.children?.entries() || [])].map(([tid, v]) => ({ taskId: tid, agent: v.agent, pid: v.child?.pid || null }))
        fs.writeFileSync(p, JSON.stringify(cur, null, 2))
      } catch { /* ignore */ }
    }
    try {
      if (!fs.existsSync(file)) return
      const size = fs.statSync(file).size
      if (size <= offset) return
      const fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(size - offset)
      fs.readSync(fd, buf, 0, buf.length, offset)
      fs.closeSync(fd)
      offset = size
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue
        let m
        try { m = JSON.parse(line) } catch { continue }
        if (m.cmd === 'pause') onPause(m)
        else if (m.cmd === 'stop') onStop(m)
      }
    } catch { /* ignore */ }
  }, 300)
  return () => clearInterval(timer)
}

async function executeTask(task, agent, ctx) {
  const dir = path.join(ctx.dir, task.id)
  fs.mkdirSync(dir, { recursive: true })

  // 1) 隔离：一个任务一个 worktree 一条分支
  const slot = { branch: '', worktree: ctx.cwd }
  if (ctx.worktree) {
    slot.branch = `yang/${ctx.id.replace(/^run-/, '')}/${task.id}`
    slot.worktree = path.join(ctx.dir, 'wt', task.id)
    const add = git(ctx.cwd, ['worktree', 'add', '-b', slot.branch, slot.worktree, ctx.base])
    if (add.code !== 0) {
      console.error(`  ✗ 创建 worktree 失败：${add.out}`)
      return { ok: false, reason: 'worktree 创建失败' }
    }
  }

  const prompt = buildPrompt(agent, task, ctx, slot)
  const family = adapterFamily(agent.adapter)
  const planModels = ctx.plan?.models || {}
  const model = task.model || planModels[family] || planModels.default || ''
  const spec = adapterCommand(agent, { ...task, model })
  const args = spec.args(prompt)
  fs.writeFileSync(path.join(dir, 'prompt.md'), prompt)
  console.log(`\n▶ ${task.id} · ${agent.name}（${agent.adapter}）${slot.branch ? `  branch=${slot.branch}` : ''}`)
  console.log(`  ${(spec.cmd + ' ' + args.join(' ')).slice(0, 200)}`)
  if (spec.route) console.log(`  ↳ 路由 ${spec.route.provider} / ${spec.route.model}（${spec.route.source}）`)
  await emit(agent.name, 'say', { text: `▶ ${task.id} ${task.title}${slot.branch ? ` @ ${slot.branch}` : ''}`, summary: `${task.id} 开始`, cwd: slot.worktree })
  busMsg('yang', agent.name, `派活 ${task.id}：${task.title || task.role}`, { runId: ctx.id, taskId: task.id, kind: 'dispatch' })

  if (ctx.dryRun) {
    const handoff = makeHandoff(task, agent, ctx, '(dry-run 未真正执行)', [], slot)
    ctx.handoffs[task.id] = handoff
    fs.writeFileSync(path.join(dir, 'handoff.md'), handoff.markdown)
    patchTask(ctx, task.id, { state: 'ok', agent: agent.name, dryRun: true })
    console.log('  ⏭  dry-run：跳过执行与 verify')
    return { ok: true, handoff, slot }
  }

  // dsh 工人跑完会在 ~/.dsh/sessions/<项目>/ 下留一个真实会话（带完整日志和标题）。
  // 先拍个快照，跑完 diff 出新会话，再登记进 DSH 的项目列表——这样用户在 DSH 里能看到这一棒的痕迹。
  const dshDir = agent.adapter === 'dsh-headless' ? dshSessionDir(slot.worktree) : ''
  const beforeSessions = dshDir ? listSessionDirs(dshDir) : new Set()
  // codex / claude 的原生会话也要提前拍快照，跑完才知道哪一条是这一棒产生的
  const nativeBefore = sessionSnapshotFor(family)

  // 2) 跑工人（异步：可被中台暂停/终止，边跑边收集输出并在报错时回显到对话）
  const child = spawn(spec.cmd, args, {
    cwd: slot.worktree,
    shell: spec.shell || false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, YANG_PROMPT: prompt, ...(spec.env || {}) },
  })
  ctx.children.set(task.id, { child, agent: agent.name })
  setState(ctx, task.id, 'running', agent.name)

  let output = ''
  let errBuf = ''
  // dsh headless / codex exec 都会把进度和推理写 stderr，不能当报错刷屏。
  // 先安静缓冲，真失败时在退出码处把尾巴一次性亮出来。
  const echoErr = (chunk) => {
    errBuf = (errBuf + chunk).slice(-4000)
  }
  const liveFile = path.join(dir, 'live.log')
  fs.writeFileSync(liveFile, '')
  child.stdout.on('data', (d) => { output += d; try { fs.appendFileSync(liveFile, d) } catch { } })
  child.stderr.on('data', (d) => { echoErr(d.toString()); try { fs.appendFileSync(liveFile, d) } catch { } })
  const exitCode = await new Promise((resolve) => {
    let settled = false
    const done = (c) => { if (!settled) { settled = true; resolve(c) } }
    child.on('error', (e) => { output += `\n[spawn error] ${e}`; done(-1) })
    child.on('close', (c) => done(c))
    // 兜底：进程被杀但管道被孙进程占住时，别让整条流水线卡死
    const startedAt = Date.now()
    const timeoutMs = Math.max(1, Number(process.env.YANG_TASK_TIMEOUT_MIN || 20)) * 60_000
    const guard = setInterval(() => {
      if (settled) return clearInterval(guard)
      if (ctx.control.paused || ctx.control.stopped) {
        clearInterval(guard)
        output += '\n[被中台中断]'
        done(-2)
        return
      }
      // 单个工人卡死（CLI 挂住不动）不该拖住整波：超时就杀掉，按失败处理，下一波照常
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(guard)
        output += `\n[超时 ${Math.round(timeoutMs / 60000)} 分钟，已终止：${agent.name} 这次没有在期限内收工]`
        try { child.kill('SIGKILL') } catch { }
        done(-3)
      }
    }, 500)
  })
  ctx.children.delete(task.id)

  fs.writeFileSync(path.join(dir, 'agent.log'), output)
  console.log(`  ↳ 退出码 ${exitCode}`)

  if (ctx.control.paused) {
    setState(ctx, task.id, 'paused', agent.name)
    return { ok: false, reason: 'paused', slot, dir, paused: true }
  }

  if (exitCode !== 0) {
    setState(ctx, task.id, 'failed', agent.name)
    const detail = [tail(speechOf(output).trim(), 400), errBuf ? 'stderr: ' + tail(cleanOut(errBuf).trim(), 400) : ''].filter(Boolean).join('\n') || '(没有输出)'
    busMsg(agent.name, ['yang', 'user'], `❌ ${task.id} 执行失败（退出码 ${exitCode}）\n${detail}`, {
      runId: ctx.id, taskId: task.id, kind: 'error', exitCode,
    })
    await emit(agent.name, 'result', { text: `失败 退出码 ${exitCode}`, isError: true, summary: '执行失败', cwd: slot.worktree })
    return { ok: false, reason: `agent 退出码 ${exitCode}`, slot, dir, output }
  }

  // 3) 闸门：自己跑 verify。任务自带验收命令优先（按用户这句话定的），否则用工人卡上的
  const verifyCmd = String(task.verify || '').trim() || agent.verify || ''
  let verifyCode = 0
  if (verifyCmd) {
    const v = await runShell(verifyCmd, slot.worktree)
    verifyCode = v.code ?? 1
    fs.writeFileSync(path.join(dir, 'verify.log'), v.out)
    console.log(`  ${verifyCode === 0 ? '✅' : '❌'} verify 退出码 ${verifyCode}`)
    patchTask(ctx, task.id, { verify: verifyCode })
    await emit(agent.name, 'result', { text: `verify ${verifyCode}`, isError: verifyCode !== 0, summary: `verify ${verifyCode === 0 ? 'PASS' : 'FAIL'}`, cwd: slot.worktree })
  }

  const changed = changedIn(slot.worktree)
  // git() 把 stderr 并进 out：非 git 目录时这里会拿到 git 的 usage 帮助全文（上百行），
  // 塞进交接文档会污染下一棒的 prompt，所以按退出码 + 内容双重过滤。
  const statRaw = git(slot.worktree, ['diff', '--stat', 'HEAD'])
  const stat = (statRaw.code === 0 && !/^usage:|not a git repository/i.test(statRaw.out || '')) ? statRaw.out.trim() : ''

  // 4) 提交（worktree 里提交，主检出不受影响）
  let committed = false
  if (ctx.worktree && changed.length) {
    git(slot.worktree, ['add', '-A'])
    const dirty = git(slot.worktree, ['diff', '--cached', '--name-only']).out
    if (!dirty) {
      console.log('  ↪ 与 base 内容相同，无可提交改动')
    } else {
      const c = git(slot.worktree, [...GIT_ID, 'commit', '-m', `yang(${task.id}): ${task.title || task.role}`])
      committed = c.code === 0
      if (!committed) console.log(`  ⚠ 提交失败：${c.out.split('\n')[0]}`)
    }
  } else if (ctx.worktree) {
    console.log('  ↪ 没有产生改动')
  }

  const verdict = { task: task.id, agent: agent.name, branch: slot.branch, verify: verifyCmd, code: verifyCode, changed, committed }

  // 留痕：这一棒在"它自己的客户端"里应该留下一条会话，用户点过去能看到同样的任务
  // DSH 需要把项目登记进 workspace.json；codex / claude 自己就落盘了，我们只要认领那条新会话。
  let dshLinked = null
  const native = {}
  if (dshDir) {
    const fresh = newDshSessions(dshDir, beforeSessions)
    if (fresh.length) {
      verdict.dshSessions = fresh
      dshLinked = linkDshProject(slot.worktree, fresh)
      native.dsh = { id: fresh[0] }
    }
  }
  const fresh2 = claimNativeSession(family, nativeBefore, slot.worktree)
  if (fresh2) {
    native[family] = fresh2
    // codex 的会话要归到 Codex 应用的项目下，并且"变成可见的交互式会话"，否则它落在侧栏的「暂无聊天」里
    if (family === 'codex') {
      const link = linkCodexProject(slot.worktree)
      if (!link.error) {
        native.codex.project = { id: link.id, created: link.created }
        console.log(`  📁 Codex 项目「${link.name}」${link.created ? '已登记' : '已在'}，这条会话会归到它下面`)
        if (codexAppRunning()) console.log('  ⚠ Codex 应用开着，需要退出重开才看得到')
      } else console.log(`  ⚠ Codex 项目登记跳过：${link.error}`)
      // 让这条会话在侧栏里显示成"正常的对话"，标题用我们的任务名而不是整段 prompt
      if (makeCodexThreadVisible(fresh2.id, task.title || task.id)) {
        console.log(`  👁 Codex 侧栏可见：${String(task.title || task.id).slice(0, 40)}`)
      }
    }
  }
  if (Object.keys(native).length) {
    verdict.nativeSessions = native
    patchTask(ctx, task.id, { nativeSessions: native })
    const label = Object.entries(native).map(([k, v]) => `${k} ${String(v.id).slice(0, 8)}`).join(' · ')
    console.log(`  🗂 在 ${label} 里留了痕`)
  }
  fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify(verdict, null, 2))

  const speech = speechOf(output)
  const handoff = makeHandoff(task, agent, ctx, speech, changed, slot, stat)
  ctx.handoffs[task.id] = handoff
  fs.writeFileSync(path.join(dir, 'handoff.md'), handoff.markdown)
  await emit(agent.name, 'deliverable', { files: changed.map((f) => ({ path: f, description: task.title })), text: tail(speech, 600), summary: `${task.id} 完成`, cwd: slot.worktree })

  // 交接 = 一条发给下一棒的消息（这条消息会进总线，也会被注入下一棒的 prompt）
  const downstream = ctx.plan.tasks.filter((t) => (t.depends || []).includes(task.id))
  const nextNames = [...new Set(downstream.map((t) => resolve(t.role, ctx.pool).agent?.name).filter(Boolean))]
  // 非 git 目录没法用 git 统计改动，说"0 个文件"会让人以为工人没干活
  const changedDesc = isRepo(slot.worktree) ? `改动 ${changed.length} 个文件` : '（非 git 目录，改动未统计）'
  const okMsg = verifyCode === 0
    ? `${task.id} ${task.title || ''} 完成（verify ${verifyCode}，${changedDesc}）\n${tail(speech, 260)}`
    : `${task.id} 验收没过（verify ${verifyCode}），我这边先停。`
  busMsg(agent.name, nextNames.length ? nextNames : ['yang'], okMsg, {
    runId: ctx.id, taskId: task.id, kind: verifyCode === 0 ? 'handoff' : 'blocked',
    verify: verifyCode, files: changed,
  })

  if (verifyCode === 0) patchTask(ctx, task.id, { state: 'ok', agent: agent.name, branch: slot.branch })
  // 验收不过也要落一个终态，否则界面会一直挂"进行中"（重试由上层决定要不要再来一次）
  else setState(ctx, task.id, 'failed', agent.name)
  return { ok: verifyCode === 0, handoff, slot, verifyCode, dir, committed }
}

/* ── DSH 留痕：把子 agent 的会话登记进 DSH 自己的项目列表 ────────────
 * headless 跑一次就会写 ~/.dsh/sessions/<编码后的项目路径>/session-<uuid>/session.v*.jsonl.zstd，
 * 但 DSH 桌面端的左侧项目列表来自 ~/.dsh/storages/workspace.json 的 tables.workspaces，
 * 没登记的项目在 App 里根本看不到，用户也就无从"看子 agent 的操作痕迹"。
 * 这里只做两件事：把项目登记进去、把会话 id 挂到该项目下。改动前备份，失败不抛。
 */
const DSH_STORE = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json')

/** "D:\project\a" → "--D-project-a--"（DSH 自己的编码：分隔符折成一个 -，两边包 --） */
function dshSessionDir(cwd) {
  const enc = '--' + String(cwd).replace(/[\\/:]+/g, '-').replace(/^-+|-+$/g, '') + '--'
  return path.join(os.homedir(), '.dsh', 'sessions', enc)
}

function listSessionDirs(dir) {
  try { return new Set(fs.readdirSync(dir).filter((n) => /^session-/.test(n))) } catch { return new Set() }
}

/** 跑完后 diff 出这一棒新产生的 DSH 会话 id。 */
function newDshSessions(dshDir, before) {
  if (!dshDir) return []
  return [...listSessionDirs(dshDir)].filter((n) => !before.has(n))
}

/* ── 在别的 CLI 里也留痕：codex / claude 自己就把会话落盘了，我们只需要认领那一条 ── */

const CODEX_SESS = path.join(os.homedir(), '.codex', 'sessions')
const CLAUDE_SESS = path.join(os.homedir(), '.claude', 'projects')

/** 目录里所有会话文件（codex 按 年/月/日 分层，最多走 5 层） */
function snapshotSessionFiles(root, re) {
  const out = new Set()
  const walk = (dir, depth) => {
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (depth < 5) walk(p, depth + 1) }
      else if (re.test(e.name)) out.add(p)
    }
  }
  walk(root, 0)
  return out
}

/** 会话文件第一行里就带 cwd：用它确认这条会话确实是这个项目里的 */
function sessionFileCwd(file) {
  try {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(8192)
    const n = fs.readSync(fd, buf, 0, 8192, 0)
    fs.closeSync(fd)
    const m = buf.subarray(0, n).toString('utf8').match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    return m ? JSON.parse('"' + m[1] + '"') : ''
  } catch { return '' }
}

/**
 * 认领这一棒在别的 CLI 里产生的会话。
 * @returns {[key, {id, file}] | null} key 用家族名（codex / claude），id 是能在那个 CLI 里 resume 的东西
 */
function claimNativeSession(family, before, cwd) {
  const root = family === 'codex' ? CODEX_SESS : family === 'claude' ? CLAUDE_SESS : ''
  const re = family === 'codex' ? /^rollout-.*\.jsonl$/ : /^[0-9a-f-]{36}\.jsonl$/
  if (!root || !before) return null
  const after = snapshotSessionFiles(root, re)
  const fresh = [...after].filter((p) => !before.has(p))
  if (!fresh.length) return null
  const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
  const hit = fresh.find((p) => norm(sessionFileCwd(p)) === norm(cwd)) || fresh[fresh.length - 1]
  const base = path.basename(hit)
  const id = family === 'codex'
    ? (base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] || base.replace(/\.jsonl$/, ''))
    : base.replace(/\.jsonl$/, '')
  return { id, file: hit }
}

/** 该家族要提前拍快照才能 diff（dsh 在 executeTask 里单独处理） */
function sessionSnapshotFor(family) {
  if (family === 'codex') return snapshotSessionFiles(CODEX_SESS, /^rollout-.*\.jsonl$/)
  if (family === 'claude') return snapshotSessionFiles(CLAUDE_SESS, /^[0-9a-f-]{36}\.jsonl$/)
  return null
}

/* ── 让 Codex 应用把会话归到项目下 ──────────────────────────────
 * 结论（实测 `~/.codex/state_5.sqlite`）：
 *   · 应用的"项目"= `projects` 表 + `project_roots` 表（一个项目可以有多个根目录）
 *   · 会话属于哪个项目，是按 `threads.cwd` 是否落在 `project_roots.path` 下算的
 *     （467/560 条线程就是这样被归类的；`threads.project_id` 全是 null，没用它）
 *   · `~/.codex/.codex-global-state.json` 只是渲染进程的缓存，应用一退出/启动就用库重建，
 *     往里写项目会被原样抹掉（实测 12:39 被覆盖回 16 个项目）
 * 所以要写就写库，别写那个 JSON。
 */
const CODEX_DB = path.join(os.homedir(), '.codex', 'state_5.sqlite')
const CODEX_CONFIG = path.join(os.homedir(), '.codex', 'config.toml')
const normPath = (p) => String(p || '').replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '').toLowerCase()

function backupOnce(file) {
  const bak = file + '.yang-bak'
  try { if (!fs.existsSync(bak)) fs.copyFileSync(file, bak) } catch { /* 备份失败就别写 */ return null }
  return bak
}

/** Codex 桌面应用是否正开着。注意：它的主进程叫 ChatGPT.exe（MSIX 包 OpenAI.Codex），
 *  `codex.exe` 只是它拉起的 app-server，杀了会被它重新拉起——所以要认路径，不能只认进程名。 */
function codexAppRunning() {
  try {
    if (process.platform !== 'win32') return false
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      "@(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'ChatGPT.exe' -and $_.ExecutablePath -like '*OpenAI.Codex*') -or $_.Name -eq 'codex.exe' }).Count"],
    { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    const n = Number(String(r.stdout || '').trim())
    return n > 0
  } catch { return false }
}

/** 在 Codex 的库里登记项目目录（幂等）。返回 {id, created} 或 {error} */
function linkCodexProjectDb(cwd) {
  if (!fs.existsSync(CODEX_DB)) return { error: '没有 ~/.codex/state_5.sqlite' }
  const want = normPath(cwd)
  let db
  try {
    db = new DatabaseSync(CODEX_DB)
    db.exec('pragma busy_timeout = 5000')
    const found = db.prepare(
      "select p.id, p.name from projects p join project_roots r on r.project_id = p.id" +
      " where lower(replace(replace(rtrim(r.path, '\\'), '/', '\\'), '', '')) = ?"
    ).get(want)
    if (found) { db.close(); return { id: found.id, name: found.name, created: false } }
    const id = crypto.randomUUID()
    const now = Date.now()
    const minPos = db.prepare('select coalesce(min(position), 0) m from projects').get().m
    const name = path.basename(cwd) || cwd
    backupOnce(CODEX_DB)
    db.exec('begin')
    db.prepare('insert into projects (id, name, metadata, position, created_at_ms, updated_at_ms) values (?,?,?,?,?,?)')
      .run(id, name, '{}', minPos - 1, now, now)
    db.prepare('insert into project_roots (project_id, position, path) values (?,?,?)').run(id, 0, cwd)
    db.prepare('insert into project_idempotency_keys (key, project_id, created_at_ms) values (?,?,?)')
      .run(crypto.randomUUID(), id, now)
    db.exec('commit')
    db.close()
    return { id, name, created: true }
  } catch (e) {
    try { db?.exec('rollback'); db?.close() } catch { }
    return { error: String(e.message || e).slice(0, 160) }
  }
}

/** 让 Codex 也认这个项目：写 JSON 缓存 + 写库 + config.toml 的信任目录。幂等。
 *  ⚠ 应用开着的时候它内存里是旧列表，退出/启动会把这个 JSON 原样写回去，所以我们拒绝在应用运行时写。 */
function linkCodexProject(cwd, { force = false } = {}) {
  if (codexAppRunning() && !force) return { error: 'Codex 应用正在运行——它退出时会用内存里的旧项目列表覆盖。请先完全退出 Codex 再跑。' }
  const threads = codexThreadsFor(cwd)
  const j = linkCodexProjectJson(cwd, threads)
  const d = linkCodexProjectDb(cwd)
  if (j.error && d.error) return { error: `JSON: ${j.error} / 库: ${d.error}` }
  const r = { id: j.id || d.id, name: j.name || d.name, created: j.created || d.created, threads: threads.length, json: !j.error, db: !d.error }
  // config.toml 里补一条"信任的项目目录"
  try {
    const toml = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG, 'utf8') : ''
    const header = `[projects.'${String(cwd).toLowerCase()}']`
    if (!toml.includes(header)) {
      backupOnce(CODEX_CONFIG)
      const add = `${toml.endsWith('\n') || !toml ? '' : '\n'}\n${header}\ntrust_level = "trusted"\n`
      fs.writeFileSync(CODEX_CONFIG, toml + add, 'utf8')
    }
  } catch { /* 写不了 config 不影响前面两步 */ }
  return r
}

/** 侧栏的真源：~/.codex/.codex-global-state.json 的 local-projects / project-order / thread-project-assignments */
const CODEX_STATE = path.join(os.homedir(), '.codex', '.codex-global-state.json')

function linkCodexProjectJson(cwd, threadIds = []) {
  if (!fs.existsSync(CODEX_STATE)) return { error: '没有 .codex-global-state.json' }
  let raw
  try { raw = JSON.parse(fs.readFileSync(CODEX_STATE, 'utf8')) } catch (e) { return { error: 'JSON 读不出来：' + e.message } }
  const want = normPath(cwd)
  const lp = raw['local-projects'] || (raw['local-projects'] = {})
  let id = Object.keys(lp).find((k) => (lp[k]?.rootPaths || []).some((r) => normPath(r) === want))
  let created = false
  if (!id) {
    id = crypto.randomUUID()
    const now = Date.now()
    lp[id] = { id, name: path.basename(cwd) || cwd, rootPaths: [cwd], createdAt: now, updatedAt: now }
    raw['project-order'] = [id, ...(raw['project-order'] || []).filter((x) => x !== id)]
    created = true
  }
  const assign = raw['thread-project-assignments'] || (raw['thread-project-assignments'] = {})
  let added = 0
  for (const t of threadIds) {
    if (!t || assign[t]) continue
    assign[t] = { projectKind: 'local', projectId: id }
    added++
  }
  if (created || added) {
    if (!backupOnce(CODEX_STATE)) return { error: '备份失败，未写入' }
    const text = JSON.stringify(raw)
    const tmp = CODEX_STATE + '.yangtmp'
    fs.writeFileSync(tmp, text, 'utf8')
    JSON.parse(fs.readFileSync(tmp, 'utf8')) // 自检
    fs.renameSync(tmp, CODEX_STATE)
  }
  return { id, name: lp[id].name, created, added }
}

/** 让这条会话在 Codex 应用里"可见"。
 *  实测：`codex exec` 写的线程行是 source='exec' / originator='codex_exec' / has_user_event=0，
 *  应用侧栏会把这些自动化会话藏起来（560 条线程里它只显示少数交互式会话）。
 *  改成应用自己的口径（vscode / Codex Desktop / 1）并写上任务名，才既看得见、标题又是人话。 */
function makeCodexThreadVisible(threadId, title) {
  if (!threadId || !fs.existsSync(CODEX_DB)) return null
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  let db
  try {
    db = new DatabaseSync(CODEX_DB)
    db.exec('pragma busy_timeout = 5000')
    if (t) {
      // 侧栏显示的是 first_user_message / preview，name/title 只是次要字段，四个一起写
      db.prepare("update threads set source='vscode', originator='Codex Desktop', has_user_event=1, name=?, title=?, first_user_message=?, preview=? where id=?")
        .run(t, t, t, t, threadId)
    } else {
      db.prepare("update threads set source='vscode', originator='Codex Desktop', has_user_event=1 where id=?").run(threadId)
    }
    db.close()
    return true
  } catch (e) {
    try { db?.close() } catch { }
    return null
  }
}

/** 扫 Codex 的 rollout，找出属于某个目录的所有线程 id（用来核对/汇报） */
function codexThreadsFor(cwd) {
  const want = normPath(cwd)
  const out = []
  for (const f of snapshotSessionFiles(CODEX_SESS, /^rollout-.*\.jsonl$/)) {
    if (normPath(sessionFileCwd(f)) !== want) continue
    const id = path.basename(f).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1]
    if (id) out.push(id)
  }
  return out
}

function linkDshProject(cwd, sessionIds, opts = {}) {
  if (!fs.existsSync(DSH_STORE)) return null
  try {
    const raw = readJson(DSH_STORE)
    const tables = raw.tables || (raw.tables = {})
    const ws = tables.workspaces || (tables.workspaces = {})
    const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
    const key = Object.keys(ws).find((k) => norm(ws[k]?.path) === norm(cwd))
    let id = key
    // "把项目导入 DSH"：新登记时把该项目下已有的会话一起带进去，历史痕迹不会丢
    const existing = [...listSessionDirs(dshSessionDir(cwd))]
    const seed = opts.all ? existing : []
    if (!id) {
      id = crypto.randomUUID()
      ws[id] = { path: cwd, title: path.basename(cwd) || cwd, sessionIds: [...new Set([...seed, ...sessionIds])] }
      raw.global = raw.global || {}
      raw.global.workspaceIds = [...(raw.global.workspaceIds || []), id]
      console.log(`  🗂  在 DSH 里登记项目「${ws[id].title}」（带入 ${ws[id].sessionIds.length} 条会话）`)
    }
    const list = Array.isArray(ws[id]?.sessionIds) ? ws[id].sessionIds : []
    const wanted = [...new Set([...sessionIds, ...seed])]
    const added = wanted.filter((s) => !list.includes(s))
    if (!added.length) return { id, added: [] }
    ws[id].sessionIds = [...list, ...added]
    const bak = `${DSH_STORE}.yang-bak-${Date.now()}`
    fs.copyFileSync(DSH_STORE, bak)
    const tmp = `${DSH_STORE}.yang-tmp`
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2))
    fs.renameSync(tmp, DSH_STORE)
    console.log(`  🗂  DSH 会话已挂到项目下：${added.length} 条（${added.map((s) => s.replace(/^session-/, '').slice(0, 8)).join(', ')}）`)
    return { id, added, backup: bak }
  } catch (e) {
    console.log(`  ⚠ 登记 DSH 项目失败（不影响本次执行）：${e.message}`)
    return null
  }
}

/**
 * 上游写给下游的说明文档，直接把原文带进交接里。
 * 目的：干掉"前端写完 CONTRACT.md，人再开后端 agent 让它去读那份 md"这一环 ——
 * 下游拿到的 prompt 里就已经有文档内容，不需要自己去找、也不用人工转交。
 * 只取小文本文件（md/txt/json/yaml），最多 2 份、每份 2400 字，避免把 prompt 撑爆。
 */
const DOC_EXT = /\.(md|txt|json|ya?ml)$/i
const SKIP_DIR = new Set(['node_modules', '.git', 'runs', 'dist', 'build', '.next', 'coverage'])

/** 非 git 目录也能找出上游刚写的文档：浅层遍历 + 按 mtime 取最新的几个 */
function freshDocs(root, since, maxDepth = 3) {
  const found = []
  const walk = (dir, rel, depth) => {
    if (depth > maxDepth || found.length > 30) return
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name) || e.name.startsWith('.')) continue
        walk(path.join(dir, e.name), r, depth + 1)
        continue
      }
      if (!e.isFile() || !DOC_EXT.test(e.name)) continue
      try {
        const st = fs.statSync(path.join(dir, e.name))
        if (st.size > 60_000) continue
        if (since && st.mtimeMs < since - 5000) continue
        found.push({ path: r, mtime: st.mtimeMs })
      } catch { }
    }
  }
  walk(root, '', 0)
  return found.sort((a, b) => b.mtime - a.mtime).map((x) => x.path)
}

function docPeek(root, files, since = 0, limit = 2, maxChars = 2400) {
  const cands = [...new Set(files || [])].filter((f) => DOC_EXT.test(f) && !/^(node_modules|\.git|runs)\//.test(f))
  // git 目录能拿到改动清单；非 git 目录（或改动未被 git 记录）就按时间兜底，
  // 否则"上游写了 docs/api.md 给下游"这条链在非 git 项目里是断的。
  if (cands.length < limit) {
    for (const f of freshDocs(root, since)) if (!cands.includes(f)) cands.push(f)
  }
  const out = []
  for (const f of cands) {
    if (out.length >= limit) break
    try {
      const p = path.resolve(root, f)
      const st = fs.statSync(p)
      if (!st.isFile() || st.size > 60_000) continue
      const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim()
      if (!text || text.length < 20) continue
      out.push({ path: f, text: text.length > maxChars ? text.slice(0, maxChars) + `\n…（已截断，全文见 ${f}）` : text })
    } catch { /* 文件读不到就算了 */ }
  }
  return out
}

function makeHandoff(task, agent, ctx, summary, files, slot, stat = '') {
  const downstream = ctx.plan.tasks.filter((t) => (t.depends || []).includes(task.id))
  const docs = docPeek(slot?.worktree || ctx.cwd, files, task.startedAt || 0)
  const markdown = [
    `# 交接 · ${task.id} ${task.title || ''}`,
    `- agent: ${agent.name}（${agent.adapter}）`,
    slot?.branch ? `- 分支: ${slot.branch}` : '',
    `- 时间: ${new Date().toLocaleString('zh-CN')}`,
    `- 验收: ${task.verify || agent.verify || '(未设置)'}`,
    '',
    '## 做了什么',
    summary,
    '',
    '## 改动文件',
    files.length ? files.map((f) => `- ${f}`).join('\n') : '- （未检测到改动）',
    stat ? `\n## diffstat\n\`\`\`\n${stat}\n\`\`\`` : '',
    docs.length ? '\n## 写给下游的说明（原文，直接照此对接，不用再去要文件）' + docs.map((d) => `\n### ${d.path}\n\`\`\`\n${d.text}\n\`\`\``).join('') : '',
    '',
    '## 下一棒',
    downstream.length ? downstream.map((t) => `- ${t.id} → ${t.role}: ${t.title}`).join('\n') : '- 无下游',
  ].filter((x) => x !== '').join('\n')
  return { task: task.id, agent: agent.name, summary, files, docs, markdown, branch: slot?.branch || '' }
}

const tail = (s, n) => (s.length > n ? '…' + s.slice(-n) : s)

/**
 * 把 agent 的原始输出清成"人话"：codex --json / claude stream-json 会吐一堆
 * {"type":"turn.completed","usage":{...}} 之类的行，直接进交接文档和对话总线会很难看。
 * 只丢掉整行都是 JSON 的，正常文字里夹的 { 不动。
 */
function cleanOut(s) {
  return String(s || '')
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim()
      if (!t) return false
      if (t[0] === '{' || t[0] === '[') { try { JSON.parse(t); return false } catch { return true } }
      return true
    })
    .join('\n')
    .trim()
}

/**
 * 从 CLI 的结构化事件流里捞出"人说的话"。
 * claude --output-format=stream-json 和 codex exec --json 的输出**每一行都是 JSON**，
 * cleanOut() 会把它们全丢掉，于是交接摘要变成空的。这里按各家事件格式取正文。
 */
function extractSpeech(s) {
  const said = []
  for (const line of String(s || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let o
    try { o = JSON.parse(t) } catch { continue }
    // codex exec --json：{"type":"item.completed","item":{"type":"agent_message","text":"…"}}
    const it = o.item
    if (it && typeof it.text === 'string' && it.text.trim() && /agent_message|assistant_message|message/.test(String(it.type || ''))) said.push(it.text)
    // claude stream-json：{"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}}
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const c of o.message.content) if (c && c.type === 'text' && c.text) said.push(c.text)
    }
  }
  return said.join('\n').trim()
}

/** 交接摘要：优先用事件流里的人话，没有就退回过滤后的纯文本。 */
function speechOf(output) {
  return extractSpeech(output) || tail(cleanOut(output), 1200)
}

/** 读用户给的 JSON 文件：容忍 UTF-8 BOM（Windows 记事本 / PowerShell 5 默认会写 BOM）。 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

/* ══ 圆桌：让 agent 之间直接对话 ═══════════════════════════ */

/**
 * 让一个工人对着一段提示说一次话。
 * 和 executeTask 的区别：不建 worktree、不跑验收、不产出交接——只说话。
 * 圆桌靠的就是这个：每个参与者看到同一份对话记录，然后接着说。
 */
async function speakOnce(agent, prompt, { cwd, dir, models = {}, timeoutMin = 8, tag = '' } = {}) {
  const family = adapterFamily(agent.adapter)
  const model = models[family] || models.default || ''
  const spec = adapterCommand(agent, { model })
  const args = spec.args(prompt)
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `speak-${tag || Date.now()}.prompt.md`), prompt)
    } catch { }
  }
  const child = spawn(spec.cmd, args, {
    cwd, shell: spec.shell || false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, YANG_PROMPT: prompt, ...(spec.env || {}) },
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  const code = await new Promise((res) => {
    let done = false
    const fin = (c) => { if (!done) { done = true; res(c) } }
    child.on('error', (e) => { out += `\n[spawn error] ${e}`; fin(-1) })
    child.on('close', (c) => fin(c))
    const t = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { }
      out += `\n[圆桌超时 ${timeoutMin} 分钟]`
      fin(-3)
    }, timeoutMin * 60_000)
    t.unref?.()
    child.on('close', () => clearTimeout(t))
  })
  return { code, text: (extractSpeech(out) || cleanOut(out)).trim(), raw: out, err }
}

/** 默认参与者：优先不同适配器，dsh 优先（快），避免一桌全是慢的 */
function pickTalkers(pool, n = 2) {
  const prefer = ['dsh-headless', 'claude-print', 'codex-exec']
  const out = []
  for (const fam of prefer) {
    const a = pool.find((x) => x.adapter === fam && !/demo/i.test(x.name) && !out.includes(x))
    if (a) out.push(a)
    if (out.length >= n) break
  }
  for (const a of pool) {
    if (out.length >= n) break
    if (!/demo/i.test(a.name) && !out.includes(a)) out.push(a)
  }
  return out
}

/**
 * 圆桌模式：`yang talk "话题" --with dsh,codex --rounds 2`
 * 多人轮流对同一个话题发言，每一轮所有人都能看到之前的全部发言——没有人在中间转述。
 * 有人写出 [一致] 就提前收敛。每轮 = 一波，参与者在图上就是节点，对话本身进总线。
 */
async function talkMode(topic, opts = {}) {
  const pool = liveRegistry({ all: opts.all, includeDemo: false })
  const want = String(opts.with || '').split(',').map((s) => s.trim()).filter(Boolean)
  let talkers = want.length
    ? want.map((n) => pool.find((a) => a.name === n)).filter(Boolean)
    : pickTalkers(pool, Number(opts.n || 2))
  if (!talkers.length) { console.error('✗ 没有可用的工人（先跑 yang scan 看谁在）'); process.exit(1) }
  const rounds = Math.max(1, Math.min(6, Number(opts.rounds || 2)))
  const cwd = path.resolve(opts.cwd || process.cwd())
  if (!fs.existsSync(cwd)) { console.error(`✗ 目录不存在：${cwd}`); process.exit(1) }

  const id = `talk-${stamp()}`
  const dir = path.join(RUNS, id)
  fs.mkdirSync(dir, { recursive: true })
  // 和中台的项目列表保持一致，否则侧栏里看不到这场圆桌
  try {
    fs.mkdirSync(RUNS, { recursive: true })
    const pf = path.join(RUNS, 'projects.json')
    const list = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, 'utf8').replace(/^\uFEFF/, '')) : []
    if (!list.includes(cwd)) { list.push(cwd); fs.writeFileSync(pf, JSON.stringify(list, null, 2)) }
  } catch { }
  const ctx = {
    id, dir, cwd, base: '', worktree: false, plan: { tasks: [], models: opts.models || {} },
    children: new Map(), control: { paused: false, stopped: false }, handoffs: {}, results: new Map(),
  }
  const taskIdOf = (r, a) => `R${r}-${a.name}`.toUpperCase().replace(/[^A-Z0-9-]/g, '')
  const writeState = (status, tasks) => {
    try {
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        runId: id, cwd, base: '', status, kind: 'talk', updatedAt: Date.now(),
        message: topic, goal: topic, planner: 'talk', models: opts.models || {},
        parallel: talkers.length, worktree: false, tasks, child: [],
      }, null, 2))
    } catch { }
  }
  // 每轮每个参与者都是一个节点，wave = 轮次：图上就是"第 1 轮 / 第 2 轮"两列
  const tasks = []
  for (let r = 1; r <= rounds; r++) {
    for (const a of talkers) tasks.push({ id: taskIdOf(r, a), agent: a.name, title: `${a.name} 第 ${r} 轮发言`, state: 'pending', wave: r, depends: [], role: 'talk' })
  }
  writeState('running', tasks)
  busMsg('user', ['yang'], topic, { runId: id, kind: 'user' })
  console.log(`▶ ${id}  圆桌：${talkers.map((a) => a.name).join(' / ')} · ${rounds} 轮 · 目录 ${cwd}`)
  console.log(`  预计 ${talkers.length * rounds} 次模型调用（codex 每次 1–3 分钟，dsh 十几秒）`)

  const transcript = []   // {round, agent, text}
  const agreed = new Set()
  for (let r = 1; r <= rounds; r++) {
    for (const tk of talkers) {
      const tid = taskIdOf(r, tk)
      const prev = transcript.map((m) => `[第${m.round}轮 · ${m.agent}] ${m.text}`).join('\n\n') || '（还没有人发言，你先开头）'
      const prompt = [
        '你正在参加一个小型圆桌：几个 AI 工人对同一件事直接对话，中间没有人转述。',
        `话题：${topic}`,
        `参与者：${talkers.map((a) => a.name).join('、')}　当前：第 ${r}/${rounds} 轮，轮到你（${tk.name}）发言。`,
        '',
        '规则：',
        '- 只谈能落地的决定：接口/字段/边界情况/谁负责什么。不要寒暄、不要复述别人的话。',
        '- 和别人冲突时，说清你的方案 + 一句理由；不要贴超过 6 行代码。',
        '- 你认同当前方案、认为可以开工了，就在最后单独一行写 [一致]。',
        '',
        '───── 之前的对话 ─────',
        prev,
        '',
        `（现在轮到你 ${tk.name}，请直接发言，控制在 8 行以内。）`,
      ].join('\n')

      // 状态：这一轮这个人开始说了
      const row = tasks.find((t) => t.id === tid)
      if (row) { row.state = 'running'; row.startedAt = Date.now(); row.wave = r }
      writeState('running', tasks)
      console.log(`\n[第 ${r} 轮] ${tk.name} 正在说…`)
      const res = await speakOnce(tk, prompt, { cwd, dir, models: opts.models, tag: `${r}-${tk.name}` })
      const said = res.text || `（${tk.name} 没有输出，退出码 ${res.code}）`
      transcript.push({ round: r, agent: tk.name, text: said })
      busMsg(tk.name, ['yang', ...talkers.filter((x) => x !== tk).map((x) => x.name)], said, { runId: id, taskId: tid, kind: 'dialog' })
      if (row) {
        row.state = res.code === 0 ? 'ok' : 'failed'
        row.endedAt = Date.now(); row.ms = row.endedAt - (row.startedAt || row.endedAt)
        row.title = `${tk.name}：${said.split('\n')[0].slice(0, 40)}`
      }
      writeState('running', tasks)
      console.log(`  ↳ ${said.split('\n')[0].slice(0, 80)}`)
      if (/\[一致\]/.test(said)) agreed.add(tk.name)
    }
    if (agreed.size >= talkers.length) {
      // 提前收敛：后面几轮没发生的发言，标成"未发言"，图上不留一堆转圈的排队节点
      for (const t of tasks) if (t.state === 'pending') { t.state = 'blocked'; t.title = `${t.agent}（已收敛，未发言）` }
      console.log(`\n🤝 第 ${r} 轮全部 [一致]，提前收敛`)
      break
    }
  }

  const md = [
    `# 圆桌记录 · ${topic}`,
    `- 参与者：${talkers.map((a) => a.name).join('、')}`,
    `- 轮次：${transcript.length ? Math.max(...transcript.map((m) => m.round)) : 0}`,
    `- 收敛：${agreed.size >= talkers.length ? '全部一致' : `未完全一致（${[...agreed].join('、') || '无'}）`}`,
    '',
    ...transcript.map((m) => `## 第 ${m.round} 轮 · ${m.agent}\n${m.text}`),
  ].join('\n')
  fs.writeFileSync(path.join(dir, 'transcript.md'), md)
  writeState('done', tasks)
  busMsg('yang', ['user'], `圆桌结束：${transcript.length} 次发言，${agreed.size >= talkers.length ? '已达成一致' : '未完全一致'}。记录 ${path.join(dir, 'transcript.md')}`, { runId: id, kind: 'done' })
  console.log(`\n✅ 圆桌结束 → ${path.join(dir, 'transcript.md')}`)
  return { id, dir, transcript, agreed: [...agreed] }
}

/* ══ 合并 ════════════════════════════════════════════════ */

function mergeTask(task, res, ctx) {
  if (!ctx.worktree) return { ok: true, merged: false }
  if (!res.slot?.branch) return { ok: true, merged: false }
  if (!res.committed) {
    console.log(`  ↪ ${task.id} 无新提交，跳过合并`)
    if (!ctx.keep) {
      git(ctx.cwd, ['worktree', 'remove', '--force', res.slot.worktree])
      git(ctx.cwd, ['branch', '-d', res.slot.branch])
    }
    return { ok: true, merged: false }
  }
  const r = git(ctx.cwd, [...GIT_ID, 'merge', '--no-ff', '-m', `yang: 合并 ${task.id} · ${task.title || task.role}`, res.slot.branch])
  if (r.code === 0) {
    console.log(`  ⇢ 已合并 ${task.id} → ${ctx.base}`)
    if (!ctx.keep) {
      git(ctx.cwd, ['worktree', 'remove', '--force', res.slot.worktree])
      git(ctx.cwd, ['branch', '-d', res.slot.branch])
    }
    return { ok: true, merged: true, out: r.out }
  }
  const conflicts = git(ctx.cwd, ['diff', '--name-only', '--diff-filter=U']).out
  git(ctx.cwd, ['merge', '--abort'])
  fs.writeFileSync(path.join(ctx.dir, 'CONFLICT.md'), [
    `# 合并冲突 · ${task.id}`,
    `分支 ${res.slot.branch} 无法自动合并回 ${ctx.base}。`,
    '', '## 冲突文件', conflicts || '(无法列出)', '',
    '## 怎么办',
    `1. cd "${ctx.cwd}" && git merge ${res.slot.branch}`,
    '2. 解冲突后 commit，或把冲突丢回给这个 agent 重做。',
    `3. worktree 保留在：${res.slot.worktree}`,
  ].join('\n'))
  return { ok: false, conflicts }
}

/* ══ CLI ═════════════════════════════════════════════════ */

const argv = process.argv.slice(2)
const cmd = argv[0]
const flagStr = (n, d = '') => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const flagOn = (n) => argv.includes(`--${n}`)

function printRegistry(pool) {
  console.log('工人池：')
  for (const a of pool) {
    const live = agentAvailable(a)
    console.log(`  ${live ? '✅' : '✗ '} ${a.name.padEnd(18)} ${String(a.tags.join(',')).padEnd(28)} ${a.adapter.padEnd(14)} ${a.description || ''}${live ? '' : '   ← ' + a.unavailable}`)
    if (a.verify) console.log(`     ${''.padEnd(18)} verify: ${a.verify}`)
  }
}

switch (cmd) {
  case undefined:
  case 'help':
    console.log(`yang-harness — 会自己找同事的 agent（一项目多会话并行开发）

  yang registry                          工人池与能力描述
  yang resolve <role>                    这个角色会派给谁
  yang plan "<目标>" [--planner=llm]      拆任务 + 路由 + 分层（并行波次）
  yang chat "<一句话>" --cwd <dir>         直接开工：LLM 按话里的分工拆活 → 执行（中台「发消息」走的就是它）
      --models dsh=<模型>,codex=<模型>     会话级模型覆盖
  yang run <plan.json> [选项]             执行
      --cwd <项目目录>                    默认当前目录
      --parallel <n>                     同波并发数（默认 3）
      --worktree / --no-worktree         每任务一个 worktree（默认：git 仓库就开）
      --base <分支>                       合并目标（默认当前分支）
      --merge / --no-merge               波后自动合并（默认开）
      --keep                             保留 worktree 与分支（排查用）
      --retry <n>                        单任务重试（默认 1）
      --dry-run                          只演不跑
  yang view                              观察台地址
  yang talk "<要讨论的事>" [--with a,b]    圆桌：几个 agent 直接对话，没有人在中间转述
      --rounds <n>                       讨论几轮（默认 2）
      --with dsh,codex                   指定参与者（默认挑两个不同 CLI）
  yang dsh-link --cwd <目录>              把项目登记进 DSH 应用（连带已有会话）
`)
    break

  case 'doctor': {
    // 换一台电脑第一件事就应该是它：把"每个 agent 我是怎么找到的"摊开
    // --json：给控制台的「环境检查」面板用
    reloadConfig()
    const asJson = flagOn('json')
    const cfgState = fs.existsSync(CONFIG_FILE) ? path.relative(ROOT, CONFIG_FILE) : '（没有 → 全部走自动探测）'
    const rows = []
    for (const kind of Object.keys(BIN_SPECS)) {
      const r = resolveAgentBin(kind)
      const usable = !!r.bin && (r.bin.includes('/') || r.bin.includes('\\') ? fs.existsSync(r.bin) : onPath(r.bin))
      rows.push({ kind, label: BIN_SPECS[kind].label, bin: r.bin || '', from: r.from, usable, hint: r.hint || BIN_SPECS[kind].hint })
    }
    let route = null
    try { const r = dshLauncher(''); if (r.route) route = { provider: r.route.provider, model: r.route.model, source: r.route.source } } catch { }
    const report = {
      platform: process.platform,
      node: process.version,
      git: onPath('git'),
      configFile: fs.existsSync(CONFIG_FILE) ? path.relative(ROOT, CONFIG_FILE) : '',
      agents: rows,
      route,
      ok: rows.filter((x) => x.usable).length,
      bad: rows.filter((x) => !x.usable).map((x) => x.kind),
    }
    if (asJson) { console.log(JSON.stringify(report, null, 2)); break }
    console.log(`Loom 环境自检\n配置文件：${cfgState}`)
    console.log(`平台：${report.platform} · node ${report.node}${report.git ? ' · git ✓' : ' · git ✗（worktree/合并要用）'}\n`)
    const pad = (s, n) => String(s).padEnd(n)
    console.log(`${pad('agent', 10)}${pad('状态', 22)}${pad('来源', 24)}解析到`)
    for (const x of rows) {
      const st = x.usable ? '✅ 可用' : (x.bin ? '❌ 路径不存在' : '❌ 没找到')
      console.log(`${pad(x.kind, 10)}${pad(st, 22)}${pad(x.from, 24)}${x.bin || '—'}`)
    }
    const bad = rows.filter((x) => !x.usable)
    if (bad.length) {
      console.log('\n这些没认到，二选一就能修：')
      for (const x of bad) console.log(`  · ${x.kind}：${x.hint}`)
      console.log(`\n改完跑一次  node yang-harness/yang.mjs doctor  再确认。`)
      console.log(`想要一份模板：node yang-harness/yang.mjs init-config`)
    } else {
      console.log('\n全部就绪，可以直接开工。')
    }
    if (route) console.log(`DSH 路由：${route.provider} / ${route.model}（${route.source}）`)
    break
  }

  case 'init-config': {
    // 把当前机器探测到的结果写成配置模板，别人拿到后按自己机器改
    reloadConfig()
    if (fs.existsSync(CONFIG_FILE) && !flagOn('force')) {
      console.log(`已经有 ${path.relative(ROOT, CONFIG_FILE)} 了。要覆盖加 --force`)
      break
    }
    const bins = {}
    // 只钉"自动探测不稳"的东西。codex 的目录名带版本 hash，钉死反而容易被升级弄坏，所以留空走自动探测
    for (const kind of Object.keys(BIN_SPECS)) bins[kind] = ''
    const tpl = {
      _说明: '换机器只改这个文件。bins 留空 = 自动探测（推荐）；只有自动探测认不到时才填绝对路径。也可用环境变量 LOOM_DSH_BIN / LOOM_CODEX_BIN / LOOM_CLAUDE_BIN 覆盖。',
      bins,
      dsh: { root: dshHome() || '', model: '' },
      defaults: { planner: 'deepseek-flash', parallel: 3, worktree: false },
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(tpl, null, 2) + '\n', 'utf8')
    console.log(`已写入 ${path.relative(ROOT, CONFIG_FILE)}`)
    console.log(JSON.stringify(tpl, null, 2))
    console.log('\n提示：把这份文件给别人，他只要改 bins 里那几行路径就行。')
    break
  }

  case 'scan': {
    // 扫描本机装了哪些 agent CLI，能装进工人池的列出来；--write 缺卡就补卡
    reloadConfig()
    const rb = (k) => resolveAgentBin(k).bin
    const probes = [
      { name: 'codex-frontend', bin: 'codex', candidates: [rb('codex')], adapter: 'codex-exec', tags: ['frontend', 'ui', '前端'], desc: 'Codex 前端工人' },
      { name: 'cursor-worker', bin: 'cursor-agent', candidates: [rb('cursor'), 'cursor-agent'], adapter: 'cursor-agent', tags: ['frontend', 'ui', '前端', 'cursor'], desc: 'Cursor 前端/全栈工人（需要 cursor-agent CLI）' },
      { name: 'claude-worker', bin: 'claude', candidates: [rb('claude')], adapter: 'claude-print', tags: ['general', 'refactor', '重构'], desc: 'Claude 通用工人' },
      { name: 'opencode-worker', bin: 'opencode', candidates: [rb('opencode')], adapter: 'opencode-run', tags: ['coder', 'general'], desc: 'OpenCode 通用工人' },
      { name: 'gemini-worker', bin: 'gemini', candidates: [rb('gemini')], adapter: 'gemini-print', tags: ['research', 'analysis'], desc: 'Gemini 分析工人' },
      { name: 'dsh-worker', bin: 'dsh', adapter: 'dsh-headless', tags: ['backend', 'general', '后端'], desc: 'DeepSeek Harness 工人',
        candidates: [rb('dsh'), dshHome() && path.join(dshHome(), 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')] },
    ]
    const exists = (c) => {
      if (!c) return false
      if (c.includes('\\') || c.includes('/')) return fs.existsSync(c)
      return (process.platform === 'win32'
        ? spawnSync('where', [c], { encoding: 'utf8', windowsHide: true })
        : spawnSync('which', [c], { encoding: 'utf8' })).status === 0
    }
    const existing = new Set(registry().map((a) => a.name))
    const write = flagOn('write')
    console.log('本机 agent CLI 扫描：')
    for (const p of probes) {
      const hit = (p.candidates || [p.bin]).find(exists) || null
      const found = !!hit
      const hasCard = existing.has(p.name)
      console.log(`  ${found ? '✅ 已安装' : '❌ 未安装'}  ${p.bin.padEnd(20)} ${found ? hit.slice(-40) : ''}`)
      console.log(`     ${' '.repeat(0)}卡：${hasCard ? '已注册' : '无'}${hasCard ? '' : `  → ${p.name}`}`)
      const coveredBy = () => registry().find((a) => a.adapter === p.adapter && a.tags.some((tg) => p.tags.includes(tg)))
      if (!hasCard && write && found) {
        const cov = coveredBy()
        if (cov) { console.log(`     ↳ 跳过：${cov.name} 已覆盖 ${p.tags.join('/')}（同类适配器）`); continue }
        const file = path.join(AGENTS, `${p.name}.md`)
        if (fs.existsSync(file)) continue
        fs.writeFileSync(file, [
          '---', `name: ${p.name}`, `tags: [${p.tags.join(', ')}]`, `adapter: ${p.adapter}`, 'priority: 5',
          `verify: node -e "process.exit(0)"`, 'writes: []', `description: ${p.desc}`, '---', '',
          `${p.desc}。把上面的 verify 换成这个项目真实的验收命令，闸门才有效。`,
        ].join('\n'))
        console.log(`     ↳ 已生成 ${path.relative(ROOT, file)}（记得填 verify）`)
      }
    }
    if (!write) console.log('\n加 --write 可以把缺的工人卡自动补进 agents/')
    break
  }

  case 'registry':
    printRegistry(registry())
    break

  case 'resolve': {
    const { agent, how } = resolve(argv[1])
    if (!agent) { console.log(`✗ ${how}。先加一张 agents/*.md`); process.exit(1) }
    console.log(`角色 "${argv[1]}" → ${agent.name}（${how}）`)
    console.log(`  adapter: ${agent.adapter}\n  verify : ${agent.verify}\n  writes : ${(agent.writes || []).join(', ')}`)
    break
  }

  case 'dsh-model': {
    const r = dshRoute(argv[1])
    console.log(`provider : ${r.provider}`)
    console.log(`model    : ${r.model}`)
    console.log(`来源     : ${r.source}`)
    console.log(`补丁     : ${r.patch}`)
    console.log(`注入的key: ${Object.keys(r.env || {}).join(', ') || '(无)'}`)
    console.log('')
    console.log('临时换模型：$env:YANG_DSH_MODEL="deepseek-flash"; 然后重跑')
    break
  }

  case 'dsh-link': {
    // 把某个项目登记进 DSH 应用的项目列表，并把它已有的会话一起挂上去（"导入项目"）。
    const cwd = path.resolve(flagStr('cwd', process.cwd()))
    if (!fs.existsSync(cwd)) { console.error(`✗ 目录不存在：${cwd}`); process.exit(1) }
    const dir = dshSessionDir(cwd)
    const all = [...listSessionDirs(dir)]
    console.log(`项目 : ${cwd}`)
    console.log(`会话 : ${dir}`)
    console.log(`找到 : ${all.length} 条`)
    const r = linkDshProject(cwd, all, { all: true })
    console.log(r ? `✓ 已导入 DSH（新增 ${r.added.length} 条，备份 ${path.basename(r.backup || '')}）` : '✗ 没做成')
    console.log('提示：DSH 应用需要重开（或刷新项目列表）才会显示新项目。')
    break
  }

  case 'codex-link': {
    // 把项目目录登记进 Codex 桌面应用的库，让跑过的会话归到项目下（补历史）
    // --all：把 projects.json 里登记过的项目全部补一遍（一次修好所有历史）
    const targets = flagOn('all')
      ? [...new Set([path.resolve(flagStr('cwd', process.cwd())), ...(readJson(path.join(RUNS, 'projects.json')) || [])])]
        // 演示夹具和跑测目录不要污染用户真正的项目列表
        .filter((p) => !/[\\/](demo|runs|a2a-test\d*|native-[a-z]+)[\\/]/i.test(p))
      : [path.resolve(flagStr('cwd', process.cwd()))]
    let created = 0, existed = 0, skipped = 0
    for (const cwd of targets) {
      const r = linkCodexProject(cwd)
      if (r.error) { console.log(`✗ ${cwd}：${r.error}`); skipped++; continue }
      created += r.created ? 1 : 0
      existed += r.created ? 0 : 1
      console.log(`${r.created ? '＋' : '·'} ${cwd}  → 项目「${r.name}」　会话 ${r.threads} 条　JSON ${r.json ? '✓' : '✗'} 库 ${r.db ? '✓' : '✗'}`)
    }
    console.log(`\n共检查 ${targets.length} 个目录：新建 ${created} 个，已存在 ${existed} 个${skipped ? '，跳过 ' + skipped + ' 个' : ''}`)
    // 写完当场把"Codex 打开时会读到什么"打出来，省得靠猜
    try {
      const raw = JSON.parse(fs.readFileSync(CODEX_STATE, 'utf8'))
      const lp = raw['local-projects'] || {}
      const order = (raw['project-order'] || []).slice(0, 3).map((id) => lp[id]?.name || id)
      console.log(`Codex 侧栏数据（${CODEX_STATE}）：${Object.keys(lp).length} 个项目；最前面的是 ${order.join(' / ')}`)
    } catch { }
    if (skipped) console.log('⚠ 有目录被跳过。让 Codex 完全退出（含托盘、任务管理器里的 codex.exe）后再跑一次。')
    else console.log('✓ 已写入。现在打开 Codex，侧栏最上面应该就是新项目。')
    break
  }

  case 'talk': {
    // 圆桌：几个 agent 对同一件事直接对话，没有人在中间转述
    let topicCut = argv.length
    for (let i = 1; i < argv.length; i++) if (argv[i].startsWith('--')) { topicCut = i; break }
    const topic = argv.slice(1, topicCut).join(' ').trim()
    if (!topic) { console.error('用法：yang talk "要讨论的事" [--with dsh,codex] [--rounds 2] [--cwd 目录]'); process.exit(1) }
    const models = Object.fromEntries(flagStr('models', '').split(',').map((s) => s.split('=').map((x) => x.trim())).filter(([k]) => k))
    const r = await talkMode(topic, {
      with: flagStr('with', ''), rounds: flagStr('rounds', '2'), n: flagStr('n', '2'),
      cwd: flagStr('cwd', process.cwd()), models, all: flagOn('all'),
    })
    if (flagOn('open')) console.log(`\n在观察台里看：http://127.0.0.1:${process.env.PORT || 7788}/?run=${r.id}`)
    break
  }

  case 'plan': {
    let goalCut = argv.length
    for (let i = 1; i < argv.length; i++) if (argv[i].startsWith('--')) { goalCut = i; break }
    const goal = argv.slice(1, goalCut).join(' ').trim() || '一个待办应用'
    const pool = liveRegistry({ all: flagOn('all'), includeDemo: flagOn('demo') })
    let plan
    if (flagStr('planner', 'rule') === 'llm') {
      try { plan = planByLLM(goal, pool, { cwd: flagStr('cwd', '') }) } catch (e) { console.error(`LLM 规划失败，回退 rule：${e.message}`); plan = RULE_PLAN(goal) }
    } else plan = RULE_PLAN(goal)

    console.log(`目标：${plan.goal}\n规划器：${plan.planner}\n`)
    const ws = waves(plan.tasks)
    ws.forEach((w, i) => {
      console.log(`  第 ${i + 1} 波（可并行 ${w.length}）${i > 0 ? '' : ''}`)
      for (const t of w) {
        const { agent } = resolve(t.agent || t.role, pool)
        t.agent = agent?.name || null
        console.log(`    ${t.id} → ${String(t.agent || t.role).padEnd(18)} → ${(agent?.name || '✗ 无可用工人').padEnd(18)} ${t.title}`)
      }
    })
    const out = flagStr('out', path.join(HERE, 'examples', 'plan.json'))
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify(plan, null, 2))
    console.log(`\n计划已写入 ${path.relative(ROOT, out)}`)
    break
  }

  case 'run': await runPlan(null); break

  case 'chat': {
    // 一条消息直接开工：yang chat "<消息>" --cwd <dir> [--models dsh=xxx,codex=yyy] [--parallel 3]
    // = yang plan --planner=llm + yang run，不用落中间文件；规划失败自动回退固定模板。
    // 消息 = argv[1] 起、到第一个 -- 选项之前的所有 token（允许多个词；不能以 -- 开头）
    let cut = argv.length
    for (let i = 1; i < argv.length; i++) if (argv[i].startsWith('--')) { cut = i; break }
    const message = argv.slice(1, cut).join(' ').trim()
    if (!message) { console.error('用法: yang chat "<消息>" --cwd <dir> [--models dsh=a,codex=b] [--parallel 3] [--no-worktree]'); process.exit(1) }
    const pool = liveRegistry({ all: flagOn('all'), includeDemo: flagOn('demo') })
    if (!pool.length) { console.error('✗ 工人池为空：agents/*.md 里没有 CLI 可用的工人。用 yang registry 看看谁不可用。'); process.exit(2) }
    const skipped = (() => {
      const names = new Set(pool.map((a) => a.name))
      return registry().filter((a) => !names.has(a.name)).map((a) => `${a.name}（${a.unavailable || 'CLI 不可用'}）`)
    })()
    if (skipped.length) console.log(`  ⚭ 跳过 ${skipped.length} 个工人：${skipped.join('、')}`)
    const models = Object.fromEntries(flagStr('models', '').split(',').map((s) => s.split('=').map((x) => x.trim())).filter(([k]) => k))
    const cwd0 = path.resolve(flagStr('cwd', process.cwd()))
    // 1) 先占位：中台立刻能看到"正在拆活"，而不是空白几十秒
    const id = `run-${stamp()}`
    const dir = path.join(RUNS, id)
    fs.mkdirSync(dir, { recursive: true })
    try {
      fs.mkdirSync(RUNS, { recursive: true })
      const pf = path.join(RUNS, 'projects.json')
      const list = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, 'utf8')) : []
      if (cwd0 && !list.includes(cwd0)) { list.push(cwd0); fs.writeFileSync(pf, JSON.stringify(list, null, 2)) }
    } catch { }
    const writePlaceholder = (status, extra = {}) => {
      try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
          runId: id, cwd: cwd0, status, updatedAt: Date.now(), planner: 'llm',
          goal: message, message, models, tasks: [], child: [], planning: status === 'planning', ...extra,
        }, null, 2))
      } catch { }
    }
    writePlaceholder('planning')
    busMsg('user', ['yang'], message, { runId: id, kind: 'user' })
    busMsg('yang', ['user'], `收到。先拆活：${message.slice(0, 120)}`, { runId: id, kind: 'say' })
    console.log(`▶ ${id}  🧠 正在拆活：${message.slice(0, 80)}`)
    // 2) 规划
    const t0 = Date.now()
    let plan
    if (flagStr('planner', 'llm') === 'llm') {
      try {
        plan = planByLLM(message, pool, { models, cwd: cwd0 })
        console.log(`🧠 规划完成（${((Date.now() - t0) / 1000).toFixed(1)}s，llm）：${plan.tasks.length} 个任务`)
      } catch (e) {
        console.error(`🧠 LLM 规划失败，回退固定模板：${String(e.message).slice(0, 200)}`)
        plan = RULE_PLAN(message)
        for (const t of plan.tasks) t.agent = resolve(t.role, pool).agent?.id || null
        plan.planner = 'rule'
        writePlaceholder('planning', { plannerNote: `LLM 规划失败，已用固定模板：${String(e.message).slice(0, 120)}` })
      }
    } else {
      plan = RULE_PLAN(message)
      for (const t of plan.tasks) t.agent = resolve(t.role, pool).agent?.id || null
      plan.planner = 'rule'
    }
    if (Object.keys(models).length) plan.models = models
    plan.message = message
    for (const t of plan.tasks) console.log(`  ${t.id} → ${t.agent || t.role}  ${t.title || ''}`)
    // 把"我理解成的分工"说给用户听，像 DSH 回复一样出现在对话里
    const planLines = plan.tasks.map((t) => `${t.id} · ${t.agent || t.role}：${t.title || ''}${(t.depends || []).length ? `（等 ${t.depends.join('、')}）` : ''}`)
    busMsg('yang', ['user'], `拆好了，${plan.tasks.length} 个任务：\n${planLines.join('\n')}`, { runId: id, kind: 'plan' })
    const planFile = path.join(dir, 'plan.json')
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2))
    // 3) 执行（复用占位目录，runId 不变）
    await runPlan(plan, { id, dir })
    break
  }

  /* ══ 执行一份计划（run / chat 共用）。函数声明在 switch 块内会提升到块顶，上面两个 case 可以直接调用。 ═══ */
  async function runPlan(inPlan, pre = null) {
    const file = argv[1]
    const plan = inPlan || (() => {
      if (!file || file.startsWith('--')) { console.error('用法: yang run <plan.json> [--parallel 3] [--cwd <dir>]'); process.exit(1) }
      return readJson(file)
    })()
    // run <plan.json> 显式指定了谁做，所以 demo 工人也放行（demo 项目/演示计划要用）
    const pool = liveRegistry({ all: flagOn('all'), includeDemo: true })
    const cwd = path.resolve(flagStr('cwd', process.cwd()))
    const parallel = Math.max(1, Number(flagStr('parallel', '3')))
    const retry = Number(flagStr('retry', '1'))
    const dryRun = flagOn('dry-run')
    const keep = flagOn('keep') || dryRun
    const repo = isRepo(cwd)
    const worktree = flagOn('no-worktree') ? false : repo
    const doMerge = !flagOn('no-merge')
    const base = flagStr('base', repo ? head(cwd) : '')
    // chat 模式：规划阶段就已经建好了占位目录（status=planning），这里复用它，前端就不会"发了消息没反应"
    const id = pre?.id || `run-${stamp()}`
    const dir = pre?.dir || path.join(RUNS, id)
    fs.mkdirSync(dir, { recursive: true })

    if (worktree) {
      if (!base || base === 'HEAD') { console.error('✗ 当前不是分支（detached HEAD），用 --base <branch> 指定'); process.exit(2) }
      if (head(cwd) !== base) { console.error(`✗ 主检出在 ${head(cwd)}，但 base=${base}；先切回 ${base}`); process.exit(2) }
      if (!git(cwd, ['rev-parse', '--verify', 'HEAD']).out) { console.error('✗ 仓库还没有提交，先 commit 一次'); process.exit(2) }
    }

    console.log(`▶ ${id}`)
    console.log(`  cwd=${cwd}  并行=${parallel}  worktree=${worktree ? `开（base=${base}）` : '关（共享目录）'}  merge=${doMerge && worktree ? '开' : '关'}${dryRun ? '  [dry-run]' : ''}`)
    const pm = plan.models || {}
    const pmText = Object.keys(pm).length ? Object.entries(pm).map(([k, v]) => `${k}=${v}`).join('  ') : '(跟随各客户端默认)'
    console.log(`  模型=${pmText}`)

    const ctx = { plan, dir, id, cwd, base, worktree, dryRun, keep, pool, handoffs: {}, results: new Map(), children: new Map(), control: { paused: false, stopped: false } }
    // 心跳：任务在跑但状态没变时也要刷新 updatedAt，否则中台会误判失联
    ctx.heartbeat = setInterval(() => setState(ctx, null, null, null), 5000)
    const byId = new Map(plan.tasks.map((t) => [t.id, t]))
    const ws = waves(plan.tasks)

    // 登记项目（中台左侧按项目文件夹分组用）
    try {
      const pf = path.join(RUNS, 'projects.json')
      const list = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, 'utf8')) : []
      if (!list.includes(cwd)) { list.push(cwd); fs.mkdirSync(RUNS, { recursive: true }); fs.writeFileSync(pf, JSON.stringify(list, null, 2)) }
    } catch { }

    // 初始化状态文件（中台读这个）。chat 模式下占位文件里可能有 plannerNote（规划回退原因），保留它。
    let prev = {}
    try { prev = JSON.parse(fs.readFileSync(statePath(ctx), 'utf8')) } catch { }
    const waveOf = new Map()
    waves(plan.tasks).forEach((w, i) => w.forEach((t) => waveOf.set(t.id, i + 1)))
    fs.writeFileSync(statePath(ctx), JSON.stringify({
      runId: id, cwd, base, planner: plan.planner, status: 'running', updatedAt: Date.now(),
      parallel, worktree: !!worktree, goal: plan.message || plan.goal || '',
      message: plan.message || '', plannerNote: prev.plannerNote || (plan.message ? plan.goal : ''),
      plannerModel: plan.plannerModel || '', plannerProvider: plan.plannerProvider || '', plannerMs: plan.plannerMs || 0,
      models: plan.models || {}, planning: false,
      tasks: plan.tasks.map((t) => {
        // 计划阶段就把"谁来做"定下来：待派的任务卡也能显示真实 agent 名，而不是"待派"
        const who = t.agent || resolve(t.role || '').agent?.id || null
        return {
          id: t.id, role: t.role, title: t.title, brief: t.brief || '', depends: t.depends || [], wave: waveOf.get(t.id) || 1,
          verifyCmd: t.verify || '', state: 'pending', agent: who, plannedAgent: who, branch: null, verify: null,
        }
      }),
    }, null, 2))

    // 中台控制通道：暂停 / 停止
    const stopWatch = watchControl(ctx,
      () => {
        if (ctx.control.paused) return
        ctx.control.paused = true
        const victims = [...ctx.children.entries()].map(([tid, v]) => `${v.agent}（${tid}）`)
        ctx.control.victims = victims
        for (const [, v] of ctx.children) killTree(v.child)
        const who = victims.length ? victims.join('、') : '当前没有正在运行的 agent（已停止派发新任务）'
        busMsg('yang', ['user'], `⏸ 已暂停：${who}`, { runId: id, kind: 'pause' })
        setState(ctx, '', 'paused')
        console.log(`\n⏸ 收到暂停指令，已中止：${who}`)
      },
      () => {
        ctx.control.stopped = true
        for (const [, v] of ctx.children) killTree(v.child)
        busMsg('yang', ['user'], '⏹ 已停止本 run', { runId: id, kind: 'stop' })
      },
    )

    const stopAll = (status, code) => {
      stopWatch()
      finalizeState(ctx, status)
      process.exit(code)
    }

    const runOne = async (task) => {
      if (ctx.control.paused || ctx.control.stopped) return { ok: false, reason: 'paused' }
      // 点名优先（LLM 规划或用户在计划里直接写了 agent），其次按 role 找 tag
      const { agent, how } = resolve(task.agent || task.role, pool)
      if (!agent) { console.error(`✗ ${task.id}: ${how}`); return { ok: false, reason: how } }
      let res
      for (let attempt = 0; attempt <= retry; attempt++) {
        const t = statePath(ctx)
        if (fs.existsSync(t)) {
          const cur = JSON.parse(fs.readFileSync(t, 'utf8'))
          const row = cur.tasks.find((x) => x.id === task.id)
          if (row) { row.branch = null; row.attempt = attempt + 1 }
          fs.writeFileSync(t, JSON.stringify(cur, null, 2))
        }
        res = await executeTask(task, agent, ctx)
        if (res.ok) break
        if (res.paused) break
        if (attempt < retry) console.log(`  ↻ 重试 ${attempt + 1}/${retry}`)
      }
      ctx.results.set(task.id, res)
      if (res.slot?.branch) {
        try {
          const cur = JSON.parse(fs.readFileSync(statePath(ctx), 'utf8'))
          const row = cur.tasks.find((x) => x.id === task.id)
          if (row) row.branch = res.slot.branch
          fs.writeFileSync(statePath(ctx), JSON.stringify(cur, null, 2))
        } catch { }
      }
      return res
    }

    for (let w = 0; w < ws.length; w++) {
      const wave = ws[w]
      if (ctx.control.paused || ctx.control.stopped) break
      console.log(`\n════ 第 ${w + 1} 波 · ${wave.length} 个任务${wave.length > 1 ? '（并行）' : ''} ════`)
      let cursor = 0
      const lane = async () => {
        while (cursor < wave.length) {
          if (ctx.control.paused || ctx.control.stopped) return
          const task = wave[cursor++]
          await runOne(task)
        }
      }
      await Promise.all(Array.from({ length: Math.min(parallel, wave.length) }, lane))

      if (ctx.control.paused || ctx.control.stopped) {
        const victims = ctx.control.victims || []
        fs.writeFileSync(path.join(dir, 'PAUSED.md'), [
          `# 已暂停 · 第 ${w + 1} 波`,
          `- 被暂停的 agent：${victims.join('、') || '（无运行中进程）'}`,
          `- 时间：${new Date().toLocaleString('zh-CN')}`,
          '',
          '## 恢复',
          `1. 处理完手头的事再继续：\`yang run ${path.basename(file)} --cwd "${cwd}"\``,
          '2. 或先看 runs 目录里的 handoff / agent.log。',
        ].join('\n'))
        console.log(`\n⏸ 已暂停。${victims.length ? `被中止的 agent：${victims.join('、')}` : '无运行中进程'}`)
        stopAll('paused', 5)
      }

      const failed = wave.filter((t) => !ctx.results.get(t.id)?.ok)
      if (failed.length) {
        fs.writeFileSync(path.join(dir, 'STOPPED.md'), [
          `# 停在第 ${w + 1} 波`,
          ...failed.map((t) => `- ${t.id}（${t.role} · ${ctx.results.get(t.id)?.reason || 'verify 未通过'}）`),
          '', `产见：${path.relative(ROOT, dir)}`,
        ].join('\n'))
        console.error(`\n✗ ${failed.map((t) => t.id).join(', ')} 未通过，停止后续波次（已通过的不会被合并）。`)
        finalizeState(ctx, 'failed'); process.exit(3)
      }

      if (doMerge && worktree) {
        for (const task of wave) {
          const m = mergeTask(task, ctx.results.get(task.id), ctx)
          if (!m.ok) {
            console.error(`\n✗ 合并冲突：${task.id}（${ctx.results.get(task.id).slot.branch}）`)
            console.error(`  冲突文件：\n${m.conflicts}`)
            console.error(`  详见 ${path.relative(ROOT, path.join(dir, 'CONFLICT.md'))}`)
            finalizeState(ctx, 'failed'); process.exit(4)
          }
        }
      }
    }

    const report = [
      `# ${id}`,
      `- 目标：${plan.goal}`,
      `- 规划器：${plan.planner}`,
      `- 并行度：${parallel}　worktree：${worktree ? `开（base=${base}）` : '关'}`,
      '',
      '| 任务 | 角色 | 工人 | 分支 | verify | 改动文件 |',
      '|---|---|---|---|---|---|',
      ...plan.tasks.map((t) => {
        const r = ctx.results.get(t.id) || {}
        return `| ${t.id} | ${t.role} | ${r.handoff?.agent || '-'} | ${r.slot?.branch || '-'} | ${r.verifyCode ?? '-'} | ${(r.handoff?.files || []).length} |`
      }),
      '', '## 波次',
      ...ws.map((w, i) => `- 第 ${i + 1} 波：${w.map((t) => t.id).join(' ∥ ')}`),
    ].join('\n')
    fs.writeFileSync(path.join(dir, 'REPORT.md'), report)

    stopWatch()
    finalizeState(ctx, 'done')
    busMsg('yang', ['user'], `✅ 全部任务完成：${plan.tasks.map((t) => t.id).join(' → ')}`, { runId: id, kind: 'done' })
    console.log(`\n✅ 全部通过。产物：${path.relative(ROOT, dir)}`)
    console.log(`   报告：${path.relative(ROOT, path.join(dir, 'REPORT.md'))}`)
  }

  case 'view':
    console.log('观察台：node orchestra/server.mjs --port=7788 → http://127.0.0.1:7788')
    console.log('   页面上方切「对话」看 agent 之间的消息，切「操作流」看每个 agent 干了什么。')
    break

  case 'say': {
    // 手工往总线里说一句：yang say "后端好了" --from backend-dsh --to frontend-codex
    const text = argv.slice(1).filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--from' && argv[argv.indexOf(a) - 1] !== '--to').join(' ')
    if (!text) { console.error('用法: yang say "<文本>" [--from a] [--to b,c]'); process.exit(1) }
    const from = flagStr('from', 'yang')
    const to = flagStr('to', 'all').split(',').map((s) => s.trim()).filter(Boolean)
    busMsg(from, to, text, { kind: 'say', runId: 'manual' })
    break
  }

  default:
    console.error(`未知命令 ${cmd}，试 yang help`)
    process.exit(1)
}
