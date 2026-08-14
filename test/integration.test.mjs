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
    const parent = {
      status: 'running',
      inbox: { nextStep: [] },
      followup(message) {
        deliveries.push({ route: 'followup', message })
      },
      steer(message) {
        deliveries.push({ route: 'steer', message })
      },
      whenIdle() {
        return Promise.resolve()
      },
      wakeDriver() {},
    }

    class Subagents extends Service {
      constructor(ctx) {
        super(ctx, 'subagents')
      }

      reportFrom(child, content) {
        const message = { id: 'report-message', child, content }
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
    }

    const ctx = new Context()
    await ctx.plugin(Subagents)
    await ctx.plugin(Agents)
    const pluginFiber = await ctx.plugin(plugin)

    const child = { session: { header: { parentSession: 'parent-session' } } }
    await ctx.subagents.reportFrom(child, [{ type: 'text', text: 'finding' }], {
      delivery: 'wakeup',
      signal: new AbortController().signal,
    })
    assert.equal(deliveries.at(-1).route, 'steer')

    await pluginFiber.dispose()

    await ctx.subagents.reportFrom(child, [], {
      delivery: 'wakeup',
      signal: new AbortController().signal,
    })
    assert.equal(deliveries.at(-1).route, 'followup')
    await ctx.fiber.dispose()
  })
})
