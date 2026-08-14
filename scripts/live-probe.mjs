#!/usr/bin/env node

const baseHttp = process.env.DSH_HTTP_URL ?? 'http://127.0.0.1:13080'
const baseWs = baseHttp.replace(/^http/, 'ws')
const timeoutMs = Number(process.env.DSH_PROBE_TIMEOUT_MS ?? 300000)
const marker = `ADAPTIVE_REPORT_PROBE_${Date.now()}`

async function rpc(method, payload) {
  const response = await fetch(`${baseHttp}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `probe-${method}-${Date.now()}`,
      method,
      payload,
    }),
  })
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}`)
  const envelope = await response.json()
  if (!envelope?.result?.ok) {
    throw new Error(`${method} failed: ${JSON.stringify(envelope?.result?.error)}`)
  }
  return envelope.result.value
}

function open(path, onPayload) {
  const socket = new WebSocket(`${baseWs}/api/${path}`)
  socket.addEventListener('message', event => {
    const envelope = JSON.parse(String(event.data))
    onPayload(envelope.payload)
  })
  return socket
}

const { sessionId } = await rpc('session.create', {
  cwd: '/root/workspace',
  agentPreset: 'standard',
})
console.log(JSON.stringify({ phase: 'created', sessionId, marker }))

let sawRunning = false
let queuedReports = 0
let maxQueuedReports = 0
let contextReports = 0
let finished = false
const done = Promise.withResolvers()

const mux = open('events.mux', payload => {
  if (payload?.type !== 'session/queue' || payload.sessionId !== sessionId) return
  queuedReports = payload.items.filter(item => (
    item.placement === 'queued'
    && item.message?.source?.kind === 'subagent-report'
  )).length
  maxQueuedReports = Math.max(maxQueuedReports, queuedReports)
  contextReports = Math.max(contextReports, payload.items.filter(item => (
    item.placement === 'context'
    && item.message?.source?.kind === 'subagent-report'
  )).length)
  console.log(JSON.stringify({
    phase: 'queue',
    queuedReports,
    contextReports,
    total: payload.items.length,
  }))
})

const host = open('events.host', payload => {
  if (payload?.type !== 'host/session-status' || payload.sessionId !== sessionId) return
  console.log(JSON.stringify({ phase: 'status', running: payload.running }))
  if (payload.running) sawRunning = true
  else if (sawRunning && !finished) {
    finished = true
    done.resolve()
  }
})

const timer = setTimeout(() => done.reject(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs)

await rpc('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [{
    type: 'text',
    text: `Run this delivery probe exactly:\n1. Start one continuable background subagent. Ask it to immediately call report once with the exact marker ${marker}, then finish.\n2. Keep this same parent turn active until that report arrives. While waiting, perform sequential read-only tool calls against small local text files; do not finish the turn early.\n3. When you receive the Background subagent report containing the marker, answer with PROBE_RECEIVED and the marker. Do not create any additional subagents.`,
  }],
})

await done.promise
clearTimeout(timer)
mux.close()
host.close()

const history = await rpc('session.history', { sessionId, maxMessages: 20 })
let currentTurn
let reportTurn
let acknowledged = false
for (const row of history.events) {
  const event = row.event
  if (event.type === 'turn/start') currentTurn = event.data.turn
  if (event.type === 'user/message') {
    const text = event.data.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
    if (event.data.source?.kind === 'subagent-report' && text.includes(marker)) reportTurn = currentTurn
  }
  if (event.type === 'assistant/message') {
    const text = event.data.message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
    if (text.includes('PROBE_RECEIVED') && text.includes(marker)) acknowledged = true
  }
}

console.log(JSON.stringify({
  phase: 'result',
  sessionId,
  marker,
  queuedReports,
  maxQueuedReports,
  contextReports,
  reportTurn,
  acknowledged,
}))

if (maxQueuedReports !== 0) throw new Error(`queued subagent reports observed: ${maxQueuedReports}`)
if (reportTurn !== 1) throw new Error(`report was not consumed in parent turn 1: ${String(reportTurn)}`)
if (!acknowledged) throw new Error('parent did not acknowledge the report marker')
console.log('GREEN live DSH report stayed out of next-turn and was consumed in parent turn 1')
