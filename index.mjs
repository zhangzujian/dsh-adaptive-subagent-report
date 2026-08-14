export const name = 'adaptive-subagent-report'
export const inject = ['subagents', 'agents']

const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const INSTALLATION = Symbol.for('@zhangzujian/dsh-adaptive-subagent-report/installation')

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

function assertRunningParentCompatibility(parent) {
  if (typeof parent.followup !== 'function' || typeof parent.steer !== 'function') {
    throw new Error('running parent does not expose the expected followup and steer methods')
  }
  if (typeof parent.whenIdle !== 'function'
    || !Array.isArray(parent.inbox?.nextStep)
    || typeof parent.wakeDriver !== 'function') {
    throw new Error('running parent does not expose the DSH 0.1.0-rc.6 tail-wake seam')
  }
}

function warn(ctx, error) {
  ctx.logger?.warn?.(`adaptive subagent report tail wake failed: ${String(error)}`)
}

function armTailWake(ctx, result, parentId, parent, agents, isActive) {
  void result.then((messageId) => {
    void parent.whenIdle().then(() => {
      if (!isActive()) return
      if (agents.get(parentId) !== parent || parent.status !== 'idle') return
      if (!parent.inbox.nextStep.some(message => message.id === messageId)) return
      parent.wakeDriver()
    }).catch(error => warn(ctx, error))
  }, () => {})
}

function withTemporaryFollowup(parent, operation) {
  const restore = replaceMethod(parent, 'followup', function reportFollowupAsSteer(message) {
    return parent.steer(message)
  })
  try {
    return operation()
  } finally {
    restore()
  }
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
  const original = subagents.reportFrom
  let active = true
  const patched = function adaptiveReportFrom(child, content, options) {
    if (!active || options.delivery !== 'wakeup') {
      return original.call(subagents, child, content, options)
    }

    const parentId = child?.session?.header?.parentSession
    const parent = parentId === undefined ? undefined : agents.get(parentId)
    if (parent?.status !== 'running') {
      return original.call(subagents, child, content, options)
    }

    assertRunningParentCompatibility(parent)
    const result = withTemporaryFollowup(parent, () => original.call(subagents, child, content, options))
    armTailWake(ctx, result, parentId, parent, agents, () => active)
    return result
  }

  ctx.effect(() => {
    const restore = replaceMethod(subagents, 'reportFrom', patched)
    const installation = { patched }
    Object.defineProperty(subagents, INSTALLATION, {
      configurable: true,
      value: installation,
    })
    return () => {
      active = false
      restore()
      if (subagents[INSTALLATION] === installation) delete subagents[INSTALLATION]
    }
  }, 'adaptive subagent report delivery teardown')
}
