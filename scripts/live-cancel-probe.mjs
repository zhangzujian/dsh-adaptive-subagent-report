#!/usr/bin/env node

import {
  completedTurns,
  createProbeTransport,
  textContent,
  userMessagesWithOpenTurn,
} from './live-probe-transport.mjs'

const { rpc, timeoutMs, watchSession } = createProbeTransport({
  defaultTimeoutMs: 180000,
  rpcPrefix: 'cancel-probe',
})
const marker = `ADAPTIVE_CANCEL_REPORT_${Date.now()}`
const recoveryPrompt = `This is an explicit later user prompt. Claim the retained subagent report and settlement now. Reply with CANCEL_PROBE_RESUMED and the exact marker ${marker}. Do not create any subagents.`

const { sessionId } = await rpc('session.create', {
  cwd: '/root/workspace',
  agentPreset: 'standard',
})
console.log(JSON.stringify({ phase: 'created', sessionId, marker }))

const stableStoppedMs = Number(process.env.DSH_CANCEL_STABLE_STOP_MS ?? 1500)
if (!Number.isFinite(stableStoppedMs) || stableStoppedMs <= 0) {
  throw new Error('DSH_CANCEL_STABLE_STOP_MS must be a positive finite duration')
}
let recoveryPhase = 'initial-run'
let recoveryRunPhase = 'unseen'
let failureKind
let stabilityBoundaryTurn
let recoveryBoundaryTurn
let correlatedRecoveryTurn
let reportChildId
let contextReports = 0
let contextSettlements = 0
let stableStopTimer
let graceTimer
const done = Promise.withResolvers()

const recoveryWasAccepted = () => (
  ['prompt-accepted', 'correlating', 'grace', 'passed'].includes(recoveryPhase)
)
const recoveryRunEnded = () => (
  recoveryRunPhase === 'ended' || recoveryRunPhase === 'running-after-end'
)
const fail = (kind, error) => {
  if (failureKind !== undefined) return
  failureKind = kind
  done.reject(error)
}

function recoveryPromptTurnIn(history) {
  for (const { event, turn } of userMessagesWithOpenTurn(history.events)) {
    if (event.data.source?.kind === 'user' && textContent(event.data.content) === recoveryPrompt) {
      return turn
    }
  }
}

async function correlateCompletedRecoveryRun() {
  if (recoveryPhase !== 'prompt-accepted' || !recoveryRunEnded()) return
  recoveryPhase = 'correlating'
  try {
    const history = await rpc('session.history', { sessionId, maxMessages: 50 })
    const endedAfterBoundary = history.events
      .filter(row => row.event.type === 'turn/end' && row.event.data.turn > recoveryBoundaryTurn)
      .map(row => row.event.data.turn)
    const completedCandidateTurn = endedAfterBoundary[0]
    const promptTurn = recoveryPromptTurnIn(history)
    if (!Number.isSafeInteger(completedCandidateTurn) || promptTurn !== completedCandidateTurn) {
      fail('prompt-race', new Error(`running turn raced recovery prompt acceptance: candidate=${completedCandidateTurn}, prompt=${promptTurn}`))
      return
    }
    correlatedRecoveryTurn = promptTurn
    recoveryPhase = 'grace'
    graceTimer = setTimeout(() => {
      recoveryPhase = 'passed'
      done.resolve()
    }, 3000)
  } catch (error) {
    fail('correlation-error', error)
  }
}

async function requestRecoveryAfterStableStop() {
  if (recoveryPhase !== 'capturing-boundary') return
  try {
    const boundaryHistory = await rpc('session.history', { sessionId, maxMessages: 50 })
    if (recoveryPhase !== 'capturing-boundary' || failureKind !== undefined) return
    recoveryBoundaryTurn = Math.max(0, ...completedTurns(boundaryHistory.events))
    if (recoveryBoundaryTurn !== stabilityBoundaryTurn) {
      fail('unexpected-resume', new Error(`completed turn boundary changed during stability interval: before=${stabilityBoundaryTurn}, after=${recoveryBoundaryTurn}`))
      return
    }
    console.log(JSON.stringify({
      phase: 'stable-stopped',
      stableStoppedMs,
      recoveryBoundaryTurn,
    }))
    recoveryPhase = 'prompt-submitting'
    const value = await rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{
        type: 'text',
        text: recoveryPrompt,
      }],
    })
    if (recoveryPhase === 'prompt-submitting') recoveryPhase = 'prompt-accepted'
    console.log(JSON.stringify({ phase: 'recovery-prompt-accepted', value }))
    await correlateCompletedRecoveryRun()
  } catch (error) {
    fail('rpc-error', error)
  }
}

async function beginStabilityWindow() {
  try {
    const history = await rpc('session.history', { sessionId, maxMessages: 50 })
    if (recoveryPhase !== 'capturing-stability-boundary' || failureKind !== undefined) return
    stabilityBoundaryTurn = Math.max(0, ...completedTurns(history.events))
    recoveryPhase = 'stability-window'
    stableStopTimer = setTimeout(() => {
      if (recoveryPhase !== 'stability-window') return
      recoveryPhase = 'capturing-boundary'
      void requestRecoveryAfterStableStop()
    }, stableStoppedMs)
  } catch (error) {
    fail('rpc-error', error)
  }
}

const maybeRequestRecovery = () => {
  if (recoveryPhase !== 'stopped-waiting-settlement'
    || contextSettlements === 0
    || failureKind !== undefined) return
  recoveryPhase = 'capturing-stability-boundary'
  void beginStabilityWindow()
}

const events = watchSession(sessionId, {
  onQueue: (payload) => {
    const matchingReports = payload.items.filter(item => (
      item.placement === 'context'
      && item.message?.source?.kind === 'subagent-report'
      && textContent(item.message.content).includes(marker)
    ))
    const matchingChildIds = new Set(matchingReports.map(item => item.message.source.senderSessionId))
    if (matchingChildIds.size > 1) {
      fail('identity-error', new Error('marker-bearing reports came from multiple subagents'))
      return
    }
    const [observedChildId] = matchingChildIds
    if (observedChildId !== undefined) {
      if (reportChildId !== undefined && reportChildId !== observedChildId) {
        fail('identity-error', new Error('marker-bearing report changed subagent identity'))
        return
      }
      reportChildId = observedChildId
    }
    contextReports = Math.max(contextReports, matchingReports.length)
    contextSettlements = Math.max(contextSettlements, payload.items.filter(item => (
      item.placement === 'context'
      && item.message?.source?.kind === 'subagent-settled'
      && item.message.source.senderSessionId === reportChildId
    )).length)
    console.log(JSON.stringify({
      phase: 'queue',
      contextReports,
      contextSettlements,
      total: payload.items.length,
      sources: payload.items.map(item => item.message?.source?.kind),
    }))
    if (contextReports > 0 && recoveryPhase === 'initial-run') {
      recoveryPhase = 'cancel-dispatched'
      void rpc('session.cancel', { sessionId }).then(value => {
        console.log(JSON.stringify({ phase: 'cancel-accepted', value }))
      }, error => fail('rpc-error', error))
    }
    maybeRequestRecovery()
  },
  onStatus: (payload) => {
    console.log(JSON.stringify({ phase: 'status', running: payload.running }))
    if (recoveryPhase === 'initial-run' || failureKind !== undefined) return
    if (payload.running) {
      if (['stopped-waiting-settlement', 'capturing-stability-boundary', 'stability-window', 'capturing-boundary', 'grace'].includes(recoveryPhase)) {
        fail('unexpected-resume', new Error('session resumed before an accepted explicit recovery prompt'))
        return
      }
      if (['prompt-submitting', 'prompt-accepted', 'correlating'].includes(recoveryPhase)) {
        recoveryRunPhase = recoveryRunEnded() ? 'running-after-end' : 'running'
      }
      return
    }
    if (recoveryPhase === 'cancel-dispatched') {
      recoveryPhase = 'stopped-waiting-settlement'
      maybeRequestRecovery()
      return
    }
    if (recoveryRunPhase === 'running' || recoveryRunPhase === 'running-after-end') {
      recoveryRunPhase = 'ended'
      void correlateCompletedRecoveryRun()
    }
  },
})

const timeout = setTimeout(
  () => fail('timeout', new Error(`cancel probe timed out after ${timeoutMs}ms`)),
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
clearTimeout(stableStopTimer)
clearTimeout(graceTimer)
events.close()

const history = await rpc('session.history', { sessionId, maxMessages: 50 })
let claimedReports = 0
let claimedSettlements = 0
let recoveryPromptTurn
const turnStartIndices = new Map(history.events.flatMap((row, index) => (
  row.event.type === 'turn/start' ? [[row.event.data.turn, index]] : []
)))
const reportClaims = []
const settlementClaims = []
for (const { event, index, turn } of userMessagesWithOpenTurn(history.events)) {
  const text = textContent(event.data.content)
  if (event.data.source?.kind === 'user' && text === recoveryPrompt) {
    recoveryPromptTurn = turn
  }
  if (event.data.source?.kind === 'subagent-report' && text.includes(marker)) {
    if (event.data.source.senderSessionId !== reportChildId) {
      throw new Error('history marker report does not match the observed subagent identity')
    }
    claimedReports += 1
    reportClaims.push({ index, turn })
  }
  if (event.data.source?.kind === 'subagent-settled'
    && event.data.source.senderSessionId === reportChildId) {
    claimedSettlements += 1
    settlementClaims.push({ index, turn })
  }
}
const recoveryTurnStart = turnStartIndices.get(recoveryPromptTurn)
const reportClaimsBeforeRecovery = reportClaims.filter(claim => (
  recoveryTurnStart !== undefined && claim.index < recoveryTurnStart
))
const settlementClaimsBeforeRecovery = settlementClaims.filter(claim => (
  recoveryTurnStart !== undefined && claim.index < recoveryTurnStart
))
const cancellationRequested = recoveryPhase !== 'initial-run'
const stoppedAfterCancellation = !['initial-run', 'cancel-dispatched'].includes(recoveryPhase)
const stableStopped = Number.isSafeInteger(recoveryBoundaryTurn)
const resumedAfterCancellation = ['unexpected-resume', 'prompt-race'].includes(failureKind)
const recoveryRequested = recoveryWasAccepted()
const recoveryCompleted = recoveryPhase === 'grace' || recoveryPhase === 'passed'

console.log(JSON.stringify({
  phase: 'result',
  sessionId,
  marker,
  reportChildId,
  cancellationRequested,
  stoppedAfterCancellation,
  stableStopped,
  stableStoppedMs,
  resumedAfterCancellation,
  recoveryRequested,
  recoveryCompleted,
  recoveryBoundaryTurn,
  correlatedRecoveryTurn,
  contextReports,
  contextSettlements,
  claimedReports,
  claimedSettlements,
  recoveryPromptTurn,
  reportClaimTurns: reportClaims.map(claim => claim.turn),
  settlementClaimTurns: settlementClaims.map(claim => claim.turn),
  reportClaimsBeforeRecovery: reportClaimsBeforeRecovery.length,
  settlementClaimsBeforeRecovery: settlementClaimsBeforeRecovery.length,
}))

if (reportChildId === undefined) throw new Error('probe never identified the marker-bearing subagent')
if (!cancellationRequested) throw new Error('probe never observed pending report context')
if (!stoppedAfterCancellation) throw new Error('session did not stop after cancellation')
if (!stableStopped) throw new Error('session did not remain stopped for the bounded stability interval')
if (contextSettlements === 0) throw new Error('probe never observed retained settlement context')
if (resumedAfterCancellation) throw new Error('session resumed outside the accepted explicit recovery turn')
if (!recoveryRequested || !recoveryCompleted) throw new Error('accepted explicit recovery prompt did not complete')
if (claimedReports !== 1) throw new Error(`retained report was claimed ${claimedReports} times instead of once`)
if (claimedSettlements !== 1) throw new Error(`retained settlement was claimed ${claimedSettlements} times instead of once`)
if (!Number.isSafeInteger(recoveryPromptTurn)) throw new Error('recovery prompt turn was absent from session history')
if (recoveryPromptTurn !== correlatedRecoveryTurn || recoveryPromptTurn <= recoveryBoundaryTurn) {
  throw new Error(`recovery prompt turn ${recoveryPromptTurn} did not match the accepted post-boundary run ${correlatedRecoveryTurn}`)
}
if (recoveryTurnStart === undefined) throw new Error(`recovery turn ${recoveryPromptTurn} has no turn/start event`)
if (reportClaimsBeforeRecovery.length > 0) {
  throw new Error(`retained report was claimed before recovery turn ${recoveryPromptTurn}: ${JSON.stringify(reportClaimsBeforeRecovery)}`)
}
if (settlementClaimsBeforeRecovery.length > 0) {
  throw new Error(`retained settlement was claimed before recovery turn ${recoveryPromptTurn}: ${JSON.stringify(settlementClaimsBeforeRecovery)}`)
}
if (reportClaims.some(claim => claim.turn !== recoveryPromptTurn || claim.index <= recoveryTurnStart)) {
  throw new Error(`retained report was claimed outside recovery turn ${recoveryPromptTurn}: ${JSON.stringify(reportClaims)}`)
}
if (settlementClaims.some(claim => claim.turn !== recoveryPromptTurn || claim.index <= recoveryTurnStart)) {
  throw new Error(`retained settlement was claimed outside recovery turn ${recoveryPromptTurn}: ${JSON.stringify(settlementClaims)}`)
}
console.log('GREEN user cancellation retained report and settlement context, then claimed both exactly once in the explicit recovery turn')
