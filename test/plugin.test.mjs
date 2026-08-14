import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../index.mjs'

function contextWith({ subagents, agents, logger }) {
  let dispose
  return {
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
    dispose() {
      dispose?.()
    },
  }
}

function runningParent(overrides = {}) {
  return {
    status: 'running',
    inbox: { nextStep: [] },
    followup() {},
    steer() {},
    whenIdle() {
      return Promise.resolve()
    },
    wakeDriver() {},
    ...overrides,
  }
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
  const originalFollowup = parent.followup
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
  const agents = { get: id => id === 'parent-session' ? parent : undefined }
  const ctx = contextWith({ subagents, agents })
  apply(ctx)

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
  assert.equal(parent.followup, originalFollowup)
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

test('[DSH rc.6 internal seam] pending routed context wakes once after the exact parent becomes idle', async () => {
  const idle = Promise.withResolvers()
  const nextStep = []
  let wakeCount = 0
  const parent = {
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
  }
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

test('[DSH rc.6 internal seam] tail wake failures are reported loudly without changing accepted report delivery', async () => {
  const idle = Promise.withResolvers()
  const errors = []
  const message = {
    id: 'report-message',
    source: { kind: 'subagent-report', senderSessionId: 'child-session' },
  }
  const parent = {
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
  }
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

test('[DSH rc.6 internal seam] maintenance cancellation retains reports until a later turn', async () => {
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
    ['followup', 'report-2'],
  ])
})

test('idle wakeup, explicit quiet, and missing-parent reports remain upstream-owned', async () => {
  const calls = []
  const parent = {
    status: 'idle',
    followup() {},
    steer() {
      throw new Error('non-running reports must not steer')
    },
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
  const parent = {
    status: 'running',
    inbox: { nextStep: [] },
    followup() {},
    steer() {},
    whenIdle() {
      return Promise.resolve()
    },
    wakeDriver() {},
  }
  const originalFollowup = parent.followup
  const expected = new Error('unauthorized child')
  const subagents = {
    reportFrom() {
      throw expected
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent } })
  apply(ctx)

  assert.throws(
    () => subagents.reportFrom(
      { id: 'child-session', session: { header: { parentSession: 'parent-session' } } },
      [],
      { delivery: 'wakeup' },
    ),
    error => error === expected,
  )
  assert.equal(parent.followup, originalFollowup)
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
