#!/usr/bin/env node
/**
 * orchestra — 一个页面看全部 agent。
 *
 * 数据源 1（零成本）：DSH 自己的会话日志 ~/.dsh/sessions/<project>/<session>/session.v*.jsonl.zstd
 *                     （多帧 zstd，按 magic 切帧解压）
 * 数据源 2（外部 agent）：POST /api/ingest 或 orchestra/ingest.mjs 上报的 runs/external.ndjson
 *
 * 零依赖，Node >= 22（需要 zlib.zstdDecompressSync）。
 *   node orchestra/server.mjs [--port 7788]
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import zlib from 'node:zlib'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SESSIONS = path.join(os.homedir(), '.dsh', 'sessions')
const ROOT = path.resolve(HERE, '..')
const RUNS = path.join(ROOT, 'runs')
const EXTERNAL = path.join(RUNS, 'external.ndjson')
const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '--port=7788').split('=')[1])

/* ── zstd 多帧解码 ─────────────────────────────────────────── */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decodeSession(file) {
  const buf = fs.readFileSync(file)
  const offs = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { offs.push(i); i += 4 }
  if (offs.length === 0) return buf.toString('utf8')
  const parts = []
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8')) } catch { /* 半帧 */ }
  }
  return parts.join('')
}

/* ── 项目目录名 → 路径 ─────────────────────────────────────── */
function projectPath(name) {
  const inner = name.replace(/^--/, '').replace(/--$/, '')
  const p = inner
    .replace(/~([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/-/g, '\\')
  return p.replace(/^([A-Za-z])\\/, '$1:\\')
}

/* ── 会话列表 + 缓存 ──────────────────────────────────────── */
const cache = new Map() // file -> {size, mtime, model}

function listSessionFiles() {
  const out = []
  let projects = []
  try { projects = fs.readdirSync(SESSIONS, { withFileTypes: true }) } catch { return out }
  for (const p of projects) {
    if (!p.isDirectory()) continue
    const pd = path.join(SESSIONS, p.name)
    for (const s of fs.readdirSync(pd, { withFileTypes: true })) {
      if (!s.isDirectory()) continue
      const sd = path.join(pd, s.name)
      let files = []
      try { files = fs.readdirSync(sd) } catch { continue }
      for (const f of files) {
        if (!f.startsWith('session.v') || !(f.endsWith('.jsonl') || f.endsWith('.jsonl.zstd'))) continue
        out.push({ project: p.name, session: s.name, file: path.join(sd, f) })
      }
    }
  }
  return out
}

const firstLine = (s) => s.split('\n', 1)[0]

function parseSession(file) {
  const st = fs.statSync(file)
  const hit = cache.get(file)
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.model
  const txt = decodeSession(file)
  const lines = txt.split('\n').filter(Boolean)
  let header = null
  const items = []
  const pending = new Map()
  let lastTodo = null
  const deliverables = []
  let lastTime = 0
  let errors = 0
  let turns = 0

  for (const line of lines) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    const t = e.time || 0
    if (t > lastTime) lastTime = t
    const d = e.data || {}
    switch (e.type) {
      case 'session':
        header = d
        break
      case 'user/message': {
        const text = texts(d.message)
        if (text) items.push({ seq: e.seq, time: t, kind: 'user', text: clip(text, 4000) })
        break
      }
      case 'assistant/message': {
        const text = texts(d.message)
        if (text) items.push({ seq: e.seq, time: t, kind: 'say', text: clip(text, 6000) })
        break
      }
      case 'tool/call': {
        let args = {}
        try { args = JSON.parse(d.arguments || '{}') } catch { args = { _raw: d.arguments } }
        const it = {
          seq: e.seq, time: t, kind: 'tool', name: d.name, callId: d.callId,
          title: toolTitle(d.name, args), args,
        }
        items.push(it)
        pending.set(d.callId, it)
        break
      }
      case 'tool/result': {
        const call = pending.get(d.toolCallId)
        const text = texts(d.message)
        if (call) {
          call.result = clip(text, 8000)
          call.isError = !!d.isError
          call.durationMs = t - call.time
        } else {
          items.push({ seq: e.seq, time: t, kind: 'result', text: clip(text, 4000), isError: !!d.isError })
        }
        if (d.isError) errors++
        break
      }
      case 'turn/start': turns++; break
      case 'todo/write':
        lastTodo = d.todos || []
        items.push({ seq: e.seq, time: t, kind: 'todo', todos: lastTodo })
        break
      case 'deliverables/presented':
        for (const f of d.files || []) deliverables.push({ path: f.path, description: f.description })
        items.push({ seq: e.seq, time: t, kind: 'deliverable', files: d.files || [] })
        break
      case 'workspace/changes':
        items.push({ seq: e.seq, time: t, kind: 'changes', turn: d.turn })
        break
      case 'approval/asked':
        items.push({ seq: e.seq, time: t, kind: 'approval', text: clip(texts(d) || JSON.stringify(d), 800) })
        break
    }
  }

  if (items.length > 2500) items.splice(0, items.length - 2500)

  const model = {
    id: path.basename(path.dirname(file)),
    file,
    cwd: header?.cwd || '',
    createdAt: header?.createdAt || 0,
    preset: header?.agentPreset || '',
    depth: header?.delegationDepth || 0,
    lastTime,
    items,
    todo: lastTodo,
    deliverables,
    errors,
    turns,
  }
  cache.set(file, { size: st.size, mtime: st.mtimeMs, model })
  return model
}

function texts(message) {
  if (!message) return ''
  const c = message.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c
    .filter((b) => b && (b.type === 'text' || b.type === 'reasoning') && b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `\n… (+${s.length - n} 字符)` : s || '')

function toolTitle(name, args) {
  const pick = (k) => (typeof args?.[k] === 'string' ? args[k] : '')
  switch (name) {
    case 'pwsh': case 'bash': return clip((pick('description') ? pick('description') + ' · ' : '') + pick('command').split('\n')[0], 160)
    case 'read': return pick('file_path')
    case 'write': return pick('file_path')
    case 'edit': return pick('file_path')
    case 'grep': return `${pick('pattern')}  @ ${pick('path') || '.'}`
    case 'glob': return pick('pattern')
    case 'subagent': case 'subagent_fork': return pick('description') || 'subagent'
    case 'workflow': return `${args?.meta?.name || 'workflow'}`
    case 'skill': return pick('name')
    case 'present': return (args?.files || []).map((f) => f.path).join(', ')
    default: {
      const s = JSON.stringify(args || {})
      return clip(s, 160)
    }
  }
}

/* ── 外部 agent 上报 ──────────────────────────────────────── */
function readExternal() {
  if (!fs.existsSync(EXTERNAL)) return []
  const out = []
  for (const line of fs.readFileSync(EXTERNAL, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
  }
  return out
}

/* ── 对话总线（agent 之间的消息） ─────────────────────── */
const BUSFILE = path.join(RUNS, 'bus.ndjson')

function readBus(limit = 400) {
  if (!fs.existsSync(BUSFILE)) return []
  const out = []
  for (const line of fs.readFileSync(BUSFILE, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
  }
  return out.slice(-limit)
}

/* ── 运行状态（中台控制面） ───────────────────────────── */
function listRuns() {
  const out = []
  if (!fs.existsSync(RUNS)) return out
  for (const name of fs.readdirSync(RUNS)) {
    const file = path.join(RUNS, name, 'state.json')
    if (!fs.existsSync(file)) continue
    try {
      const st = JSON.parse(fs.readFileSync(file, 'utf8'))
      st.runId = st.runId || name
      st.dir = path.join(RUNS, name)
      // 状态说 running 但 30 秒没心跳 → 视为失联（yang 进程被关掉了）
      st.stale = st.status === 'running' && Date.now() - (st.updatedAt || 0) > 30_000
      if (st.stale) st.status = 'stale'
      // 规划阶段没有心跳（yang 在等模型返回），给 3 分钟；超时说明它挂了，别让界面一直转圈
      if (st.status === 'planning' && Date.now() - (st.updatedAt || 0) > 180_000) {
        st.status = 'failed'
        st.planning = false
        st.plannerNote = st.plannerNote || '规划超时：yang 进程可能已退出，看 runs\\' + name + ' 下有没有输出'
      }
      out.push(st)
    } catch { /* 跳过坏文件 */ }
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

/* ── 项目 / 会话 ─────────────────────────────────────────── */
const PROJECTS = path.join(RUNS, 'projects.json')

function readProjects() {
  try { return JSON.parse(fs.readFileSync(PROJECTS, 'utf8')) } catch { return [] }
}
function addProject(cwd) {
  const list = readProjects()
  if (!list.includes(cwd)) {
    list.push(cwd)
    fs.mkdirSync(RUNS, { recursive: true })
    fs.writeFileSync(PROJECTS, JSON.stringify(list, null, 2))
  }
}

/** 项目 = cwd；会话 = 一次 run（同一项目可以有多次 run 并行或先后）。 */
function listProjects() {
  const runs = listRuns()
  const known = new Map()
  for (const cwd of readProjects()) known.set(cwd, [])
  for (const r of runs) {
    if (!known.has(r.cwd)) known.set(r.cwd, [])
    known.get(r.cwd).push(r)
  }
  return [...known.entries()].map(([cwd, sessions]) => ({
    cwd,
    name: cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd,
    sessions: sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
  }))
}

/* ── 模型清单（从两个客户端的本地配置读，默认值就是它们自己配的） ── */
function readDshModels() {
  const out = { provider: '', default: '', models: [], source: '' }
  try {
    const f = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
    if (!fs.existsSync(f)) return out
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/)
    const start = lines.findIndex((l) => /^-\s+id:\s*llm-pi-ai\s*$/.test(l))
    const ids = []
    if (start >= 0) {
      for (let i = start + 1; i < lines.length && !/^-\s+id:/.test(lines[i]); i++) {
        const m = lines[i].match(/^ {10}-\s+id:\s*([\w.\-+/]+)\s*$/)
        if (m) ids.push(m[1])
      }
    }
    const dStart = lines.findIndex((l) => /^-\s+id:\s*agent-default-model\s*$/.test(l))
    if (dStart >= 0) {
      const block = lines.slice(dStart, dStart + 8).join('\n')
      out.provider = (block.match(/provider:\s*([\w.-]+)/) || [])[1] || ''
      out.default = (block.match(/model:\s*([\w.\-+/]+)/) || [])[1] || ''
    }
    out.models = [...new Set([out.default, ...ids].filter(Boolean))]
    out.source = '~/.dsh/profiles/desktop/cordis.patch.yml'
  } catch { }
  return out
}

/**
 * 调度（拆活）默认用哪个模型。
 * 拆活只是"把你的话翻成任务清单"，不需要最强模型：flash 实测 5 秒，pro 要 77 秒。
 * 所以默认挑 flash；dsh 没配 flash 就退回桌面端默认模型。
 */
function plannerDefault() {
  const d = readDshModels()
  const has = (m) => (d.models || []).includes(m)
  if (has('deepseek-flash')) return 'deepseek-flash'
  return d.default || ''
}

function readCodexModel() {
  const out = { default: '', models: [], baseUrl: '', source: '' }
  try {
    const f = path.join(os.homedir(), '.codex', 'config.toml')
    if (!fs.existsSync(f)) return out
    const text = fs.readFileSync(f, 'utf8')
    out.default = (text.match(/^\s*model\s*=\s*"([^"]+)"/m) || [])[1] || ''
    out.baseUrl = (text.match(/^\s*base_url\s*=\s*"([^"]+)"/m) || [])[1] || ''
    out.models = [...new Set([out.default, ...[...text.matchAll(/^\s*model\s*=\s*"([^"]+)"/gm)].map((m) => m[1])].filter(Boolean))]
    out.source = '~/.codex/config.toml'
  } catch { }
  return out
}

/* ── 汇总 ────────────────────────────────────────────────── */
function buildAgents() {
  const now = Date.now()
  const agents = []
  for (const { project, session, file } of listSessionFiles()) {
    let model
    try { model = parseSession(file) } catch { continue }
    const st = fs.statSync(file)
    if (model.items.length === 0 && !model.cwd) continue
    const tools = model.items.filter((i) => i.kind === 'tool')
    const msgs = model.items.filter((i) => i.kind === 'say')
    const last = model.items[model.items.length - 1]
    const alive = now - Math.max(st.mtimeMs, model.lastTime) < 120_000
    agents.push({
      id: model.id,
      kind: 'dsh',
      project,
      projectPath: projectPath(project),
      cwd: model.cwd,
      preset: model.preset,
      depth: model.depth,
      status: alive ? 'running' : 'idle',
      lastTime: model.lastTime,
      counts: { tools: tools.length, says: msgs.length, errors: model.errors, turns: model.turns },
      todo: model.todo ? {
        total: model.todo.length,
        done: model.todo.filter((x) => x.status === 'completed').length,
        current: model.todo.find((x) => x.status === 'in_progress')?.content || '',
      } : null,
      deliverables: model.deliverables.slice(-8),
      lastAction: last ? (last.kind === 'tool' ? `${last.name}: ${last.title}` : last.kind) : '',
      sizeBytes: st.size,
    })
  }

  // 外部 agent（codex / claude / 其它 CLI）
  const ext = new Map()
  for (const ev of readExternal()) {
    const a = ext.get(ev.agent) || { name: ev.agent, lastTime: 0, events: [], cwd: ev.cwd || '' }
    a.events.push(ev)
    a.lastTime = Math.max(a.lastTime, ev.time || 0)
    ext.set(ev.agent, a)
  }
  for (const a of ext.values()) {
    agents.push({
      id: `ext:${a.name}`,
      kind: 'external',
      project: 'external',
      projectPath: a.cwd,
      cwd: a.cwd,
      preset: a.name,
      depth: 0,
      status: now - a.lastTime < 120_000 ? 'running' : 'idle',
      lastTime: a.lastTime,
      counts: { tools: a.events.filter((e) => e.kind === 'tool').length, says: a.events.filter((e) => e.kind === 'say').length, errors: a.events.filter((e) => e.isError).length, turns: 0 },
      todo: null,
      deliverables: [],
      lastAction: a.events.at(-1)?.summary || '',
      sizeBytes: 0,
    })
  }
  agents.sort((x, y) => y.lastTime - x.lastTime)
  return { now, agents }
}

function buildEvents(id, limit) {
  if (id.startsWith('ext:')) {
    const name = id.slice(4)
    return readExternal().filter((e) => e.agent === name).slice(-limit)
  }
  const entry = listSessionFiles().find((f) => f.session === id)
  if (!entry) return []
  return parseSession(entry.file).items.slice(-limit)
}

/* ── HTTP ───────────────────────────────────────────────── */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)) }

  try {
    if (url.pathname === '/api/agents') return json(buildAgents())
    if (url.pathname === '/api/events') {
      const id = url.searchParams.get('id') || ''
      const limit = Math.min(Number(url.searchParams.get('limit') || 300), 2000)
      const items = buildEvents(id, limit)
      return json({ id, items })
    }
    if (url.pathname === '/api/chat') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 400), 2000)
      const runId = url.searchParams.get('runId') || ''
      let messages = readBus(limit)
      if (runId) messages = readBus(2000).filter((m) => !m.runId || m.runId === runId || m.runId === 'manual')
      return json({ messages, count: messages.length })
    }
    if (url.pathname === '/api/log') {
      const run = url.searchParams.get('run') || ''
      const task = url.searchParams.get('task') || ''
      const tailN = Math.min(Number(url.searchParams.get('tail') || 60), 500)
      if (!/^[\w.-]+$/.test(run) || !/^[\w.-]+$/.test(task)) return json({ ok: false, error: 'bad params' }, 400)
      const dir = path.join(RUNS, run, task)
      let file = path.join(dir, 'live.log')
      if (!fs.existsSync(file)) file = path.join(dir, 'agent.log')
      if (!fs.existsSync(file)) return json({ ok: true, text: '', file: null })
      const raw = fs.readFileSync(file, 'utf8')
      const lines = raw.split('\n')
      return json({ ok: true, text: lines.slice(-tailN).join('\n'), file: path.basename(file), size: raw.length })
    }
    if (url.pathname === '/api/runs') {
      return json({ runs: listRuns() })
    }
    if (url.pathname === '/api/models') {
      return json({ dsh: readDshModels(), codex: readCodexModel(), plannerDefault: plannerDefault() })
    }    if (url.pathname === '/api/projects') {
      return json({ projects: listProjects() })
    }
    // 环境检查：问 yang 自己，每个 agent 的 CLI 认没认到（换机器/装了新 CLI 后点一下就知道）
    if (url.pathname === '/api/doctor') {
      const yang = path.resolve(ROOT, 'yang-harness', 'yang.mjs')
      const r = spawnSync(process.execPath, [yang, 'doctor', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true })
      try {
        return json(JSON.parse(r.stdout || '{}'))
      } catch {
        return json({ ok: 0, bad: [], agents: [], error: (r.stderr || r.stdout || 'doctor 跑不起来').slice(0, 400) }, 500)
      }
    }
    // 打开系统「选择文件夹」对话框（服务器在本机，弹的是用户桌面上的窗口）
    if (url.pathname === '/api/pick-folder' && req.method === 'POST') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$d.Description = "选择项目文件夹"',
        '$d.ShowNewFolderButton = $true',
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
      ].join('; ')
      const r = spawnSync('powershell', ['-NoProfile', '-STA', '-Command', ps], { encoding: 'utf8', timeout: 240000, windowsHide: true })
      const picked = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
      return json({ ok: !!picked, path: picked, error: picked ? '' : String(r.stderr || '已取消').slice(-200) })
    }

    // 建项目 + 建一个「待命」会话（先不派活，等你在会话里说要干什么）
    if (url.pathname === '/api/project' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try {
          const { cwd, desc, models } = JSON.parse(body)
          if (!cwd || !fs.existsSync(cwd)) return json({ ok: false, error: '项目目录不存在' }, 400)
          addProject(cwd)
          const dir = path.join(RUNS, 'idle-' + Date.now())
          fs.mkdirSync(dir, { recursive: true })
          const st = {
            runId: path.basename(dir), cwd, status: 'idle', updatedAt: Date.now(),
            goal: '', desc: (desc || '').trim(), models: models || {},
            planner: null, tasks: [], idle: true,
          }
          fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st, null, 2))
          json({ ok: true, runId: st.runId })
        } catch (e) { json({ ok: false, error: String(e) }, 400) }
      })
      return
    }

    // 发一条消息就开工：yang chat "<消息>" --cwd <dir> [--models dsh=a,codex=b] [--parallel n] [--no-worktree]
    // 规划（LLM 按话里的分工拆活）+ 执行都在子进程里做；这里只负责拉起来并立刻返回 runId。
    // 兼容旧字段：goal ≡ message，desc 忽略。
    if (url.pathname === '/api/session' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try {
          const { cwd, message, goal, models, parallel, worktree, planner, mode, with: withWho, rounds } = JSON.parse(body)
          const text = String(message || goal || '').trim()
          if (!cwd || !fs.existsSync(cwd)) return json({ ok: false, error: '项目目录不存在' }, 400)
          if (!text) return json({ ok: false, error: '消息不能为空' }, 400)
          addProject(cwd)
          const yang = path.resolve(ROOT, 'yang-harness', 'yang.mjs')
          // 圆桌模式：几个 agent 对同一件事直接对话，没有人在中间转述
          if (mode === 'talk') {
            const args = [yang, 'talk', text, '--cwd', cwd]
            const w = String(withWho || '').split(',').map((s) => s.trim()).filter(Boolean)
            if (w.length) args.push('--with', w.join(','))
            args.push('--rounds', String(Math.min(Math.max(Number(rounds) || 2, 1), 4)))
            const m2 = []
            for (const k of ['dsh', 'codex', 'claude', 'cursor', 'opencode', 'gemini']) {
              if (models && models[k]) m2.push(`${k}=${String(models[k])}`)
            }
            if (m2.length) args.push('--models', m2.join(','))
            const child = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true })
            child.unref()
            return json({ ok: true, pid: child.pid, mode: 'talk' })
          }
          const args = [yang, 'chat', text, '--cwd', cwd]
          if (planner === 'rule' || planner === 'llm') args.push('--planner', planner)
          const m = []
          // 调度模型：没指定就用默认（flash，快）；它只负责"拆活"，和工人模型互不影响
          m.push(`planner=${(models && models.planner) || plannerDefault()}`)
          // 工人模型：留空表示跟随各客户端自己的默认
          for (const k of ['dsh', 'codex', 'claude', 'cursor', 'opencode', 'gemini']) {
            if (models && models[k]) m.push(`${k}=${String(models[k])}`)
          }
          if (m.length) args.push('--models', m.join(','))
          args.push('--parallel', String(Math.min(Math.max(Number(parallel) || 3, 1), 6)))
          args.push(worktree ? '--worktree' : '--no-worktree')
          const child = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true })
          child.unref()
          json({ ok: true, pid: child.pid })
        } catch (e) { json({ ok: false, error: String(e) }, 500) }
      })
      return
    }
    if (url.pathname === '/api/control' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try {
          const { runId, cmd: action } = JSON.parse(body)
          if (!runId || !['pause', 'stop', 'resume'].includes(action)) return json({ ok: false, error: 'runId 与 cmd(pause|stop|resume) 必填' }, 400)
          const dir = path.join(RUNS, runId)
          if (!fs.existsSync(dir)) return json({ ok: false, error: `没有这个 run: ${runId}` }, 404)
          fs.appendFileSync(path.join(dir, 'control.ndjson'), JSON.stringify({ cmd: action, time: Date.now() }) + '\n')
          json({ ok: true, runId, cmd: action })
        } catch (e) { json({ ok: false, error: String(e) }, 400) }
      })
      return
    }
    if (url.pathname === '/api/msg' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try {
          const m = JSON.parse(body)
          const rec = { time: m.time || Date.now(), from: m.from || 'external', to: Array.isArray(m.to) ? m.to : [m.to || 'all'], text: String(m.text || ''), kind: m.kind || 'say' }
          fs.mkdirSync(RUNS, { recursive: true })
          fs.appendFileSync(BUSFILE, JSON.stringify(rec) + '\n')
          json({ ok: true })
        } catch (e) { json({ ok: false, error: String(e) }, 400) }
      })
      return
    }
    if (url.pathname === '/api/ingest' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try {
          const ev = JSON.parse(body)
          ev.time = ev.time || Date.now()
          fs.mkdirSync(RUNS, { recursive: true })
          fs.appendFileSync(EXTERNAL, JSON.stringify(ev) + '\n')
          json({ ok: true })
        } catch (e) { json({ ok: false, error: String(e) }, 400) }
      })
      return
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(HERE, 'index.html'))
      res.writeHead(200, { 'content-type': MIME['.html'] }); return res.end(html)
    }
    // 工作流画布（草稿页）：拖节点连依赖，直接把图变成计划
    if (url.pathname === '/workflow' || url.pathname === '/workflow.html') {
      const file = path.join(HERE, 'workflow.html')
      if (!fs.existsSync(file)) return json({ error: 'workflow.html 不存在' }, 404)
      const html = fs.readFileSync(file)
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }); return res.end(html)
    }
    json({ error: 'not found' }, 404)
  } catch (e) {
    json({ error: String(e && e.stack || e) }, 500)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`orchestra → http://127.0.0.1:${PORT}`)
  console.log(`sessions: ${SESSIONS}`)
  logLine(`orchestra start pid=${process.pid} port=${PORT}`)
})

/** 自己的日志：启动脚本用 Start-Process -WindowStyle Hidden 拉起时没有控制台，出错得有个地方看。 */
function logLine(line) {
  try {
    fs.mkdirSync(RUNS, { recursive: true })
    fs.appendFileSync(path.join(RUNS, 'server.log'), `[${new Date().toISOString()}] ${line}\n`)
  } catch { /* 日志失败不影响服务 */ }
}
process.on('uncaughtException', (e) => logLine(`uncaughtException: ${e && e.stack || e}`))
process.on('unhandledRejection', (e) => logLine(`unhandledRejection: ${e && e.stack || e}`))

server.on('error', (e) => {
  logLine(`listen error: ${e && e.stack || e}`)
  console.error(`✗ 端口 ${PORT} 启动失败：${e.message}`)
  process.exit(1)
})
