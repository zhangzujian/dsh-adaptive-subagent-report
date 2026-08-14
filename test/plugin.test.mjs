import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../index.mjs'

function contextWith({ subagents, agents, logger }) {
  if (typeof subagents.reportFrom === 'function'
    && typeof subagents.notifySettlement !== 'function'
    && typeof subagents.continuations?.notifySettlement !== 'function') {
    subagents.notifySettlement = () => {}
  }
  if (typeof agents.get === 'function' && typeof agents.list !== 'function') agents.list = () => []
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
    on() {
      return () => {}
    },
    dispose() {
      dispose?.()
    },
  }
}

function runningParent(overrides = {}) {
  const abort = new AbortController()
  return {
    status: 'running',
    phase: { kind: 'running', turn: 1, abort },
    inbox: { nextStep: [] },
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

test('[DSH rc.6 internal seam] user cancellation keeps accepted context idle', async () => {
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

test('[DSH rc.6 internal seam] report arriving after user cancellation is retained without wakeup', async () => {
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
  const subagents = {
    reportFrom() {
      parent.followup(message)
      return Promise.resolve(message.id)
    },
  }
  const ctx = contextWith({ subagents, agents: { get: () => parent } })
  apply(ctx)

  await subagents.reportFrom(child, [], { delivery: 'wakeup' })

  assert.deepEqual(routes, [{ route: 'inject', message }])
  assert.equal(parent.inbox.nextStep.length, 1)
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

test('[DSH rc.6 internal seam] first report after an idle user cancellation does not restart the parent', async () => {
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
      abort.abort(cause)
      this.phase = { kind: 'idle', lastTurn: 1 }
      this.status = 'idle'
    },
  })
  const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
  const message = {
    id: 'report-message',
    source: { kind: 'subagent-report', senderSessionId: child.id },
  }
  const subagents = {
    reportFrom() {
      parent.followup(message)
      return Promise.resolve(message.id)
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

  assert.equal(parent.status, 'idle')
  assert.deepEqual(routes, [{ route: 'inject', message }])
})

test('[DSH rc.6 internal seam] settlement during an aborting user-cancelled turn is retained', async () => {
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

test('[DSH rc.6 internal seam] settlement after user cancellation is retained without wakeup', async () => {
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
      abort.abort(cause)
      this.phase = { kind: 'idle', lastTurn: 1 }
      this.status = 'idle'
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

test('[DSH rc.6 internal seam] tail wake failures are reported loudly without changing accepted report delivery', async () => {
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

test('installation rejects missing rc.6 agent discovery seams', () => {
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

test('installation rejects parents without retained-delivery or phase shapes', () => {
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

test('running delivery rejects missing rc.6 cancellation shapes', () => {
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

test('installation rejects a runtime without the rc.6 settlement seam', () => {
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
