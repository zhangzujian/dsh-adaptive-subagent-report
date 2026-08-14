#!/usr/bin/env node

import { createProbeTransport } from './live-probe-transport.mjs'

const { openEventSocket, rpc, timeoutMs } = createProbeTransport({
  defaultTimeoutMs: 180000,
  rpcPrefix: 'cancel-probe',
})
const marker = `ADAPTIVE_CANCEL_REPORT_${Date.now()}`

const { sessionId } = await rpc('session.create', {
  cwd: '/root/workspace',
  agentPreset: 'standard',
})
console.log(JSON.stringify({ phase: 'created', sessionId, marker }))

let cancellationRequested = false
let stoppedAfterCancellation = false
let resumedAfterCancellation = false
let contextReports = 0
let contextSettlements = 0
let graceTimer
const done = Promise.withResolvers()
const maybeArmGrace = () => {
  if (stoppedAfterCancellation && contextSettlements > 0 && graceTimer === undefined) {
    graceTimer = setTimeout(() => done.resolve(), 3000)
  }
}

const mux = openEventSocket('events.mux', payload => {
  if (payload?.type !== 'session/queue' || payload.sessionId !== sessionId) return
  contextReports = Math.max(contextReports, payload.items.filter(item => (
    item.placement === 'context'
    && item.message?.source?.kind === 'subagent-report'
  )).length)
  contextSettlements = Math.max(contextSettlements, payload.items.filter(item => (
    item.placement === 'context'
    && item.message?.source?.kind === 'subagent-settled'
  )).length)
  console.log(JSON.stringify({
    phase: 'queue',
    contextReports,
    contextSettlements,
    total: payload.items.length,
    sources: payload.items.map(item => item.message?.source?.kind),
  }))
  if (contextReports > 0 && !cancellationRequested) {
    cancellationRequested = true
    void rpc('session.cancel', { sessionId }).then(value => {
      console.log(JSON.stringify({ phase: 'cancel-accepted', value }))
    }, done.reject)
  }
  maybeArmGrace()
})

const host = openEventSocket('events.host', payload => {
  if (payload?.type !== 'host/session-status' || payload.sessionId !== sessionId) return
  console.log(JSON.stringify({ phase: 'status', running: payload.running }))
  if (!cancellationRequested) return
  if (payload.running && stoppedAfterCancellation) {
    resumedAfterCancellation = true
    done.reject(new Error('session resumed after explicit user cancellation'))
    return
  }
  if (!payload.running && !stoppedAfterCancellation) {
    stoppedAfterCancellation = true
    maybeArmGrace()
  }
})

const timeout = setTimeout(
  () => done.reject(new Error(`cancel probe timed out after ${timeoutMs}ms`)),
  timeoutMs,
)

await rpc('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [{
    type: 'text',
    text: `Run this cancellation probe exactly:\n1. Start one continuable background subagent. Ask it to wait 2 seconds using a tool, call report once with the exact marker ${marker}, remain alive by sleeping for 5 more seconds, then finish.\n2. Immediately after starting it, run a foreground bash tool command that sleeps for 30 seconds. Do not finish the parent turn before that tool returns.\n3. Do not create any additional subagents.`,
  }],
})

await done.promise
clearTimeout(timeout)
clearTimeout(graceTimer)
mux.close()
host.close()

console.log(JSON.stringify({
  phase: 'result',
  sessionId,
  marker,
  cancellationRequested,
  stoppedAfterCancellation,
  resumedAfterCancellation,
  contextReports,
  contextSettlements,
}))

if (!cancellationRequested) throw new Error('probe never observed pending report context')
if (!stoppedAfterCancellation) throw new Error('session did not stop after cancellation')
if (contextSettlements === 0) throw new Error('probe never observed retained settlement context')
if (resumedAfterCancellation) throw new Error('session resumed after cancellation')
console.log('GREEN user cancellation retained report and settlement context without restart')
