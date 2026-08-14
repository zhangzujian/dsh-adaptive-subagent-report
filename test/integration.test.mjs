import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { before, describe, it } from 'node:test'

import * as plugin from '../index.mjs'

const installDir = process.env.DSH_INSTALL_DIR
const integration = installDir === undefined ? describe.skip : describe

async function packageImport(name) {
  return import(pathToFileURL(join(
    installDir,
    'node_modules',
    '@deepseek-ai',
    name,
    'lib',
    'index.js',
  )).href)
}

integration('DSH 0.1.0-rc.6 Cordis integration', () => {
  let Context
  let Service

  before(async () => {
    ;({ Context, Service } = await packageImport('cordis'))
  })

  it('installs through real Cordis service views and restores the prototype method', async () => {
    const deliveries = []
    const abort = new AbortController()
    const parent = {
      status: 'running',
      phase: { kind: 'running', turn: 1, abort },
      inbox: { nextStep: [] },
      followup(message) {
        deliveries.push({ route: 'followup', message })
      },
      steer(message) {
        deliveries.push({ route: 'steer', message })
      },
      inject(message) {
        deliveries.push({ route: 'inject', message })
      },
      cancel(cause) {
        abort.abort(cause)
        this.phase = { kind: 'idle', lastTurn: 1 }
        this.status = 'idle'
      },
      whenIdle() {
        return Promise.resolve()
      },
      wakeDriver() {},
    }

    class Subagents extends Service {
      constructor(ctx) {
        super(ctx, 'subagents')
        this.continuations = {
          notifySettlement(activation) {
            parent.followup({
              id: 'settlement-message',
              source: { kind: 'subagent-settled', senderSessionId: activation.childId },
            })
          },
        }
      }

      reportFrom(child, content) {
        const message = {
          id: 'report-message',
          child,
          content,
          source: { kind: 'subagent-report', senderSessionId: child.id },
        }
        parent.followup(message)
        return Promise.resolve(message.id)
      }

    }

    class Agents extends Service {
      constructor(ctx) {
        super(ctx, 'agents')
      }

      get(id) {
        return id === 'parent-session' ? parent : undefined
      }

      list() {
        return [parent]
      }
    }

    const ctx = new Context()
    await ctx.plugin(Subagents)
    await ctx.plugin(Agents)
    const pluginFiber = await ctx.plugin(plugin)

    const child = { id: 'child-session', session: { header: { parentSession: 'parent-session' } } }
    await ctx.subagents.reportFrom(child, [{ type: 'text', text: 'finding' }], {
      delivery: 'wakeup',
      signal: new AbortController().signal,
    })
    assert.equal(deliveries.at(-1).route, 'steer')

    parent.cancel({ kind: 'user' }, { keepInbox: true })
    ctx.subagents.continuations.notifySettlement({ childId: child.id, parentSession: 'parent-session' }, {})
    assert.equal(parent.status, 'idle')
    assert.equal(deliveries.at(-1).route, 'inject')

    await pluginFiber.dispose()

    await ctx.subagents.reportFrom(child, [], {
      delivery: 'wakeup',
      signal: new AbortController().signal,
    })
    assert.equal(deliveries.at(-1).route, 'followup')
    await ctx.fiber.dispose()
  })
})
