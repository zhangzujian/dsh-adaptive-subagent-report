import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

export const name = 'adaptive-subagent-report'
export const inject = ['subagents', 'agents']

const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const INSTALLATION = Symbol.for('@zhangzujian/dsh-adaptive-subagent-report/installation')
const TEST_AGENT_LOOP_VERSION = Symbol.for('@zhangzujian/dsh-adaptive-subagent-report/test-agent-loop-version')
const SUPPORTED_AGENT_LOOP_VERSION = '0.1.0-rc.6'
const USER_CANCELLED = Object.freeze({ aborted: true, reason: { kind: 'user' } })
const EXACT_INTERCEPTION_DEPTHS = new WeakMap()

function requireNonEmptyPackageVersion(packageName, version) {
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw new Error(`${packageName} package manifest does not declare a non-empty string version`)
  }
  return version
}

function installedPackageVersion(packageName, ctx) {
  let manifestPath
  if (process.env.DSH_INSTALL_DIR !== undefined) {
    manifestPath = join(process.env.DSH_INSTALL_DIR, 'node_modules', ...packageName.split('/'), 'package.json')
  } else if (process.env.NODE_TEST_CONTEXT !== undefined && Object.hasOwn(ctx, TEST_AGENT_LOOP_VERSION)) {
    return requireNonEmptyPackageVersion(packageName, ctx[TEST_AGENT_LOOP_VERSION])
  } else {
    if (process.argv[1] === undefined) {
      throw new Error(`cannot discover ${packageName}: process.argv[1] is unavailable`)
    }
    try {
      manifestPath = createRequire(process.argv[1]).resolve(`${packageName}/package.json`)
    } catch (error) {
      throw new Error(`cannot resolve ${packageName} package manifest from ${process.argv[1]}: ${String(error)}`)
    }
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`cannot validate ${packageName} for the DSH rc.6 private seam: ${String(error)}`)
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${packageName} package manifest must be a JSON object`)
  }
  return requireNonEmptyPackageVersion(packageName, manifest.version)
}

function assertSupportedAgentLoopVersion(ctx) {
  const version = installedPackageVersion('@deepseek-ai/dsh-agent-loop', ctx)
  if (version !== SUPPORTED_AGENT_LOOP_VERSION) {
    throw new Error(
      `adaptive subagent report requires @deepseek-ai/dsh-agent-loop ${SUPPORTED_AGENT_LOOP_VERSION}; found ${version}`,
    )
  }
}

function originalCordisService(view) {
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

  const targetRef = new WeakRef(target)
  return () => {
    const currentTarget = targetRef.deref()
    if (currentTarget === undefined || currentTarget[method] !== replacement) return
    if (hadOwn) Object.defineProperty(currentTarget, method, descriptor)
    else delete currentTarget[method]
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

function armUserStopAwareTailWake(
  ctx,
  result,
  parentId,
  parent,
  agents,
  turnAbort,
  retention,
  isActive,
) {
  armTailWake(ctx, result, parentId, parent, agents, () => (
    isActive()
    && !isUserCancellation(turnAbort)
    && !retention.isStopped(parent)
  ))
}

function withExactDelivery(
  parent,
  methods,
  matches,
  deliver,
  operation,
  afterRestore = () => {},
  isInstallationActive = () => true,
) {
  let active = true
  let routed = false
  const restores = []
  EXACT_INTERCEPTION_DEPTHS.set(parent, (EXACT_INTERCEPTION_DEPTHS.get(parent) ?? 0) + 1)
  const finishInterception = () => {
    active = false
    for (const restore of restores.reverse()) restore()
    const remainingDepth = (EXACT_INTERCEPTION_DEPTHS.get(parent) ?? 1) - 1
    if (remainingDepth === 0) {
      EXACT_INTERCEPTION_DEPTHS.delete(parent)
      afterRestore()
    } else {
      EXACT_INTERCEPTION_DEPTHS.set(parent, remainingDepth)
    }
  }
  try {
    for (const method of methods) {
      const original = parent[method]
      restores.push(replaceMethod(parent, method, function exactAdaptiveDelivery(message) {
        if (!active || !isInstallationActive()) return original.call(this, message)
        if (!routed && matches(message)) {
          routed = true
          return deliver(message, original, this)
        }
        return original.call(this, message)
      }))
    }
  } catch (error) {
    finishInterception()
    throw error
  }
  try {
    return operation()
  } finally {
    finishInterception()
  }
}

function withExactFollowup(
  parent,
  matches,
  deliver,
  operation,
  afterRestore,
  isInstallationActive,
) {
  return withExactDelivery(
    parent,
    ['followup'],
    matches,
    deliver,
    operation,
    afterRestore,
    isInstallationActive,
  )
}

const matchesReportFrom = senderSessionId => message => (
  message?.source?.kind === 'subagent-report'
  && message.source.senderSessionId === senderSessionId
)

function withExactReportFollowup(
  parent,
  senderSessionId,
  turnAbort,
  onDelivered,
  operation,
  afterRestore,
  isInstallationActive,
) {
  return withExactFollowup(parent, matchesReportFrom(senderSessionId), (message) => {
    if (isUserCancellation(turnAbort)) {
      if (typeof parent.inject !== 'function') {
        throw new Error('user-cancelled parent does not expose the expected inject method')
      }
      const result = parent.inject(message)
      onDelivered(message, true)
      return result
    }
    const transaction = onDelivered(message, false)
    let result
    try {
      result = parent.steer(message)
    } catch (error) {
      transaction?.rollback?.()
      throw error
    }
    transaction?.commit?.()
    return result
  }, operation, afterRestore, isInstallationActive)
}

function withRecordedReportFollowup(
  parent,
  senderSessionId,
  onDelivered,
  operation,
  afterRestore,
  isInstallationActive,
) {
  return withExactFollowup(parent, matchesReportFrom(senderSessionId), (message, original, receiver) => {
    const transaction = onDelivered(message)
    let wakeDriverActive = true
    let restoreWakeDriver
    let result
    try {
      if (typeof parent.wakeDriver !== 'function') {
        throw new Error('agent does not expose the DSH 0.1.0-rc.6 wakeDriver method')
      }
      const originalWakeDriver = parent.wakeDriver
      restoreWakeDriver = replaceMethod(parent, 'wakeDriver', function suppressRetainedWake(...args) {
        if (!wakeDriverActive) return Reflect.apply(originalWakeDriver, this, args)
        if (transaction.isRetained()) return undefined
        return Reflect.apply(originalWakeDriver, this, args)
      })
      result = Reflect.apply(original, receiver, [message])
    } catch (error) {
      wakeDriverActive = false
      restoreWakeDriver?.()
      transaction.rollback()
      throw error
    }
    wakeDriverActive = false
    restoreWakeDriver?.()
    transaction.commit()
    return result
  }, operation, afterRestore, isInstallationActive)
}

function currentTurn(parent) {
  return parent.phase?.kind === 'running' ? parent.phase.turn : parent.phase?.lastTurn
}

function createRetentionState() {
  const stoppedTurns = new WeakMap()
  const acceptedReports = new WeakMap()
  const retainedReports = new WeakMap()
  const inFlightReports = new WeakMap()
  const acknowledgedCancellationSignals = new WeakMap()

  const retainedReportsByChild = (parent) => {
    const existing = retainedReports.get(parent)
    if (existing !== undefined) return existing
    const reportsByChild = new Map()
    retainedReports.set(parent, reportsByChild)
    return reportsByChild
  }
  const retain = (parent, childId, messageId) => {
    if (childId === undefined || messageId === undefined) {
      throw new Error('retained subagent delivery is missing an rc.6 child id or MessageId')
    }
    const reportsByChild = retainedReportsByChild(parent)
    let messageIds = reportsByChild.get(childId)
    if (messageIds === undefined) {
      messageIds = new Set()
      reportsByChild.set(childId, messageIds)
    }
    messageIds.add(messageId)
  }
  const removeAccepted = (parent, messageId) => {
    const reports = acceptedReports.get(parent)
    if (reports === undefined) return
    reports.delete(messageId)
    if (reports.size === 0) acceptedReports.delete(parent)
  }
  const removeRetained = (parent, childId, messageId) => {
    const reportsByChild = retainedReports.get(parent)
    const messageIds = reportsByChild?.get(childId)
    if (messageIds === undefined) return
    messageIds.delete(messageId)
    if (messageIds.size === 0) reportsByChild.delete(childId)
    if (reportsByChild.size === 0) retainedReports.delete(parent)
  }
  const clearInFlight = (parent, messageId) => {
    const messageIds = inFlightReports.get(parent)
    if (messageIds === undefined) return
    messageIds.delete(messageId)
    if (messageIds.size === 0) inFlightReports.delete(parent)
  }
  const retainAcceptedPending = (parent) => {
    const reports = acceptedReports.get(parent)
    if (reports === undefined) return
    const pendingQueues = ['nextStep', 'nextTurn'].map((queueName) => {
      const queue = parent.inbox?.[queueName]
      if (!Array.isArray(queue)) {
        throw new Error(`agent inbox does not expose the DSH 0.1.0-rc.6 ${queueName} array`)
      }
      return queue
    })
    const pendingIds = new Set(pendingQueues.flatMap(queue => queue.map(message => message.id)))
    const inFlightIds = inFlightReports.get(parent)
    for (const [messageId, reportState] of reports) {
      if (pendingIds.has(messageId) || inFlightIds?.has(messageId)) {
        retain(parent, reportState.childId, messageId)
        if (reportState.maintenancePhase !== undefined
          && reportState.wakeRequestedBefore === false) {
          reportState.maintenancePhase.wakeRequested = false
        }
      }
    }
    acceptedReports.delete(parent)
  }

  return {
    isStopped: parent => stoppedTurns.has(parent),
    isCancellationAcknowledged: (parent, signal) => (
      acknowledgedCancellationSignals.get(parent) === signal
    ),
    hasRetainedChild: (parent, childId) => (
      (retainedReports.get(parent)?.get(childId)?.size ?? 0) > 0
    ),
    retain,
    recordCancellation(parent, turn) {
      stoppedTurns.set(parent, turn)
      retainAcceptedPending(parent)
    },
    observeCancellation(signal, parent, turn, isActive) {
      const markStopped = () => {
        if (isActive()
          && turn !== undefined
          && !this.isCancellationAcknowledged(parent, signal)
          && isUserCancellation(signal)) {
          this.recordCancellation(parent, turn)
        }
      }
      if (signal?.aborted) markStopped()
      else signal?.addEventListener?.('abort', markStopped, { once: true })
    },
    expire(parent, signal) {
      if (signal !== undefined) acknowledgedCancellationSignals.set(parent, signal)
      stoppedTurns.delete(parent)
      acceptedReports.delete(parent)
      retainedReports.delete(parent)
    },
    begin(parent, childId, messageId) {
      const maintenancePhase = parent.phase?.kind === 'maintenance' ? parent.phase : undefined
      const hadWakeRequested = maintenancePhase === undefined
        ? false
        : Object.hasOwn(maintenancePhase, 'wakeRequested')
      const wakeRequestedBefore = maintenancePhase?.wakeRequested
      let reports = acceptedReports.get(parent)
      if (reports === undefined) {
        reports = new Map()
        acceptedReports.set(parent, reports)
      }
      reports.set(messageId, { childId, maintenancePhase, wakeRequestedBefore })
      let inFlightIds = inFlightReports.get(parent)
      if (inFlightIds === undefined) {
        inFlightIds = new Set()
        inFlightReports.set(parent, inFlightIds)
      }
      inFlightIds.add(messageId)
      return {
        isRetained: () => retainedReports.get(parent)?.get(childId)?.has(messageId) ?? false,
        commit: () => {
          clearInFlight(parent, messageId)
          if (!retainedReports.get(parent)?.get(childId)?.has(messageId)) return
          if (parent.phase === maintenancePhase && wakeRequestedBefore === false) {
            maintenancePhase.wakeRequested = false
          } else if (parent.status === 'running') {
            parent.cancel({ kind: 'user' }, { keepInbox: true })
          }
        },
        rollback: () => {
          clearInFlight(parent, messageId)
          removeAccepted(parent, messageId)
          removeRetained(parent, childId, messageId)
          if (parent.phase === maintenancePhase) {
            if (hadWakeRequested) maintenancePhase.wakeRequested = wakeRequestedBefore
            else delete maintenancePhase.wakeRequested
          }
        },
      }
    },
  }
}

function instrumentUserCancellation(parent, retention, isActive) {
  if (typeof parent.cancel !== 'function') {
    throw new Error('agent does not expose the DSH 0.1.0-rc.6 cancel method')
  }
  const originalCancel = parent.cancel
  return replaceMethod(parent, 'cancel', function trackUserCancellation(cause, options) {
    if (isActive() && cause?.kind === 'user') {
      const turn = currentTurn(parent)
      if (turn !== undefined) retention.recordCancellation(parent, turn)
    }
    return originalCancel.call(this, cause, options)
  })
}

function instrumentUserPromptDelivery(parent, retention, isActive) {
  const restores = []
  try {
    for (const method of ['followup', 'steer']) {
      const original = parent[method]
      restores.push(replaceMethod(parent, method, function observeExplicitUserPrompt(message) {
        const isUserPrompt = isActive() && message?.source?.kind === 'user'
        const result = original.call(this, message)
        if (isUserPrompt && retention.isStopped(parent)) {
          retention.expire(parent, parent.phase?.abort?.signal)
        }
        return result
      }))
    }
  } catch (error) {
    for (const restore of restores.reverse()) restore()
    throw error
  }
  return restores
}

export function apply(ctx) {
  assertSupportedAgentLoopVersion(ctx)
  const subagents = originalCordisService(ctx.get('subagents'))
  const agents = originalCordisService(ctx.get('agents'))
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
  const retention = createRetentionState()
  const instrumented = new WeakSet()
  const parentActivity = new WeakMap()
  const parentRestores = new Set()
  const parentRestoresByParent = new WeakMap()
  const restoreInstrumentedParent = (parent) => {
    const activity = parentActivity.get(parent)
    if (activity !== undefined) activity.active = false
    if ((EXACT_INTERCEPTION_DEPTHS.get(parent) ?? 0) > 0) return
    const restores = parentRestoresByParent.get(parent)
    if (restores === undefined) return
    for (const restore of [...restores].reverse()) {
      restore()
      parentRestores.delete(restore)
    }
    parentRestoresByParent.delete(parent)
    parentActivity.delete(parent)
    instrumented.delete(parent)
  }
  let active = true
  const instrument = (parent) => {
    if (!active || parent === undefined || instrumented.has(parent)) return
    assertParentDeliveryCompatibility(parent)
    assertParentPhaseCompatibility(parent)
    const activity = { active: true }
    const isParentActive = () => active && activity.active
    const restores = []
    try {
      restores.push(instrumentUserCancellation(parent, retention, isParentActive))
      restores.push(...instrumentUserPromptDelivery(parent, retention, isParentActive))
      instrumented.add(parent)
      parentActivity.set(parent, activity)
      parentRestoresByParent.set(parent, restores)
      for (const restore of restores) parentRestores.add(restore)
    } catch (error) {
      activity.active = false
      for (const restore of restores.reverse()) restore()
      throw error
    }
  }
  const interceptionLifecycle = parent => ({
    afterRestore() {
      if (!active || parentActivity.get(parent)?.active === false) {
        restoreInstrumentedParent(parent)
      }
    },
    isActive() {
      return active && parentActivity.get(parent)?.active !== false
    },
  })
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
    const lifecycle = interceptionLifecycle(parent)
    if (retention.isStopped(parent)) {
      return withExactReportFollowup(
        parent,
        child.id,
        USER_CANCELLED,
        message => retention.retain(parent, child.id, message.id),
        () => original.call(subagents, child, content, options),
        lifecycle.afterRestore,
        lifecycle.isActive,
      )
    }
    if (parent.status !== 'running') {
      return withRecordedReportFollowup(
        parent,
        child.id,
        message => retention.begin(parent, child.id, message.id),
        () => original.call(subagents, child, content, options),
        lifecycle.afterRestore,
        lifecycle.isActive,
      )
    }

    assertRunningParentCompatibility(parent)
    const turn = currentTurn(parent)
    const turnAbort = parent.phase?.abort?.signal
    const effectiveTurnAbort = retention.isCancellationAcknowledged(parent, turnAbort)
      ? undefined
      : turnAbort
    retention.observeCancellation(effectiveTurnAbort, parent, turn, () => active)
    const result = withExactReportFollowup(
      parent,
      child.id,
      effectiveTurnAbort,
      (message, retained) => {
        if (retained) {
          retention.retain(parent, child.id, message.id)
          return undefined
        }
        return retention.begin(parent, child.id, message.id)
      },
      () => original.call(subagents, child, content, options),
      lifecycle.afterRestore,
      lifecycle.isActive,
    )
    armUserStopAwareTailWake(
      ctx,
      result,
      parentId,
      parent,
      agents,
      effectiveTurnAbort,
      retention,
      () => active,
    )
    return result
  }

  const patchedNotifySettlement = function adaptiveNotifySettlement(activation, terminal) {
    if (!active) return originalNotifySettlement.call(continuationManager, activation, terminal)
    const parent = agents.get(activation.parentSession)
    if (parent === undefined) {
      return originalNotifySettlement.call(continuationManager, activation, terminal)
    }
    instrument(parent)
    const lifecycle = interceptionLifecycle(parent)
    if (!retention.isStopped(parent)) {
      return originalNotifySettlement.call(continuationManager, activation, terminal)
    }
    if (!retention.hasRetainedChild(parent, activation.childId)) {
      return originalNotifySettlement.call(continuationManager, activation, terminal)
    }
    return withExactDelivery(parent, ['followup', 'steer'], message => (
      message?.source?.kind === 'subagent-settled'
      && message.source.senderSessionId === activation.childId
    ), (message) => {
      const result = parent.inject(message)
      retention.retain(parent, activation.childId, message.id)
      return result
    }, () => (
      originalNotifySettlement.call(continuationManager, activation, terminal)
    ), lifecycle.afterRestore, lifecycle.isActive)
  }

  ctx.effect(() => {
    const installation = { patched, patchedNotifySettlement }
    Object.defineProperty(subagents, INSTALLATION, {
      configurable: true,
      value: installation,
    })
    const restores = []
    let removeCreatedListener
    let removeDisposedListener
    try {
      restores.push(replaceMethod(subagents, 'reportFrom', patched))
      restores.push(replaceMethod(continuationManager, 'notifySettlement', patchedNotifySettlement))
      for (const parent of agents.list()) instrument(parent)
      removeCreatedListener = ctx.on('agent/created', ({ agent }) => instrument(agent))
      removeDisposedListener = ctx.on('agent/disposed', ({ agent }) => restoreInstrumentedParent(agent))
    } catch (error) {
      removeDisposedListener?.()
      removeCreatedListener?.()
      for (const restore of restores.reverse()) restore()
      for (const restore of parentRestores) restore()
      parentRestores.clear()
      delete subagents[INSTALLATION]
      throw error
    }
    return () => {
      active = false
      removeDisposedListener?.()
      removeCreatedListener?.()
      for (const restore of [...parentRestores].reverse()) restore()
      parentRestores.clear()
      for (const restore of restores.reverse()) restore()
      if (subagents[INSTALLATION] === installation) delete subagents[INSTALLATION]
    }
  }, 'adaptive subagent report delivery teardown')
}
