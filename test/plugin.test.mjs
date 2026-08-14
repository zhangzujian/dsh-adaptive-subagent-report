import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.mjs'

const TEST_AGENT_LOOP_VERSION = Symbol.for('@zhangzujian/dsh-adaptive-subagent-report/test-agent-loop-version')

function contextWith({ subagents, agents, logger, testAgentLoopVersion = '0.1.0-rc.6' }) {
  if (typeof subagents.reportFrom === 'function'
    && typeof subagents.notifySettlement !== 'function'
    && typeof subagents.continuations?.notifySettlement !== 'function') {
    subagents.notifySettlement = () => {}
  }
  if (typeof agents.get === 'function' && typeof agents.list !== 'function') agents.list = () => []
  let dispose
  const listeners = new Map()
  const context = {
    logger,
    get(name) {
      if (name === 'subagents') return subagents
      if (name === 'agents') return agents
      throw new Error(`unexpected service ${name}`)
    },
    effect(setup) {
      dispose = setup()
      return dispose
    },
    on(event, listener) {
      let eventListeners = listeners.get(event)
      if (eventListeners === undefined) {
        eventListeners = new Set()
        listeners.set(event, eventListeners)
      }
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
    dispose() {
      dispose?.()
    },
  }
  if (testAgentLoopVersion !== false) {
    Object.defineProperty(context, TEST_AGENT_LOOP_VERSION, { value: testAgentLoopVersion })
  }
  return context
}

function runningParent(overrides = {}) {
  const abort = new AbortController()
  return {
    status: 'running',
    phase: { kind: 'running', turn: 1, abort },
    inbox: { nextStep: [], nextTurn: [] },
    followup() {},
    steer() {},
    inject() {},
    cancel(cause) {
      abort.abort(cause)
    },
    whenIdle() {
      return Promise.resolve()
    },
    wakeDriver() {},
    ...overrides,
  }
}

function publishUserCancelledIdle(parent, abort, cause) {
  abort.abort(cause)
  parent.phase = { kind: 'idle', lastTurn: 1 }
  parent.status = 'idle'
}

test('a wakeup report to a running parent is delivered through steer in the same acceptance call', async () => {
  const deliveries = []
  const parent = runningParent({
    followup(message) {
      deliveries.push({ route: 'followup', message })
    },
    steer(message) {
      deliveries.push({ route: 'steer', message })
    },
  })
  const accepted = Promise.resolve('report-message')
  const subagents = {
    reportFrom(child, content, options) {
      assert.equal(options.delivery, 'wakeup')
      const message = {
        id: 'report-message',
        child,
        content,
        source: { kind: 'subagent-report', senderSessionId: child.id },
      }
      parent.followup(message)
      return accepted
    },
  }
  const agents = {
    get: id => id === 'parent-session' ? parent : undefined,
    list: () => [parent],
  }
  const ctx = contextWith({ subagents, agents })
  apply(ctx)
  const instrumentedFollowup = parent.followup

  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const content = [{ type: 'text', text: 'finding' }]
  const signal = new AbortController().signal
  const result = subagents.reportFrom(child, content, { delivery: 'wakeup', signal })

  assert.equal(result, accepted)
  assert.deepEqual(deliveries, [{
    route: 'steer',
    message: {
      id: 'report-message',
      child,
      content,
      source: { kind: 'subagent-report', senderSessionId: child.id },
    },
  }])
  assert.equal(parent.followup, instrumentedFollowup)
  assert.equal(await result, 'report-message')
})

test('only the exact report send is rerouted during synchronous re-entry', async () => {
  const deliveries = []
  const parent = runningParent({
    followup(message) {
      deliveries.push({ route: 'followup', message })
    },
    steer(message) {
      deliveries.push({ route: 'steer', message })
    },
  })
  const child = {
    id: 'child-session',
    session: { header: { parentSession: 'parent-session' } },
  }
  const report = {
    id: 'report-message',
    source: { kind: 'subagent-report', senderSessionId: child.id },
  }
  const ordinary = {
    id: 'ordinary-message',
    source: { kind: 'user' },
  }
  const subagents = {
    reportFrom() {
      parent.followup(report)
      parent.followup(ordinary)
      return Promise.resolve(report.id)
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent } })
  apply(ctx)

  await subagents.reportFrom(child, [], { delivery: 'wakeup' })

  assert.deepEqual(deliveries, [
    { route: 'steer', message: report },
    { route: 'followup', message: ordinary },
  ])
})

test('teardown makes a covered wrapper pass through without overwriting the later wrapper', async () => {
  const deliveries = []
  const parent = runningParent({
    followup(message) {
      deliveries.push({ route: 'followup', message })
    },
    steer(message) {
      deliveries.push({ route: 'steer', message })
    },
  })
  const subagents = {
    reportFrom(child, content) {
      const message = {
        id: 'report-message',
        child,
        content,
        source: { kind: 'subagent-report', senderSessionId: child.id },
      }
      parent.followup(message)
      return Promise.resolve(message.id)
    },
  }
  const agents = { get: () => parent }
  const ctx = contextWith({ subagents, agents })
  apply(ctx)

  const adaptiveWrapper = subagents.reportFrom
  const laterWrapper = function laterReportWrapper(...args) {
    return adaptiveWrapper.apply(subagents, args)
  }
  subagents.reportFrom = laterWrapper
  ctx.dispose()

  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  await subagents.reportFrom(child, [], {
    delivery: 'wakeup',
    signal: new AbortController().signal,
  })

  assert.equal(subagents.reportFrom, laterWrapper)
  assert.deepEqual(deliveries, [{
    route: 'followup',
    message: {
      id: 'report-message',
      child,
      content: [],
      source: { kind: 'subagent-report', senderSessionId: child.id },
    },
  }])
})

test('a displaced cancel wrapper is an inactive pass-through after teardown', () => {
  let kindReads = 0
  const parent = runningParent({ cancel() {} })
  const subagents = { reportFrom() {} }
  const agents = { get: () => parent, list: () => [parent] }
  const ctx = contextWith({ subagents, agents })
  apply(ctx)

  const adaptiveCancel = parent.cancel
  const laterCancel = function laterCancel(...args) {
    return adaptiveCancel.apply(this, args)
  }
  parent.cancel = laterCancel
  ctx.dispose()
  parent.cancel({
    get kind() {
      kindReads += 1
      return 'user'
    },
  })

  assert.equal(parent.cancel, laterCancel)
  assert.equal(kindReads, 0)
})

test('displaced user-prompt observers are inactive pass-throughs after teardown', () => {
  let kindReads = 0
  const calls = []
  const parent = runningParent({
    followup(message) {
      calls.push(['followup', message.id])
      return 'followup-result'
    },
    steer(message) {
      calls.push(['steer', message.id])
      return 'steer-result'
    },
  })
  const subagents = { reportFrom() {} }
  const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
  apply(ctx)

  const adaptiveFollowup = parent.followup
  const adaptiveSteer = parent.steer
  const laterFollowup = function laterFollowup(...args) {
    return adaptiveFollowup.apply(this, args)
  }
  const laterSteer = function laterSteer(...args) {
    return adaptiveSteer.apply(this, args)
  }
  parent.followup = laterFollowup
  parent.steer = laterSteer
  ctx.dispose()
  const message = {
    id: 'user-message',
    source: {
      get kind() {
        kindReads += 1
        return 'user'
      },
    },
  }

  assert.equal(parent.followup(message), 'followup-result')
  assert.equal(parent.steer(message), 'steer-result')
  assert.equal(parent.followup, laterFollowup)
  assert.equal(parent.steer, laterSteer)
  assert.equal(kindReads, 0)
  assert.deepEqual(calls, [
    ['followup', 'user-message'],
    ['steer', 'user-message'],
  ])
})

test('re-entrant teardown restores parent methods after temporary report interception', async () => {
  const routes = []
  const parent = runningParent({
    followup(message) { routes.push({ route: 'followup', message }) },
    steer(message) { routes.push({ route: 'steer', message }) },
  })
  const originalCancel = parent.cancel
  const originalFollowup = parent.followup
  const originalSteer = parent.steer
  const report = {
    id: 'teardown-report',
    source: { kind: 'subagent-report', senderSessionId: 'child-session' },
  }
  let ctx
  const subagents = {
    reportFrom() {
      ctx.dispose()
      parent.followup(report)
      return Promise.resolve(report.id)
    },
  }
  ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
  apply(ctx)

  await subagents.reportFrom(
    { id: 'child-session', session: { header: { parentSession: 'parent-session' } } },
    [],
    { delivery: 'wakeup' },
  )

  assert.deepEqual(routes, [{ route: 'followup', message: report }])
  assert.equal(parent.cancel, originalCancel)
  assert.equal(parent.followup, originalFollowup)
  assert.equal(parent.steer, originalSteer)
})

test('[version-sensitive: DSH rc.6 agent lifecycle seam] agent disposal during exact interception defers restoration and disables routing', async () => {
  const routes = []
  const parent = runningParent({
    followup(message) { routes.push({ route: 'followup', message }) },
    steer(message) { routes.push({ route: 'steer', message }) },
  })
  const originalCancel = parent.cancel
  const originalFollowup = parent.followup
  const originalSteer = parent.steer
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const report = {
    id: 'disposed-report',
    source: { kind: 'subagent-report', senderSessionId: child.id },
  }
  let ctx
  const subagents = {
    reportFrom() {
      ctx.emit('agent/disposed', { agent: parent })
      parent.followup(report)
      return Promise.resolve(report.id)
    },
  }
  ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
  apply(ctx)

  await subagents.reportFrom(child, [], { delivery: 'wakeup' })

  assert.deepEqual(routes, [{ route: 'followup', message: report }])
  assert.equal(parent.cancel, originalCancel)
  assert.equal(parent.followup, originalFollowup)
  assert.equal(parent.steer, originalSteer)
})

test('nested exact interception defers re-entrant teardown restoration to the outermost unwind', async () => {
  const parent = runningParent()
  const originalCancel = parent.cancel
  const originalFollowup = parent.followup
  const originalSteer = parent.steer
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const report = {
    id: 'nested-teardown-report',
    source: { kind: 'subagent-report', senderSessionId: child.id },
  }
  let nested = false
  let ctx
  const subagents = {
    reportFrom() {
      if (!nested) {
        nested = true
        return subagents.reportFrom(child, [], { delivery: 'wakeup' })
      }
      ctx.dispose()
      parent.followup(report)
      return Promise.resolve(report.id)
    },
  }
  ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
  apply(ctx)

  await subagents.reportFrom(child, [], { delivery: 'wakeup' })

  assert.equal(parent.cancel, originalCancel)
  assert.equal(parent.followup, originalFollowup)
  assert.equal(parent.steer, originalSteer)
})

test('a second installation on the same subagent runtime fails loudly', () => {
  const subagents = { reportFrom() {} }
  const agents = { get() {} }
  const first = contextWith({ subagents, agents })
  const second = contextWith({ subagents, agents })
  apply(first)

  assert.throws(
    () => apply(second),
    /adaptive subagent report delivery is already installed/,
  )

  first.dispose()
})

test('[version-sensitive: DSH rc.6 parent instrumentation seam] partial instrumentation failure restores earlier wrappers', () => {
  const parent = runningParent()
  const originalCancel = parent.cancel
  const originalFollowup = parent.followup
  const originalSteer = parent.steer
  Object.defineProperty(parent, 'steer', {
    configurable: false,
    writable: true,
    value: originalSteer,
  })
  const subagents = { reportFrom() {}, notifySettlement() {} }
  const originalReportFrom = subagents.reportFrom
  const originalNotifySettlement = subagents.notifySettlement
  const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })

  assert.throws(() => apply(ctx), /Cannot redefine property: steer/)
  assert.equal(parent.cancel, originalCancel)
  assert.equal(parent.followup, originalFollowup)
  assert.equal(parent.steer, originalSteer)
  assert.equal(subagents.reportFrom, originalReportFrom)
  assert.equal(subagents.notifySettlement, originalNotifySettlement)
})

test('[version-sensitive: DSH rc.6 agent lifecycle seam] disposed agents release their instrumentation', () => {
  const parent = runningParent()
  const originalCancel = parent.cancel
  const originalFollowup = parent.followup
  const originalSteer = parent.steer
  const subagents = { reportFrom() {} }
  const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
  apply(ctx)
  const adaptiveCancel = parent.cancel
  const adaptiveFollowup = parent.followup
  const adaptiveSteer = parent.steer
  const laterCancel = (...args) => adaptiveCancel(...args)
  const laterFollowup = (...args) => adaptiveFollowup(...args)
  const laterSteer = (...args) => adaptiveSteer(...args)
  parent.cancel = laterCancel
  parent.followup = laterFollowup
  parent.steer = laterSteer

  ctx.emit('agent/disposed', { agent: parent })
  let sourceReads = 0
  const message = {
    get source() {
      sourceReads += 1
      return { kind: 'user' }
    },
  }
  parent.followup(message)
  parent.steer(message)
  parent.cancel({ kind: 'user' }, { keepInbox: true })

  assert.equal(sourceReads, 0)
  assert.equal(parent.cancel, laterCancel)
  assert.equal(parent.followup, laterFollowup)
  assert.equal(parent.steer, laterSteer)
  assert.notEqual(parent.cancel, originalCancel)
  assert.notEqual(parent.followup, originalFollowup)
  assert.notEqual(parent.steer, originalSteer)
})

test('[version-sensitive: DSH rc.6 private seam] pending routed context wakes once after the exact parent becomes idle', async () => {
  const idle = Promise.withResolvers()
  const nextStep = []
  let wakeCount = 0
  const parent = runningParent({
    status: 'running',
    inbox: { nextStep },
    followup() {
      throw new Error('running report must not use followup')
    },
    steer(message) {
      nextStep.push(message)
    },
    whenIdle() {
      return idle.promise
    },
    wakeDriver() {
      wakeCount += 1
      this.status = 'running'
    },
  })
  const subagents = {
    reportFrom(child, content) {
      const message = {
        id: 'report-message',
        child,
        content,
        source: { kind: 'subagent-report', senderSessionId: child.id },
      }
      parent.followup(message)
      return Promise.resolve(message.id)
    },
  }
  const agents = { get: () => parent }
  const ctx = contextWith({ subagents, agents })
  apply(ctx)

  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  await subagents.reportFrom(child, [], {
    delivery: 'wakeup',
    signal: new AbortController().signal,
  })
  parent.status = 'idle'
  idle.resolve()
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(wakeCount, 1)
  assert.equal(nextStep.length, 1)
  assert.equal(nextStep[0].id, 'report-message')
})

test('[version-sensitive: DSH rc.6 tail-wake seam] later-turn user cancellation suppresses the pending tail callback', async () => {
  const idle = Promise.withResolvers()
  let wakeCount = 0
  const parent = runningParent({
    steer(message) {
      this.inbox.nextStep.push(message)
    },
    whenIdle() {
      return idle.promise
    },
    wakeDriver() {
      wakeCount += 1
    },
    cancel() {},
  })
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const subagents = {
    reportFrom() {
      const message = {
        id: 'report-message',
        source: { kind: 'subagent-report', senderSessionId: child.id },
      }
      parent.followup(message)
      return Promise.resolve(message.id)
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
  apply(ctx)

  await subagents.reportFrom(child, [], { delivery: 'wakeup' })
  parent.phase = { kind: 'idle', lastTurn: 2 }
  parent.status = 'idle'
  parent.cancel({ kind: 'user' }, { keepInbox: true })
  idle.resolve()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(wakeCount, 0)
  assert.equal(parent.inbox.nextStep.length, 1)
})

test('[version-sensitive: DSH rc.6 private seam] user cancellation keeps accepted context idle', async () => {
  const idle = Promise.withResolvers()
  const abort = new AbortController()
  let wakeCount = 0
  const parent = runningParent({
    phase: { kind: 'running', turn: 1, abort },
    steer(message) {
      this.inbox.nextStep.push(message)
    },
    whenIdle() {
      return idle.promise
    },
    wakeDriver() {
      wakeCount += 1
      this.status = 'running'
    },
    cancel(cause, { keepInbox }) {
      if (!keepInbox) this.inbox.nextStep.length = 0
      abort.abort(cause)
      this.status = 'idle'
      idle.resolve()
    },
  })
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const subagents = {
    reportFrom() {
      const message = {
        id: 'report-message',
        source: { kind: 'subagent-report', senderSessionId: child.id },
      }
      parent.followup(message)
      return Promise.resolve(message.id)
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent } })
  apply(ctx)

  await subagents.reportFrom(child, [], { delivery: 'wakeup' })
  parent.cancel({ kind: 'user' }, { keepInbox: true })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(parent.status, 'idle')
  assert.equal(wakeCount, 0)
  assert.equal(parent.inbox.nextStep.length, 1)
})

test('[version-sensitive: DSH rc.6 cancellation retention seam] cancellation matches accepted report ids without inspecting unrelated framing', async () => {
  const abort = new AbortController()
  const routes = []
  let unrelatedSourceReads = 0
  const parent = runningParent({
    phase: { kind: 'running', turn: 1, abort },
    steer(message) {
      routes.push({ route: 'steer', message })
      this.inbox.nextStep.push(message)
    },
    inject(message) {
      routes.push({ route: 'inject', message })
      this.inbox.nextStep.push(message)
    },
    cancel(cause) {
      publishUserCancelledIdle(this, abort, cause)
    },
  })
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const report = {
    id: 'accepted-report',
    source: { kind: 'subagent-report', senderSessionId: child.id },
  }
  const unrelated = {
    id: 'unrelated-message',
    get source() {
      unrelatedSourceReads += 1
      throw new Error('unrelated source framing was inspected')
    },
  }
  const settlement = {
    id: 'settlement-message',
    source: { kind: 'subagent-settled', senderSessionId: child.id },
  }
  const subagents = {
    reportFrom() {
      parent.followup(report)
      return Promise.resolve(report.id)
    },
    notifySettlement() {
      parent.followup(settlement)
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
  apply(ctx)

  await subagents.reportFrom(child, [], { delivery: 'wakeup' })
  parent.inbox.nextStep.push(unrelated)
  routes.length = 0
  assert.doesNotThrow(() => parent.cancel({ kind: 'user' }, { keepInbox: true }))
  subagents.notifySettlement({ childId: child.id, parentSession: 'parent-session' }, {})

  assert.equal(unrelatedSourceReads, 0)
  assert.deepEqual(routes, [{ route: 'inject', message: settlement }])
})

test('[version-sensitive: DSH rc.6 cancellation retention seam] pre-cancellation user prompt preserves pending report association', async () => {
  const abort = new AbortController()
  const routes = []
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const report = {
    id: 'pending-report',
    source: { kind: 'subagent-report', senderSessionId: child.id },
  }
  const settlement = {
    id: 'pending-settlement',
    source: { kind: 'subagent-settled', senderSessionId: child.id },
  }
  const parent = runningParent({
    phase: { kind: 'running', turn: 1, abort },
    followup(message) {
      routes.push({ route: 'followup', message })
    },
    steer(message) {
      routes.push({ route: 'steer', message })
      this.inbox.nextStep.push(message)
    },
    inject(message) {
      routes.push({ route: 'inject', message })
    },
    cancel(cause) {
      publishUserCancelledIdle(this, abort, cause)
    },
  })
  const subagents = {
    reportFrom() {
      parent.followup(report)
      return Promise.resolve(report.id)
    },
    notifySettlement() {
      parent.followup(settlement)
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
  apply(ctx)

  await subagents.reportFrom(child, [], { delivery: 'wakeup' })
  parent.followup({ id: 'user-prompt', source: { kind: 'user' } })
  parent.cancel({ kind: 'user' }, { keepInbox: true })
  routes.length = 0
  subagents.notifySettlement({ childId: child.id, parentSession: 'parent-session' }, {})

  assert.deepEqual(routes, [{ route: 'inject', message: settlement }])
})

test('[version-sensitive: DSH rc.6 cancellation retention seam] cancellation rejects either missing pending inbox queue', async () => {
  for (const missingQueue of ['nextStep', 'nextTurn']) {
    const abort = new AbortController()
    const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
    const report = {
      id: `pending-report-${missingQueue}`,
      source: { kind: 'subagent-report', senderSessionId: child.id },
    }
    const parent = runningParent({
      phase: { kind: 'running', turn: 1, abort },
      steer(message) {
        this.inbox.nextStep.push(message)
      },
      cancel(cause) {
        publishUserCancelledIdle(this, abort, cause)
      },
    })
    const subagents = {
      reportFrom() {
        parent.followup(report)
        return Promise.resolve(report.id)
      },
    }
    const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
    apply(ctx)

    await subagents.reportFrom(child, [], { delivery: 'wakeup' })
    delete parent.inbox[missingQueue]

    assert.throws(
      () => parent.cancel({ kind: 'user' }, { keepInbox: true }),
      new RegExp(`${missingQueue} array`),
      missingQueue,
    )
  }
})

for (const testCase of [
  { name: 'successful steer', steerThrows: false, settlementRoute: 'inject' },
  { name: 'failed steer rollback', steerThrows: true, settlementRoute: 'followup' },
]) {
  test(`[version-sensitive: DSH rc.6 cancellation retention seam] ${testCase.name} handles re-entrant cancellation`, async () => {
    const abort = new AbortController()
    const routes = []
    const expected = new Error('steer failed')
    const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
    const report = {
      id: 'reentrant-report',
      source: { kind: 'subagent-report', senderSessionId: child.id },
    }
    const settlement = {
      id: 'reentrant-settlement',
      source: { kind: 'subagent-settled', senderSessionId: child.id },
    }
    const parent = runningParent({
      phase: { kind: 'running', turn: 1, abort },
      steer(message) {
        routes.push({ route: 'steer', message })
        this.inbox.nextStep.push(message)
        this.cancel({ kind: 'user' }, { keepInbox: true })
        if (testCase.steerThrows) throw expected
      },
      inject(message) {
        routes.push({ route: 'inject', message })
      },
      followup(message) {
        routes.push({ route: 'followup', message })
      },
      cancel(cause) {
        publishUserCancelledIdle(this, abort, cause)
      },
    })
    const subagents = {
      reportFrom() {
        parent.followup(report)
        return Promise.resolve(report.id)
      },
      notifySettlement() {
        parent.followup(settlement)
      },
    }
    const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
    apply(ctx)

    if (testCase.steerThrows) {
      assert.throws(
        () => subagents.reportFrom(child, [], { delivery: 'wakeup' }),
        error => error === expected,
      )
    } else {
      await subagents.reportFrom(child, [], { delivery: 'wakeup' })
    }
    routes.length = 0
    subagents.notifySettlement({ childId: child.id, parentSession: 'parent-session' }, {})

    assert.deepEqual(routes, [{ route: testCase.settlementRoute, message: settlement }])
  })
}

test('[version-sensitive: DSH rc.6 inbox insertion seam] re-entrant cancellation before live insertion retains the in-flight report', async () => {
  const abort = new AbortController()
  const routes = []
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const report = {
    id: 'in-flight-report',
    source: { kind: 'subagent-report', senderSessionId: child.id },
  }
  const settlement = {
    id: 'in-flight-settlement',
    source: { kind: 'subagent-settled', senderSessionId: child.id },
  }
  const parent = runningParent({
    phase: { kind: 'running', turn: 1, abort },
    steer(message) {
      routes.push({ route: 'steer', message })
      this.cancel({ kind: 'user' }, { keepInbox: true })
      this.inbox.nextStep.push(message)
    },
    inject(message) {
      routes.push({ route: 'inject', message })
    },
    cancel(cause) {
      publishUserCancelledIdle(this, abort, cause)
    },
  })
  const subagents = {
    reportFrom() {
      parent.followup(report)
      return Promise.resolve(report.id)
    },
    notifySettlement() {
      parent.followup(settlement)
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
  apply(ctx)

  await subagents.reportFrom(child, [], { delivery: 'wakeup' })
  routes.length = 0
  subagents.notifySettlement({ childId: child.id, parentSession: 'parent-session' }, {})

  assert.deepEqual(routes, [{ route: 'inject', message: settlement }])
})

test('[version-sensitive: DSH rc.6 cancellation retention seam] failed second steer preserves an earlier retained report from the same child', async () => {
  const abort = new AbortController()
  const routes = []
  const expected = new Error('second steer failed')
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const reports = [
    { id: 'first-report', source: { kind: 'subagent-report', senderSessionId: child.id } },
    { id: 'second-report', source: { kind: 'subagent-report', senderSessionId: child.id } },
  ]
  let reportIndex = 0
  const settlement = {
    id: 'same-child-settlement',
    source: { kind: 'subagent-settled', senderSessionId: child.id },
  }
  const parent = runningParent({
    phase: { kind: 'running', turn: 1, abort },
    steer(message) {
      routes.push({ route: 'steer', message })
      this.inbox.nextStep.push(message)
      if (message.id === 'second-report') {
        this.cancel({ kind: 'user' }, { keepInbox: true })
        throw expected
      }
    },
    inject(message) {
      routes.push({ route: 'inject', message })
    },
    cancel(cause) {
      publishUserCancelledIdle(this, abort, cause)
    },
  })
  const subagents = {
    reportFrom() {
      const report = reports[reportIndex]
      reportIndex += 1
      parent.followup(report)
      return Promise.resolve(report.id)
    },
    notifySettlement() {
      parent.followup(settlement)
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
  apply(ctx)

  await subagents.reportFrom(child, [], { delivery: 'wakeup' })
  assert.throws(
    () => subagents.reportFrom(child, [], { delivery: 'wakeup' }),
    error => error === expected,
  )
  routes.length = 0
  subagents.notifySettlement({ childId: child.id, parentSession: 'parent-session' }, {})

  assert.deepEqual(routes, [{ route: 'inject', message: settlement }])
})

test('[version-sensitive: DSH rc.6 private seam] report arriving after user cancellation retains its same-child settlement', async () => {
  const abort = new AbortController()
  abort.abort({ kind: 'user' })
  const routes = []
  const parent = runningParent({
    phase: { kind: 'running', turn: 1, abort },
    steer(message) {
      routes.push({ route: 'steer', message })
    },
    inject(message) {
      routes.push({ route: 'inject', message })
      this.inbox.nextStep.push(message)
    },
    whenIdle() {
      return new Promise(() => {})
    },
  })
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const message = {
    id: 'report-message',
    source: { kind: 'subagent-report', senderSessionId: child.id },
  }
  const settlement = {
    id: 'settlement-message',
    source: { kind: 'subagent-settled', senderSessionId: child.id },
  }
  const subagents = {
    reportFrom() {
      parent.followup(message)
      return Promise.resolve(message.id)
    },
    notifySettlement() {
      parent.steer(settlement)
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent } })
  apply(ctx)

  await subagents.reportFrom(child, [], { delivery: 'wakeup' })
  subagents.notifySettlement({ childId: child.id, parentSession: 'parent-session' }, {})

  assert.deepEqual(routes, [
    { route: 'inject', message },
    { route: 'inject', message: settlement },
  ])
  assert.equal(parent.inbox.nextStep.length, 2)
})

test('[version-sensitive: DSH rc.6 retained-report seam] failed inject does not retain the child or change the original error', () => {
  const abort = new AbortController()
  abort.abort({ kind: 'user' })
  const expected = new Error('inject failed')
  const routes = []
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const report = {
    id: 'report-message',
    source: { kind: 'subagent-report', senderSessionId: child.id },
  }
  const settlement = {
    id: 'settlement-message',
    source: { kind: 'subagent-settled', senderSessionId: child.id },
  }
  const parent = runningParent({
    phase: { kind: 'running', turn: 1, abort },
    inject(message) {
      routes.push({ route: 'inject', message })
      throw expected
    },
    steer(message) {
      routes.push({ route: 'steer', message })
    },
  })
  const subagents = {
    reportFrom() {
      parent.followup(report)
      return Promise.resolve(report.id)
    },
    notifySettlement() {
      parent.steer(settlement)
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent } })
  apply(ctx)

  assert.throws(
    () => subagents.reportFrom(child, [], { delivery: 'wakeup' }),
    error => error === expected,
  )
  assert.doesNotThrow(() => {
    subagents.notifySettlement({ childId: child.id, parentSession: 'parent-session' }, {})
  })
  assert.deepEqual(routes, [
    { route: 'inject', message: report },
    { route: 'steer', message: settlement },
  ])
})

test('[version-sensitive: DSH rc.6 private seam] maintenance cancellation retains reports across later turns until a user prompt', async () => {
  const abort = new AbortController()
  const routes = []
  const parent = {
    status: 'idle',
    phase: { kind: 'maintenance', lastTurn: 1, abort },
    followup(message) {
      routes.push({ route: 'followup', message })
    },
    steer(message) {
      routes.push({ route: 'steer', message })
    },
    inject(message) {
      routes.push({ route: 'inject', message })
    },
    cancel(cause) {
      abort.abort(cause)
    },
  }
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  let reports = 0
  const subagents = {
    reportFrom() {
      reports += 1
      const message = {
        id: `report-${reports}`,
        source: { kind: 'subagent-report', senderSessionId: child.id },
      }
      parent.followup(message)
      return Promise.resolve(message.id)
    },
  }
  const ctx = contextWith({
    subagents,
    agents: { get: () => parent, list: () => [parent] },
  })
  apply(ctx)

  parent.cancel({ kind: 'user' }, { keepInbox: true })
  await subagents.reportFrom(child, [], { delivery: 'wakeup' })
  parent.phase = { kind: 'idle', lastTurn: 2 }
  await subagents.reportFrom(child, [], { delivery: 'wakeup' })

  assert.deepEqual(routes.map(({ route, message }) => [route, message.id]), [
    ['inject', 'report-1'],
    ['inject', 'report-2'],
  ])
})

test('[version-sensitive: DSH rc.6 idle wake seam] re-entrant cancellation suppresses the exact pending wake before driver claim', async () => {
  const abort = new AbortController()
  const routes = []
  let wakeCount = 0
  const parent = {
    status: 'idle',
    phase: { kind: 'idle', lastTurn: 1, abort },
    inbox: { nextStep: [], nextTurn: [] },
    followup(message) {
      routes.push({ route: 'followup', message })
      this.inbox.nextTurn.push(message)
      this.cancel({ kind: 'user' }, { keepInbox: true })
      this.wakeDriver()
    },
    steer(message) {
      routes.push({ route: 'steer', message })
    },
    inject(message) {
      routes.push({ route: 'inject', message })
    },
    cancel(cause) {
      abort.abort(cause)
      this.status = 'idle'
    },
    wakeDriver() {
      wakeCount += 1
      this.status = 'running'
    },
  }
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const report = {
    id: 'idle-report',
    source: { kind: 'subagent-report', senderSessionId: child.id },
  }
  const settlement = {
    id: 'idle-settlement',
    source: { kind: 'subagent-settled', senderSessionId: child.id },
  }
  const subagents = {
    reportFrom() {
      parent.followup(report)
      return Promise.resolve(report.id)
    },
    notifySettlement() {
      parent.followup(settlement)
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
  apply(ctx)

  await subagents.reportFrom(child, [], { delivery: 'wakeup' })
  subagents.notifySettlement({ childId: child.id, parentSession: 'parent-session' }, {})

  assert.equal(wakeCount, 0)
  assert.equal(parent.status, 'idle')
  assert.deepEqual(routes.map(({ route, message }) => [route, message.id]), [
    ['followup', 'idle-report'],
    ['inject', 'idle-settlement'],
  ])
})

test('[version-sensitive: DSH rc.6 maintenance seam] report before cancellation is retained and clears the wake latch', async () => {
  const abort = new AbortController()
  const routes = []
  const parent = {
    status: 'idle',
    phase: { kind: 'maintenance', lastTurn: 1, abort, wakeRequested: false },
    inbox: { nextStep: [], nextTurn: [] },
    followup(message) {
      routes.push({ route: 'followup', message })
      this.inbox.nextTurn.push(message)
      this.phase.wakeRequested = true
    },
    steer(message) {
      routes.push({ route: 'steer', message })
    },
    inject(message) {
      routes.push({ route: 'inject', message })
    },
    wakeDriver() {},
    cancel(cause) {
      abort.abort(cause)
    },
  }
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const report = {
    id: 'maintenance-report',
    source: { kind: 'subagent-report', senderSessionId: child.id },
  }
  const settlement = {
    id: 'maintenance-settlement',
    source: { kind: 'subagent-settled', senderSessionId: child.id },
  }
  const subagents = {
    reportFrom() {
      parent.followup(report)
      return Promise.resolve(report.id)
    },
    notifySettlement() {
      parent.followup(settlement)
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
  apply(ctx)

  await subagents.reportFrom(child, [], { delivery: 'wakeup' })
  assert.equal(parent.phase.wakeRequested, true)
  parent.cancel({ kind: 'user' }, { keepInbox: true })
  subagents.notifySettlement({ childId: child.id, parentSession: 'parent-session' }, {})

  assert.equal(parent.phase.wakeRequested, false)
  assert.deepEqual(routes.map(({ route, message }) => [route, message.id]), [
    ['followup', 'maintenance-report'],
    ['inject', 'maintenance-settlement'],
  ])
})

test('[version-sensitive: DSH rc.6 maintenance seam] idle publication cannot replay a report-only maintenance wake latch', async () => {
  const abort = new AbortController()
  const maintenancePhase = { kind: 'maintenance', lastTurn: 1, abort, wakeRequested: false }
  const parent = {
    status: 'idle',
    phase: maintenancePhase,
    inbox: { nextStep: [], nextTurn: [] },
    followup(message) {
      this.inbox.nextTurn.push(message)
      maintenancePhase.wakeRequested = true
      this.phase = { kind: 'idle', lastTurn: 1 }
      this.cancel({ kind: 'user' }, { keepInbox: true })
    },
    steer() {},
    inject() {},
    wakeDriver() {},
    cancel(cause) {
      abort.abort(cause)
    },
  }
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const subagents = {
    reportFrom() {
      const message = {
        id: 'maintenance-transition-report',
        source: { kind: 'subagent-report', senderSessionId: child.id },
      }
      parent.followup(message)
      return Promise.resolve(message.id)
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
  apply(ctx)

  await subagents.reportFrom(child, [], { delivery: 'wakeup' })

  assert.equal(maintenancePhase.wakeRequested, false)
  assert.equal(parent.phase.kind, 'idle')
})

test('[version-sensitive: DSH rc.6 maintenance seam] failed followup rolls back re-entrant retention exactly', () => {
  const abort = new AbortController()
  const routes = []
  const expected = new Error('maintenance followup failed')
  const parent = {
    status: 'idle',
    phase: { kind: 'maintenance', lastTurn: 1, abort, wakeRequested: true },
    inbox: { nextStep: [], nextTurn: [] },
    followup(message) {
      routes.push({ route: 'followup', message })
      if (message.source.kind === 'subagent-report') {
        this.inbox.nextTurn.push(message)
        this.cancel({ kind: 'user' }, { keepInbox: true })
        throw expected
      }
    },
    steer(message) {
      routes.push({ route: 'steer', message })
    },
    inject(message) {
      routes.push({ route: 'inject', message })
    },
    wakeDriver() {},
    cancel(cause) {
      abort.abort(cause)
    },
  }
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const report = {
    id: 'failed-maintenance-report',
    source: { kind: 'subagent-report', senderSessionId: child.id },
  }
  const settlement = {
    id: 'failed-maintenance-settlement',
    source: { kind: 'subagent-settled', senderSessionId: child.id },
  }
  const subagents = {
    reportFrom() {
      parent.followup(report)
    },
    notifySettlement() {
      parent.followup(settlement)
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
  apply(ctx)

  assert.throws(
    () => subagents.reportFrom(child, [], { delivery: 'wakeup' }),
    error => error === expected,
  )
  assert.equal(parent.phase.wakeRequested, true)
  routes.length = 0
  subagents.notifySettlement({ childId: child.id, parentSession: 'parent-session' }, {})

  assert.deepEqual(routes, [{ route: 'followup', message: settlement }])
})

test('[version-sensitive: DSH rc.6 private seam] first report after an idle user cancellation does not restart the parent', async () => {
  const abort = new AbortController()
  const routes = []
  const parent = runningParent({
    phase: { kind: 'running', turn: 1, abort },
    inject(message) {
      routes.push({ route: 'inject', message })
      this.inbox.nextStep.push(message)
    },
    followup(message) {
      routes.push({ route: 'followup', message })
      this.status = 'running'
    },
    cancel(cause) {
      publishUserCancelledIdle(this, abort, cause)
    },
  })
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const message = {
    id: 'report-message',
    source: { kind: 'subagent-report', senderSessionId: child.id },
  }
  const settlement = {
    id: 'settlement-message',
    source: { kind: 'subagent-settled', senderSessionId: child.id },
  }
  const subagents = {
    reportFrom() {
      parent.followup(message)
      return Promise.resolve(message.id)
    },
    notifySettlement() {
      parent.followup(settlement)
    },
  }
  const agents = {
    get: () => parent,
    list: () => [parent],
  }
  const ctx = contextWith({ subagents, agents })
  apply(ctx)

  parent.cancel({ kind: 'user' }, { keepInbox: true })
  await subagents.reportFrom(child, [], { delivery: 'wakeup' })
  subagents.notifySettlement({ childId: child.id, parentSession: 'parent-session' }, {})

  assert.equal(parent.status, 'idle')
  assert.deepEqual(routes, [
    { route: 'inject', message },
    { route: 'inject', message: settlement },
  ])
})

test('[version-sensitive: DSH rc.6 private seam] settlement during an aborting user-cancelled turn is retained', async () => {
  const abort = new AbortController()
  const routes = []
  const parent = runningParent({
    phase: { kind: 'running', turn: 1, abort },
    inject(message) {
      routes.push({ route: 'inject', message })
      this.inbox.nextStep.push(message)
    },
    followup(message) {
      routes.push({ route: 'followup', message })
    },
    steer(message) {
      routes.push({ route: 'steer', message })
      this.inbox.nextStep.push(message)
      if (this.phase.abort.signal.aborted) this.phase.wakeRequested = true
    },
    cancel(cause) {
      abort.abort(cause)
    },
  })
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const report = {
    id: 'report-message',
    source: { kind: 'subagent-report', senderSessionId: child.id },
  }
  const settlement = {
    id: 'settlement-message',
    source: { kind: 'subagent-settled', senderSessionId: child.id },
  }
  const subagents = {
    reportFrom() {
      parent.followup(report)
      return Promise.resolve(report.id)
    },
    notifySettlement() {
      if (parent.status === 'idle') parent.followup(settlement)
      else parent.steer(settlement)
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent } })
  apply(ctx)

  await subagents.reportFrom(child, [], { delivery: 'wakeup' })
  routes.length = 0
  parent.cancel({ kind: 'user' }, { keepInbox: true })
  subagents.notifySettlement({ childId: child.id, parentSession: 'parent-session' }, {})

  assert.deepEqual(routes, [{ route: 'inject', message: settlement }])
  assert.equal(parent.phase.wakeRequested, undefined)
})

test('[version-sensitive: DSH rc.6 private seam] settlement after user cancellation is retained without wakeup', async () => {
  const idle = Promise.withResolvers()
  const abort = new AbortController()
  const routes = []
  const parent = runningParent({
    phase: { kind: 'running', turn: 1, abort },
    steer(message) {
      this.inbox.nextStep.push(message)
    },
    inject(message) {
      routes.push({ route: 'inject', message })
      this.inbox.nextStep.push(message)
    },
    followup(message) {
      routes.push({ route: 'followup', message })
      this.status = 'running'
    },
    whenIdle() {
      return idle.promise
    },
    cancel(cause) {
      publishUserCancelledIdle(this, abort, cause)
      idle.resolve()
    },
  })
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const report = {
    id: 'report-message',
    source: { kind: 'subagent-report', senderSessionId: child.id },
  }
  const settlement = {
    id: 'settlement-message',
    source: { kind: 'subagent-settled', senderSessionId: child.id },
  }
  const subagents = {
    reportFrom() {
      parent.followup(report)
      return Promise.resolve(report.id)
    },
    notifySettlement() {
      parent.followup(settlement)
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent } })
  apply(ctx)

  await subagents.reportFrom(child, [], { delivery: 'wakeup' })
  parent.cancel({ kind: 'user' }, { keepInbox: true })
  await new Promise(resolve => setImmediate(resolve))
  subagents.notifySettlement({ childId: child.id, parentSession: 'parent-session' }, {})

  assert.equal(parent.status, 'idle')
  assert.deepEqual(routes, [{ route: 'inject', message: settlement }])
})

test('[version-sensitive: DSH rc.6 continuation settlement seam] unrelated turn may claim context without expiring retained child state', async () => {
  const abort = new AbortController()
  const claimBatches = []
  const nextStep = []
  const nextTurn = []
  const inbox = { nextStep, nextTurn }
  const parent = runningParent({
    phase: { kind: 'running', turn: 1, abort },
    inbox,
    steer(message) {
      nextStep.push(message)
    },
    inject(message) {
      nextStep.push(message)
    },
    followup(message) {
      nextTurn.push(message)
      claimBatches.push([
        ...nextStep.splice(0),
        nextTurn.shift(),
      ].map(claimed => claimed.id))
    },
    cancel(cause) {
      publishUserCancelledIdle(this, abort, cause)
    },
    whenIdle() {
      return Promise.resolve()
    },
  })
  const retainedChild = { id: 'retained-child', session: { header: { parentSession: 'parent-session' } } }
  const report = {
    id: 'report-retained-child',
    source: { kind: 'subagent-report', senderSessionId: retainedChild.id },
  }
  const subagents = {
    reportFrom() {
      parent.followup(report)
      return Promise.resolve(report.id)
    },
    notifySettlement(activation) {
      parent.followup({
        id: `settlement-${activation.childId}`,
        source: { kind: 'subagent-settled', senderSessionId: activation.childId },
      })
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
  apply(ctx)

  await subagents.reportFrom(retainedChild, [], { delivery: 'wakeup' })
  parent.cancel({ kind: 'user' }, { keepInbox: true })
  subagents.notifySettlement({ childId: retainedChild.id, parentSession: 'parent-session' }, {})
  subagents.notifySettlement({ childId: 'other-child', parentSession: 'parent-session' }, {})

  assert.deepEqual(claimBatches, [[
    'report-retained-child',
    'settlement-retained-child',
    'settlement-other-child',
  ]])
  assert.deepEqual(nextStep, [])

  subagents.notifySettlement({ childId: retainedChild.id, parentSession: 'parent-session' }, {})
  assert.deepEqual(nextStep.map(message => message.id), ['settlement-retained-child'])
  parent.followup({ id: 'recovery-prompt', source: { kind: 'user' } })
  assert.deepEqual(claimBatches, [
    ['report-retained-child', 'settlement-retained-child', 'settlement-other-child'],
    ['settlement-retained-child', 'recovery-prompt'],
  ])
})

test('[version-sensitive: DSH rc.6 explicit-user-prompt seam] successful followup or steer expires stopped retention', async () => {
  for (const promptRoute of ['followup', 'steer']) {
    const abort = new AbortController()
    const routes = []
    const parent = runningParent({
      phase: { kind: 'running', turn: 1, abort },
      followup(message) {
        routes.push({ route: 'followup', message })
        return 'followup-result'
      },
      steer(message) {
        routes.push({ route: 'steer', message })
        this.inbox.nextStep.push(message)
        return 'steer-result'
      },
      inject(message) {
        routes.push({ route: 'inject', message })
        this.inbox.nextStep.push(message)
      },
      cancel(cause) {
        publishUserCancelledIdle(this, abort, cause)
      },
    })
    const child = { id: 'retained-child', session: { header: { parentSession: 'parent-session' } } }
    const report = {
      id: 'report-message',
      source: { kind: 'subagent-report', senderSessionId: child.id },
    }
    const prompt = {
      id: `prompt-${promptRoute}`,
      source: { kind: 'user' },
    }
    const settlement = {
      id: 'settlement-message',
      source: { kind: 'subagent-settled', senderSessionId: child.id },
    }
    const subagents = {
      reportFrom() {
        parent.followup(report)
        return Promise.resolve(report.id)
      },
      notifySettlement() {
        parent.followup(settlement)
      },
    }
    const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
    apply(ctx)

    await subagents.reportFrom(child, [], { delivery: 'wakeup' })
    parent.cancel({ kind: 'user' }, { keepInbox: true })
    routes.length = 0
    const result = parent[promptRoute](prompt)
    subagents.notifySettlement({ childId: child.id, parentSession: 'parent-session' }, {})

    assert.equal(result, `${promptRoute}-result`)
    assert.deepEqual(routes.map(({ route, message }) => [route, message.id]), [
      [promptRoute, `prompt-${promptRoute}`],
      ['followup', 'settlement-message'],
    ])
    ctx.dispose()
  }
})

test('[version-sensitive: DSH rc.6 explicit-user-prompt seam] failed prompt delivery preserves stopped retention', async () => {
  for (const promptRoute of ['followup', 'steer']) {
    const abort = new AbortController()
    const routes = []
    const expected = new Error(`${promptRoute} failed`)
    const parent = runningParent({
      phase: { kind: 'running', turn: 1, abort },
      followup(message) {
        if (message.source?.kind === 'user') throw expected
        routes.push({ route: 'followup', message })
      },
      steer(message) {
        if (message.source?.kind === 'user') throw expected
        routes.push({ route: 'steer', message })
        this.inbox.nextStep.push(message)
      },
      inject(message) {
        routes.push({ route: 'inject', message })
      },
      cancel(cause) {
        publishUserCancelledIdle(this, abort, cause)
      },
    })
    const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
    const report = {
      id: 'retained-report',
      source: { kind: 'subagent-report', senderSessionId: child.id },
    }
    const settlement = {
      id: 'retained-settlement',
      source: { kind: 'subagent-settled', senderSessionId: child.id },
    }
    const subagents = {
      reportFrom() {
        parent.followup(report)
        return Promise.resolve(report.id)
      },
      notifySettlement() {
        parent.followup(settlement)
      },
    }
    const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
    apply(ctx)

    await subagents.reportFrom(child, [], { delivery: 'wakeup' })
    parent.cancel({ kind: 'user' }, { keepInbox: true })
    assert.throws(
      () => parent[promptRoute]({ id: 'failed-prompt', source: { kind: 'user' } }),
      error => error === expected,
    )
    routes.length = 0
    subagents.notifySettlement({ childId: child.id, parentSession: 'parent-session' }, {})

    assert.deepEqual(routes, [{ route: 'inject', message: settlement }])
  }
})

test('[version-sensitive: DSH rc.6 cancellation epoch seam] explicit prompt acknowledges the old aborted driver signal', async () => {
  const abort = new AbortController()
  abort.abort({ kind: 'user' })
  const routes = []
  const parent = runningParent({
    phase: { kind: 'running', turn: 1, abort },
    followup(message) {
      routes.push({ route: 'followup', message })
    },
    steer(message) {
      routes.push({ route: 'steer', message })
      this.inbox.nextStep.push(message)
    },
    inject(message) {
      routes.push({ route: 'inject', message })
      this.inbox.nextStep.push(message)
    },
  })
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const reports = [
    { id: 'old-epoch-report', source: { kind: 'subagent-report', senderSessionId: child.id } },
    { id: 'post-prompt-report', source: { kind: 'subagent-report', senderSessionId: child.id } },
  ]
  let reportIndex = 0
  const subagents = {
    reportFrom() {
      const report = reports[reportIndex]
      reportIndex += 1
      parent.followup(report)
      return Promise.resolve(report.id)
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
  apply(ctx)

  await subagents.reportFrom(child, [], { delivery: 'wakeup' })
  parent.followup({ id: 'recovery-prompt', source: { kind: 'user' } })
  routes.length = 0
  await subagents.reportFrom(child, [], { delivery: 'wakeup' })

  assert.deepEqual(routes, [{ route: 'steer', message: reports[1] }])
})

test('[version-sensitive: DSH rc.6 private seam] tail wake failures are reported loudly without changing accepted report delivery', async () => {
  const idle = Promise.withResolvers()
  const errors = []
  const message = {
    id: 'report-message',
    source: { kind: 'subagent-report', senderSessionId: 'child-session' },
  }
  const parent = runningParent({
    status: 'running',
    inbox: { nextStep: [message] },
    followup() {},
    steer() {},
    whenIdle() {
      return idle.promise
    },
    wakeDriver() {
      throw new Error('wake failed')
    },
  })
  const accepted = Promise.resolve(message.id)
  const subagents = {
    reportFrom() {
      parent.followup(message)
      return accepted
    },
  }
  const ctx = contextWith({
    subagents,
    agents: { get: () => parent },
    logger: { error: error => errors.push(error) },
  })
  apply(ctx)

  const result = subagents.reportFrom(
    { id: 'child-session', session: { header: { parentSession: 'parent-session' } } },
    [],
    { delivery: 'wakeup', signal: new AbortController().signal },
  )
  parent.status = 'idle'
  idle.resolve()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(result, accepted)
  assert.deepEqual(errors, [
    'adaptive subagent report tail wake failed: Error: wake failed',
  ])
})

test('idle wakeup, explicit quiet, and missing-parent reports remain upstream-owned', async () => {
  const calls = []
  const parent = {
    status: 'idle',
    phase: { kind: 'idle', lastTurn: 1 },
    followup() {},
    steer() {
      throw new Error('non-running reports must not steer')
    },
    inject() {},
    cancel() {},
  }
  const subagents = {
    reportFrom(child, content, options) {
      calls.push({ child, content, options })
      return Promise.resolve(calls.length)
    },
  }
  const agents = {
    get(id) {
      return id === 'idle-parent' ? parent : undefined
    },
  }
  const ctx = contextWith({ subagents, agents })
  apply(ctx)

  const quietChild = { session: { header: { parentSession: 'idle-parent' } } }
  const missingChild = { session: { header: { parentSession: 'missing-parent' } } }
  await subagents.reportFrom(quietChild, ['quiet'], { delivery: 'quiet' })
  await subagents.reportFrom(quietChild, ['idle'], { delivery: 'wakeup' })
  await subagents.reportFrom(missingChild, ['missing'], { delivery: 'wakeup' })

  assert.deepEqual(calls.map(call => ({
    parent: call.child.session.header.parentSession,
    content: call.content,
    delivery: call.options.delivery,
  })), [
    { parent: 'idle-parent', content: ['quiet'], delivery: 'quiet' },
    { parent: 'idle-parent', content: ['idle'], delivery: 'wakeup' },
    { parent: 'missing-parent', content: ['missing'], delivery: 'wakeup' },
  ])
})

test('a synchronous upstream rejection restores the running parent method', () => {
  const parent = runningParent()
  const expected = new Error('unauthorized child')
  const subagents = {
    reportFrom() {
      throw expected
    },
  }
  const ctx = contextWith({
    subagents,
    agents: { get: () => parent, list: () => [parent] },
  })
  apply(ctx)
  const instrumentedFollowup = parent.followup

  assert.throws(
    () => subagents.reportFrom(
      { id: 'child-session', session: { header: { parentSession: 'parent-session' } } },
      [],
      { delivery: 'wakeup' },
    ),
    error => error === expected,
  )
  assert.equal(parent.followup, instrumentedFollowup)
})

test('[version-sensitive: DSH rc.6 distribution guard] installation rejects a different AgentLoop release', () => {
  const installDir = mkdtempSync(join(tmpdir(), 'adaptive-report-version-'))
  const packageDir = join(installDir, 'node_modules', '@deepseek-ai', 'dsh-agent-loop')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-agent-loop',
    version: '0.1.0-rc.7',
  }))
  const previousInstallDir = process.env.DSH_INSTALL_DIR
  process.env.DSH_INSTALL_DIR = installDir
  try {
    const ctx = contextWith({
      subagents: { reportFrom() {} },
      agents: { get() {} },
    })
    assert.throws(
      () => apply(ctx),
      /requires @deepseek-ai\/dsh-agent-loop 0\.1\.0-rc\.6; found 0\.1\.0-rc\.7/,
    )
  } finally {
    if (previousInstallDir === undefined) delete process.env.DSH_INSTALL_DIR
    else process.env.DSH_INSTALL_DIR = previousInstallDir
    rmSync(installDir, { recursive: true, force: true })
  }
})

test('[version-sensitive: DSH rc.6 distribution guard] installation rejects malformed discoverable versions', () => {
  const installDir = mkdtempSync(join(tmpdir(), 'adaptive-report-malformed-version-'))
  const packageDir = join(installDir, 'node_modules', '@deepseek-ai', 'dsh-agent-loop')
  const manifestPath = join(packageDir, 'package.json')
  mkdirSync(packageDir, { recursive: true })
  const previousInstallDir = process.env.DSH_INSTALL_DIR
  process.env.DSH_INSTALL_DIR = installDir
  try {
    writeFileSync(manifestPath, 'null')
    assert.throws(
      () => apply(contextWith({
        subagents: { reportFrom() {} },
        agents: { get() {} },
      })),
      /@deepseek-ai\/dsh-agent-loop package manifest must be a JSON object/,
      'null manifest',
    )

    for (const [name, version] of [
      ['missing', undefined],
      ['non-string', 6],
      ['empty', ''],
    ]) {
      const manifest = { name: '@deepseek-ai/dsh-agent-loop' }
      if (version !== undefined) manifest.version = version
      writeFileSync(manifestPath, JSON.stringify(manifest))
      const ctx = contextWith({
        subagents: { reportFrom() {} },
        agents: { get() {} },
      })
      assert.throws(
        () => apply(ctx),
        /@deepseek-ai\/dsh-agent-loop package manifest does not declare a non-empty string version/,
        name,
      )
    }
  } finally {
    if (previousInstallDir === undefined) delete process.env.DSH_INSTALL_DIR
    else process.env.DSH_INSTALL_DIR = previousInstallDir
    rmSync(installDir, { recursive: true, force: true })
  }
})

test('[version-sensitive: DSH rc.6 distribution guard] unresolved AgentLoop discovery fails loudly', () => {
  const previousInstallDir = process.env.DSH_INSTALL_DIR
  const previousArgv1 = process.argv[1]
  delete process.env.DSH_INSTALL_DIR
  try {
    process.argv[1] = undefined
    assert.throws(
      () => apply(contextWith({
        subagents: { reportFrom() {} },
        agents: { get() {} },
        testAgentLoopVersion: false,
      })),
      /cannot discover @deepseek-ai\/dsh-agent-loop: process\.argv\[1\] is unavailable/,
      'absent argv',
    )

    const unresolvedDir = mkdtempSync(join(tmpdir(), 'adaptive-report-unresolved-'))
    try {
      process.argv[1] = join(unresolvedDir, 'runner.mjs')
      assert.throws(
        () => apply(contextWith({
          subagents: { reportFrom() {} },
          agents: { get() {} },
          testAgentLoopVersion: false,
        })),
        /cannot resolve @deepseek-ai\/dsh-agent-loop package manifest from/,
        'resolve failure',
      )
    } finally {
      rmSync(unresolvedDir, { recursive: true, force: true })
    }
  } finally {
    if (previousInstallDir === undefined) delete process.env.DSH_INSTALL_DIR
    else process.env.DSH_INSTALL_DIR = previousInstallDir
    if (previousArgv1 === undefined) delete process.argv[1]
    else process.argv[1] = previousArgv1
  }
})

test('[version-sensitive: DSH rc.6 agent discovery seam] installation rejects missing shapes', () => {
  const subagents = { reportFrom() {} }
  const agentsWithoutList = { get() {} }
  const missingList = contextWith({ subagents, agents: agentsWithoutList })
  delete agentsWithoutList.list
  assert.throws(
    () => apply(missingList),
    /agent discovery seams are unavailable/,
  )

  const agents = { get() {} }
  const missingEvents = contextWith({ subagents: { reportFrom() {} }, agents })
  delete missingEvents.on
  assert.throws(
    () => apply(missingEvents),
    /agent discovery seams are unavailable/,
  )
})

test('[version-sensitive: DSH rc.6 parent shape seam] installation rejects missing retained-delivery or phase shapes', () => {
  const parent = {
    status: 'idle',
    phase: { kind: 'idle', lastTurn: 1 },
    followup() {},
    steer() {},
    cancel() {},
  }
  const ctx = contextWith({
    subagents: { reportFrom() {} },
    agents: { get: () => parent, list: () => [parent] },
  })

  assert.throws(
    () => apply(ctx),
    /delivery and cancellation methods/,
  )

  const missingPhase = runningParent()
  delete missingPhase.phase
  const phaseCtx = contextWith({
    subagents: { reportFrom() {} },
    agents: { get: () => missingPhase, list: () => [missingPhase] },
  })
  assert.throws(
    () => apply(phaseCtx),
    /phase and turn representation/,
  )
})

test('[version-sensitive: DSH rc.6 cancellation seam] running delivery rejects missing shapes', () => {
  const cases = [
    {
      name: 'cancel',
      remove(parent) { delete parent.cancel },
      expected: /delivery and cancellation methods/,
    },
    {
      name: 'inject',
      remove(parent) { delete parent.inject },
      expected: /delivery and cancellation methods/,
    },
    {
      name: 'phase abort signal',
      remove(parent) { parent.phase = { kind: 'running', turn: 1 } },
      expected: /phase and turn representation/,
    },
  ]

  for (const shape of cases) {
    const parent = runningParent()
    shape.remove(parent)
    const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
    const subagents = {
      reportFrom() {
        parent.followup({
          id: 'report-message',
          source: { kind: 'subagent-report', senderSessionId: child.id },
        })
        return Promise.resolve('report-message')
      },
    }
    const ctx = contextWith({ subagents, agents: { get: () => parent } })
    apply(ctx)
    assert.throws(
      () => subagents.reportFrom(child, [], { delivery: 'wakeup' }),
      shape.expected,
      shape.name,
    )
    ctx.dispose()
  }
})

test('[version-sensitive: DSH rc.6 retained-report seam] retained delivery rejects a missing MessageId', async () => {
  const abort = new AbortController()
  let reportCount = 0
  const parent = runningParent({
    phase: { kind: 'running', turn: 1, abort },
    steer(message) {
      this.inbox.nextStep.push(message)
    },
    inject(message) {
      this.inbox.nextStep.push(message)
    },
    cancel(cause) {
      publishUserCancelledIdle(this, abort, cause)
    },
  })
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const subagents = {
    reportFrom() {
      reportCount += 1
      const message = {
        id: reportCount === 1 ? 'accepted-report' : undefined,
        source: { kind: 'subagent-report', senderSessionId: child.id },
      }
      parent.followup(message)
      return Promise.resolve(message.id)
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
  apply(ctx)

  await subagents.reportFrom(child, [], { delivery: 'wakeup' })
  parent.cancel({ kind: 'user' }, { keepInbox: true })

  assert.throws(
    () => subagents.reportFrom(child, [], { delivery: 'wakeup' }),
    /child id or MessageId/,
  )
})

test('[version-sensitive: DSH rc.6 idle wake seam] non-running delivery rejects a missing wakeDriver seam', () => {
  const parent = runningParent({
    status: 'idle',
    phase: { kind: 'idle', lastTurn: 1 },
    inbox: { nextTurn: [] },
  })
  delete parent.wakeDriver
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const subagents = {
    reportFrom() {
      parent.followup({
        id: 'report-message',
        source: { kind: 'subagent-report', senderSessionId: child.id },
      })
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent, list: () => [parent] } })
  apply(ctx)

  assert.throws(
    () => subagents.reportFrom(child, [], { delivery: 'wakeup' }),
    /wakeDriver method/,
  )
})

test('[version-sensitive: DSH rc.6 continuation settlement seam] installation rejects a missing method', () => {
  const subagents = { reportFrom() {} }
  const ctx = contextWith({ subagents, agents: { get() {} } })
  delete subagents.notifySettlement

  assert.throws(
    () => apply(ctx),
    /subagent continuation notifySettlement seam is unavailable/,
  )
})

test('installation rejects an incompatible subagent runtime', () => {
  const ctx = contextWith({
    subagents: {},
    agents: { get() {} },
  })

  assert.throws(
    () => apply(ctx),
    /subagents\.reportFrom is unavailable/,
  )
})
