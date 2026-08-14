#!/usr/bin/env node

const baseHttp = process.env.DSH_HTTP_URL ?? 'http://127.0.0.1:13080'
const baseWs = baseHttp.replace(/^http/, 'ws')
const timeoutMs = Number(process.env.DSH_PROBE_TIMEOUT_MS ?? 300000)

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

function openEventSocket(eventPath, onPayload) {
  const socket = new WebSocket(`${baseWs}/api/${eventPath}`)
  socket.addEventListener('message', event => {
    const envelope = JSON.parse(String(event.data))
    onPayload(envelope.payload)
  })
  return socket
}

function textContent(blocks) {
  return blocks?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
}

async function runScenario({ name, marker, expectedTurns, prompt }) {
  const { sessionId } = await rpc('session.create', {
    cwd: '/root/workspace',
    agentPreset: 'standard',
  })
  console.log(JSON.stringify({ phase: 'created', name, sessionId, marker }))

  let running = false
  let completedTurns = 0
  let queuedReports = 0
  let maxQueuedReports = 0
  let maxContextReports = 0
  const done = Promise.withResolvers()

  const mux = openEventSocket('events.mux', payload => {
    if (payload?.type !== 'session/queue' || payload.sessionId !== sessionId) return
    queuedReports = payload.items.filter(item => (
      item.placement === 'queued'
      && item.message?.source?.kind === 'subagent-report'
    )).length
    maxQueuedReports = Math.max(maxQueuedReports, queuedReports)
    maxContextReports = Math.max(maxContextReports, payload.items.filter(item => (
      item.placement === 'context'
      && item.message?.source?.kind === 'subagent-report'
    )).length)
    console.log(JSON.stringify({
      phase: 'queue',
      name,
      queuedReports,
      maxQueuedReports,
      maxContextReports,
      total: payload.items.length,
    }))
  })

  const host = openEventSocket('events.host', payload => {
    if (payload?.type !== 'host/session-status' || payload.sessionId !== sessionId) return
    console.log(JSON.stringify({ phase: 'status', name, running: payload.running }))
    if (payload.running) running = true
    else if (running) {
      running = false
      completedTurns += 1
      if (completedTurns >= expectedTurns) done.resolve()
    }
  })

  const timer = setTimeout(
    () => done.reject(new Error(`${name} probe timed out after ${timeoutMs}ms`)),
    timeoutMs,
  )

  await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: prompt }],
  })

  await done.promise
  clearTimeout(timer)
  mux.close()
  host.close()

  const history = await rpc('session.history', { sessionId, maxMessages: 50 })
  let currentTurn
  const reportTurns = []
  let acknowledged = false
  for (const row of history.events) {
    const event = row.event
    if (event.type === 'turn/start') currentTurn = event.data.turn
    if (event.type === 'user/message') {
      const text = textContent(event.data.content)
      if (event.data.source?.kind === 'subagent-report' && text.includes(marker)) {
        reportTurns.push(currentTurn)
      }
    }
    if (event.type === 'assistant/message') {
      const text = textContent(event.data.message?.content)
      if (text.includes('PROBE_RECEIVED') && text.includes(marker)) acknowledged = true
    }
  }

  const result = {
    name,
    sessionId,
    marker,
    completedTurns,
    maxQueuedReports,
    maxContextReports,
    reportTurns,
    acknowledged,
  }
  console.log(JSON.stringify({ phase: 'result', ...result }))
  return result
}

const runningMarker = `ADAPTIVE_RUNNING_REPORT_${Date.now()}`
const running = await runScenario({
  name: 'running-parent',
  marker: runningMarker,
  expectedTurns: 1,
  prompt: `Run this delivery probe exactly:\n1. Start one continuable background subagent. Ask it to immediately call report once with the exact marker ${runningMarker}, then finish.\n2. Keep this same parent turn active until that report arrives. While waiting, perform sequential read-only tool calls against small local text files; do not finish the turn early.\n3. When you receive the Background subagent report containing the marker, answer with PROBE_RECEIVED and the marker. Do not create any additional subagents.`,
})

if (running.maxQueuedReports !== 0) {
  throw new Error(`running parent queued ${running.maxQueuedReports} subagent report(s)`)
}
if (running.maxContextReports < 1) {
  throw new Error('running parent never exposed the report as next-step context')
}
if (running.reportTurns.length !== 1 || running.reportTurns[0] !== 1) {
  throw new Error(`running report was not inserted once in turn 1: ${running.reportTurns}`)
}
if (!running.acknowledged) throw new Error('running parent did not acknowledge the marker')

const idleMarker = `ADAPTIVE_IDLE_REPORT_${Date.now()}`
const idle = await runScenario({
  name: 'idle-parent',
  marker: idleMarker,
  expectedTurns: 2,
  prompt: `Run this idle-parent delivery probe exactly:\n1. Start one continuable background subagent. Ask it to wait at least 8 seconds using a tool, then call report once with the exact marker ${idleMarker}, then finish.\n2. End this parent turn immediately after the subagent starts; do not wait for its report. Answer PARENT_IDLE.\n3. When the later Background subagent report wakes you, answer with PROBE_RECEIVED and the marker. Do not create any additional subagents.`,
})

if (idle.completedTurns !== 2) {
  throw new Error(`idle parent completed an unexpected number of turns: ${idle.completedTurns}`)
}
if (idle.reportTurns.length !== 1 || idle.reportTurns[0] !== 2) {
  throw new Error(`idle report was not inserted once in wakeup turn 2: ${idle.reportTurns}`)
}
if (!idle.acknowledged) throw new Error('idle parent did not acknowledge the marker')

console.log('GREEN live DSH AgentLoop probe: running report used context and idle report woke turn 2')
