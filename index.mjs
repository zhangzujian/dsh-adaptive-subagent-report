export const name = 'adaptive-subagent-report'
export const inject = ['subagents', 'agents']

const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const INSTALLATION = Symbol.for('@zhangzujian/dsh-adaptive-subagent-report/installation')
const USER_CANCELLED = Object.freeze({ aborted: true, reason: { kind: 'user' } })

function underlying(view) {
  return view?.[CORDIS_ORIGINAL] ?? view
}

function replaceMethod(target, method, replacement) {
  const hadOwn = Object.hasOwn(target, method)
  const descriptor = hadOwn ? Object.getOwnPropertyDescriptor(target, method) : undefined

  Object.defineProperty(target, method, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? false,
    writable: true,
    value: replacement,
  })

  return () => {
    if (target[method] !== replacement) return
    if (hadOwn) Object.defineProperty(target, method, descriptor)
    else delete target[method]
  }
}

function assertParentDeliveryCompatibility(parent) {
  if (typeof parent.followup !== 'function'
    || typeof parent.steer !== 'function'
    || typeof parent.inject !== 'function'
    || typeof parent.cancel !== 'function') {
    throw new Error('agent does not expose the DSH 0.1.0-rc.6 delivery and cancellation methods')
  }
}

function assertParentPhaseCompatibility(parent) {
  const phase = parent.phase
  const hasTurn = phase?.kind === 'running' && Number.isSafeInteger(phase.turn)
  const hasLastTurn = (phase?.kind === 'idle' || phase?.kind === 'maintenance')
    && Number.isSafeInteger(phase.lastTurn)
  const needsAbort = phase?.kind === 'running' || phase?.kind === 'maintenance'
  const hasAbort = !needsAbort || typeof phase.abort?.signal?.addEventListener === 'function'
  if ((!hasTurn && !hasLastTurn) || !hasAbort) {
    throw new Error('agent does not expose the DSH 0.1.0-rc.6 phase and turn representation')
  }
}

function assertRunningParentCompatibility(parent) {
  assertParentDeliveryCompatibility(parent)
  assertParentPhaseCompatibility(parent)
  if (parent.phase.kind !== 'running') {
    throw new Error('running parent does not expose the DSH 0.1.0-rc.6 running phase')
  }
  if (typeof parent.whenIdle !== 'function'
    || !Array.isArray(parent.inbox?.nextStep)
    || typeof parent.wakeDriver !== 'function') {
    throw new Error('running parent does not expose the DSH 0.1.0-rc.6 tail-wake seam')
  }
}

function reportTailWakeFailure(ctx, error) {
  const message = `adaptive subagent report tail wake failed: ${String(error)}`
  if (typeof ctx.logger?.error === 'function') ctx.logger.error(message)
  else process.emitWarning(message, { code: 'DSH_ADAPTIVE_REPORT_TAIL_WAKE_FAILED' })
}

function isUserCancellation(signal) {
  return signal?.aborted === true && signal.reason?.kind === 'user'
}

function armTailWake(ctx, result, parentId, parent, agents, shouldWake) {
  void result.then((messageId) => {
    void parent.whenIdle().then(() => {
      if (!shouldWake()) return
      if (agents.get(parentId) !== parent || parent.status !== 'idle') return
      if (!parent.inbox.nextStep.some(message => message.id === messageId)) return
      parent.wakeDriver()
    }).catch(error => reportTailWakeFailure(ctx, error))
  }, () => {})
}

function armUserStopAwareTailWake(ctx, result, parentId, parent, agents, turnAbort, isActive) {
  armTailWake(ctx, result, parentId, parent, agents, () => (
    isActive() && !isUserCancellation(turnAbort)
  ))
}

function withExactDelivery(parent, methods, matches, deliver, operation) {
  let routed = false
  const restores = methods.map((method) => {
    const original = parent[method]
    return replaceMethod(parent, method, function exactAdaptiveDelivery(message) {
      if (!routed && matches(message)) {
        routed = true
        return deliver(message)
      }
      return original.call(this, message)
    })
  })
  try {
    return operation()
  } finally {
    for (const restore of restores.reverse()) restore()
  }
}

function withExactFollowup(parent, matches, deliver, operation) {
  return withExactDelivery(parent, ['followup'], matches, deliver, operation)
}

function withExactReportFollowup(parent, senderSessionId, turnAbort, operation) {
  return withExactFollowup(parent, message => (
    message?.source?.kind === 'subagent-report'
    && message.source.senderSessionId === senderSessionId
  ), (message) => {
    if (isUserCancellation(turnAbort)) {
      if (typeof parent.inject !== 'function') {
        throw new Error('user-cancelled parent does not expose the expected inject method')
      }
      return parent.inject(message)
    }
    return parent.steer(message)
  }, operation)
}

function currentTurn(parent) {
  return parent.phase?.kind === 'running' ? parent.phase.turn : parent.phase?.lastTurn
}

function observeUserCancellation(signal, parent, stoppedTurns, turn, isActive) {
  const markStopped = () => {
    if (isActive() && turn !== undefined && isUserCancellation(signal)) stoppedTurns.set(parent, turn)
  }
  if (signal?.aborted) markStopped()
  else signal?.addEventListener?.('abort', markStopped, { once: true })
}

function remainsUserStopped(parent, stoppedTurns) {
  const stoppedTurn = stoppedTurns.get(parent)
  if (stoppedTurn === undefined) return false
  const turn = currentTurn(parent)
  if (turn !== undefined && turn > stoppedTurn) {
    stoppedTurns.delete(parent)
    return false
  }
  if (parent.phase?.kind !== 'idle' && isUserCancellation(parent.phase?.abort?.signal)) {
    return true
  }
  return parent.status === 'idle'
}

function instrumentUserCancellation(parent, stoppedTurns, isActive) {
  if (typeof parent.cancel !== 'function') {
    throw new Error('agent does not expose the DSH 0.1.0-rc.6 cancel method')
  }
  const originalCancel = parent.cancel
  return replaceMethod(parent, 'cancel', function trackUserCancellation(cause, options) {
    if (isActive() && cause?.kind === 'user') {
      const turn = currentTurn(parent)
      if (turn !== undefined) stoppedTurns.set(parent, turn)
    }
    return originalCancel.call(this, cause, options)
  })
}

export function apply(ctx) {
  const subagents = underlying(ctx.get('subagents'))
  const agents = underlying(ctx.get('agents'))
  if (subagents[INSTALLATION] !== undefined) {
    throw new Error('adaptive subagent report delivery is already installed')
  }
  if (typeof subagents.reportFrom !== 'function') {
    throw new Error('subagents.reportFrom is unavailable')
  }
  if (typeof agents?.get !== 'function') {
    throw new Error('agents.get is unavailable')
  }
  if (typeof agents.list !== 'function' || typeof ctx.on !== 'function') {
    throw new Error('DSH 0.1.0-rc.6 agent discovery seams are unavailable')
  }
  const original = subagents.reportFrom
  const continuationManager = subagents.continuations ?? subagents
  if (typeof continuationManager.notifySettlement !== 'function') {
    throw new Error('subagent continuation notifySettlement seam is unavailable')
  }
  const originalNotifySettlement = continuationManager.notifySettlement
  const stoppedTurns = new WeakMap()
  const instrumented = new WeakSet()
  const cancelRestores = new Set()
  let active = true
  const instrument = (parent) => {
    if (!active || parent === undefined || instrumented.has(parent)) return
    assertParentDeliveryCompatibility(parent)
    assertParentPhaseCompatibility(parent)
    const restore = instrumentUserCancellation(parent, stoppedTurns, () => active)
    instrumented.add(parent)
    cancelRestores.add(restore)
  }
  const patched = function adaptiveReportFrom(child, content, options) {
    if (!active || options.delivery !== 'wakeup') {
      return original.call(subagents, child, content, options)
    }

    const parentId = child?.session?.header?.parentSession
    const parent = parentId === undefined ? undefined : agents.get(parentId)
    if (parent === undefined) {
      return original.call(subagents, child, content, options)
    }

    instrument(parent)
    if (remainsUserStopped(parent, stoppedTurns)) {
      return withExactReportFollowup(parent, child.id, USER_CANCELLED, () => (
        original.call(subagents, child, content, options)
      ))
    }
    if (parent.status !== 'running') {
      return original.call(subagents, child, content, options)
    }

    assertRunningParentCompatibility(parent)
    const turnAbort = parent.phase?.abort?.signal
    observeUserCancellation(turnAbort, parent, stoppedTurns, currentTurn(parent), () => active)
    const result = withExactReportFollowup(parent, child.id, turnAbort, () => original.call(subagents, child, content, options))
    armUserStopAwareTailWake(ctx, result, parentId, parent, agents, turnAbort, () => active)
    return result
  }

  const patchedNotifySettlement = function adaptiveNotifySettlement(activation, terminal) {
    if (!active) return originalNotifySettlement.call(continuationManager, activation, terminal)
    const parent = agents.get(activation.parentSession)
    if (parent === undefined) {
      return originalNotifySettlement.call(continuationManager, activation, terminal)
    }
    instrument(parent)
    if (!remainsUserStopped(parent, stoppedTurns)) {
      return originalNotifySettlement.call(continuationManager, activation, terminal)
    }
    return withExactDelivery(parent, ['followup', 'steer'], message => (
      message?.source?.kind === 'subagent-settled'
      && message.source.senderSessionId === activation.childId
    ), message => parent.inject(message), () => (
      originalNotifySettlement.call(continuationManager, activation, terminal)
    ))
  }

  ctx.effect(() => {
    const installation = { patched, patchedNotifySettlement }
    Object.defineProperty(subagents, INSTALLATION, {
      configurable: true,
      value: installation,
    })
    const restores = []
    let removeCreatedListener
    try {
      restores.push(replaceMethod(subagents, 'reportFrom', patched))
      restores.push(replaceMethod(continuationManager, 'notifySettlement', patchedNotifySettlement))
      for (const parent of agents.list()) instrument(parent)
      removeCreatedListener = ctx.on('agent/created', ({ agent }) => instrument(agent))
    } catch (error) {
      for (const restore of restores.reverse()) restore()
      for (const restore of cancelRestores) restore()
      delete subagents[INSTALLATION]
      throw error
    }
    return () => {
      active = false
      removeCreatedListener?.()
      for (const restore of [...cancelRestores].reverse()) restore()
      for (const restore of restores.reverse()) restore()
      if (subagents[INSTALLATION] === installation) delete subagents[INSTALLATION]
    }
  }, 'adaptive subagent report delivery teardown')
}
