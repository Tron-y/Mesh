#!/usr/bin/env node
/**
 * ingest — 把任何 CLI agent 的事件流灌进 orchestra 页面。
 *
 *   node orchestra/ingest.mjs --agent claude --cwd . -- claude -p "..." --output-format stream-json
 *   node orchestra/ingest.mjs --agent codex  --cwd . -- codex exec "..." --json
 *   node orchestra/ingest.mjs --agent mock   --say "后端完成"        # 手工打点
 *
 * 解析策略：stdout 按行读；能 JSON 解析的行按字段映射，不能解析的行当纯文本 "say"。
 */
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const argv = process.argv.slice(2)
const opt = (name, def = '') => { const i = argv.indexOf(`--${name}`); return i >= 0 ? (argv[i + 1] || '') : def }
const agent = opt('agent', 'external')
const cwd = opt('cwd', process.cwd())
const endpoint = opt('endpoint', 'http://127.0.0.1:7788/api/ingest')
const manualSay = opt('say', '')
const start = argv.indexOf('--')
const cmd = start >= 0 ? argv[start + 1] : ''
const args = start >= 0 ? argv.slice(start + 2) : []

async function emit(kind, payload = {}) {
  const ev = { agent, cwd, kind, time: Date.now(), ...payload }
  try {
    await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev) })
  } catch (e) { console.error('[ingest] 上报失败（server 没起？）:', e.message) }
}

if (manualSay) { await emit('say', { text: manualSay, summary: manualSay }); process.exit(0) }
if (!cmd) { console.error('用法: node orchestra/ingest.mjs --agent <name> --cwd <dir> -- <command> [args...]'); process.exit(1) }

await emit('say', { text: `▶ 启动 ${cmd} ${args.join(' ')}`, summary: `启动 ${cmd}` })

const child = spawn(cmd, args, { cwd, shell: true, env: process.env })
const rl = readline.createInterface({ input: child.stdout })
let pending = new Map()

rl.on('line', (line) => {
  const s = line.trim()
  if (!s) return
  let o = null
  try { o = JSON.parse(s) } catch { }

  if (!o) { emit('say', { text: s, summary: s.slice(0, 160) }); return }

  // Claude Code stream-json
  if (o.type === 'assistant' && o.message?.content) {
    for (const b of o.message.content) {
      if (b.type === 'text' && b.text?.trim()) emit('say', { text: b.text, summary: b.text.slice(0, 160) })
      if (b.type === 'tool_use') {
        emit('tool', { name: b.name, title: summarize(b.input), args: b.input, callId: b.id, summary: `${b.name} ${summarize(b.input)}` })
        pending.set(b.id, true)
      }
    }
    return
  }
  if (o.type === 'user' && o.message?.content) {
    for (const b of o.message.content) {
      if (b.type === 'tool_result') {
        emit('result', { callId: b.tool_use_id, text: textOf(b.content), isError: !!b.is_error, summary: '结果' })
      }
    }
    return
  }
  if (o.type === 'result') {
    emit('deliverable', { files: [], text: o.result || '', summary: `结束 · ${o.subtype || ''}` })
    return
  }
  // Codex exec --json
  if (o.msg || o.item) {
    const it = o.item || o
    const kind = it.type || o.type || 'event'
    const text = it.text || it.message || it.command || JSON.stringify(it).slice(0, 400)
    if (kind.includes('tool') || kind.includes('command') || kind.includes('exec')) {
      emit('tool', { name: kind, title: String(text).slice(0, 160), args: it, summary: String(text).slice(0, 160) })
    } else {
      emit('say', { text: String(text), summary: String(text).slice(0, 160) })
    }
    return
  }
  emit('say', { text: s.slice(0, 1000), summary: s.slice(0, 160) })
})

child.stderr.on('data', (d) => {
  const s = d.toString().trim()
  if (s) emit('result', { text: s.slice(0, 2000), isError: true, summary: 'stderr' })
})

child.on('close', async (code) => {
  await emit('result', { text: `退出码 ${code}`, isError: code !== 0, summary: `退出码 ${code}` })
  process.exit(0)
})

function summarize(input) {
  if (!input || typeof input !== 'object') return String(input || '').slice(0, 120)
  return String(input.file_path || input.command || input.pattern || input.description || JSON.stringify(input)).slice(0, 120)
}
function textOf(c) {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((x) => x.text || x.content || '').join('\n')
  return JSON.stringify(c || '')
}
