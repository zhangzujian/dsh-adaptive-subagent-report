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

test('a wakeup report to a running parent is delivered through steer in the same acceptance call', async () => {
  const deliveries = []
  const parent = {
    status: 'running',
    followup(message) {
      deliveries.push({ route: 'followup', message })
    },
    steer(message) {
      deliveries.push({ route: 'steer', message })
    },
    inbox: { nextStep: [] },
    whenIdle() {
      return Promise.resolve()
    },
    wakeDriver() {},
  }
  const originalFollowup = parent.followup
  const accepted = Promise.resolve('report-message')
  const subagents = {
    reportFrom(child, content, options) {
      assert.equal(options.delivery, 'wakeup')
      const message = { id: 'report-message', child, content }
      parent.followup(message)
      return accepted
    },
  }
  const agents = { get: id => id === 'parent-session' ? parent : undefined }
  const ctx = contextWith({ subagents, agents })
  apply(ctx)

  const child = { session: { header: { parentSession: 'parent-session' } } }
  const content = [{ type: 'text', text: 'finding' }]
  const signal = new AbortController().signal
  const result = subagents.reportFrom(child, content, { delivery: 'wakeup', signal })

  assert.equal(result, accepted)
  assert.deepEqual(deliveries, [{ route: 'steer', message: { id: 'report-message', child, content } }])
  assert.equal(parent.followup, originalFollowup)
  assert.equal(await result, 'report-message')
})

test('teardown makes a covered wrapper pass through without overwriting the later wrapper', async () => {
  const deliveries = []
  const parent = {
    status: 'running',
    followup(message) {
      deliveries.push({ route: 'followup', message })
    },
    steer(message) {
      deliveries.push({ route: 'steer', message })
    },
    inbox: { nextStep: [] },
    whenIdle() {
      return Promise.resolve()
    },
    wakeDriver() {},
  }
  const subagents = {
    reportFrom(child, content) {
      const message = { id: 'report-message', child, content }
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

  const child = { session: { header: { parentSession: 'parent-session' } } }
  await subagents.reportFrom(child, [], {
    delivery: 'wakeup',
    signal: new AbortController().signal,
  })

  assert.equal(subagents.reportFrom, laterWrapper)
  assert.deepEqual(deliveries, [{
    route: 'followup',
    message: { id: 'report-message', child, content: [] },
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

test('a routed report still pending when the exact parent becomes idle wakes existing context once', async () => {
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
      const message = { id: 'report-message', child, content }
      parent.followup(message)
      return Promise.resolve(message.id)
    },
  }
  const agents = { get: () => parent }
  const ctx = contextWith({ subagents, agents })
  apply(ctx)

  const child = { session: { header: { parentSession: 'parent-session' } } }
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

test('tail wake failures are reported without changing accepted report delivery', async () => {
  const idle = Promise.withResolvers()
  const warnings = []
  const message = { id: 'report-message' }
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
      return accepted
    },
  }
  const ctx = contextWith({
    subagents,
    agents: { get: () => parent },
    logger: { warn: warning => warnings.push(warning) },
  })
  apply(ctx)

  const result = subagents.reportFrom(
    { session: { header: { parentSession: 'parent-session' } } },
    [],
    { delivery: 'wakeup', signal: new AbortController().signal },
  )
  parent.status = 'idle'
  idle.resolve()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(result, accepted)
  assert.deepEqual(warnings, [
    'adaptive subagent report tail wake failed: Error: wake failed',
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
      { session: { header: { parentSession: 'parent-session' } } },
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
