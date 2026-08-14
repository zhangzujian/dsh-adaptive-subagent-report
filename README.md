# dsh-adaptive-subagent-report

A Host-plane Cordis compatibility plugin for DeepSeek Harness `0.1.0-rc.6`.

Continuable Background subagents report through `parent.followup()` by default. A parent whose current turn runs for a long time cannot claim those next-turn messages, so the queue grows even though the parent keeps working. This plugin makes wakeup report delivery state-aware:

- idle parent: keep the original `followup()` wakeup;
- running parent: preserve the original report service and waking accounting, but route that report send through `steer()` so it enters `next-step` context;
- terminal driver gap: if the accepted report is still pending after the exact parent becomes naturally idle, wake the existing context without inserting a second report;
- explicit user stop: record exact successfully delivered report MessageId-to-childId associations, then retain only known IDs still present in the rc.6 pending queues (`nextStep` for running-turn context and `nextTurn` for idle/maintenance context, including their transition overlap) without scanning unrelated source framing; later-arriving reports and only the same successfully retained child's settlement remain pending without restarting the session. Failed `inject()` calls propagate unchanged and do not retain the child. Turn counters and unrelated settlement-driven turns do not expire this state, although an unrelated upstream rc.6 turn may normally claim retained messages that were already pending; only a successful instance-level `followup()` or `steer()` delivery with `source.kind === 'user'` expires the state, allowing that explicit prompt to claim any retained context still pending once.

## Compatibility

The implementation deliberately targets exactly:

- `@deepseek-ai/dsh-agent@0.1.0-rc.6`
- `@deepseek-ai/dsh-agent-loop@0.1.0-rc.6`
- `@deepseek-ai/dsh-subagent@0.1.0-rc.6`
- `@deepseek-ai/cordis@4.0.1`
- Node.js 24 or newer

The terminal-gap and user-stop safeguards use rc.6 AgentLoop phase/cancel/wake seams plus the private continuation-manager settlement seam after structural validation. Installation must discover the AgentLoop manifest through `DSH_INSTALL_DIR` or package resolution anchored at the DSH process entry point, and fails loudly if discovery or a non-empty string version is unavailable. Package metadata also declares the exact rc.6 AgentLoop peer. Unit fixtures have a Node-test-runner-only private version override; production never treats an unresolved version as supported. Local `file:` plugin execution remains supported through the real DSH entry-point resolution path.

## Installation

Add the package to the DSH profile:

```bash
dsh plugin --profile web add github:zhangzujian/dsh-adaptive-subagent-report
```

Or add a local checkout to `cordis.patch.yml`:

```yaml
- insert:
    - id: adaptive-subagent-report
      name: file:///absolute/path/to/dsh-adaptive-subagent-report/index.mjs?v=0.1.1
```

The plugin injects `subagents` and `agents` and must run in the Host plane. Do not install it inside an agent preset isolate.

## Behavior

| Requested delivery | Parent state | Result |
| --- | --- | --- |
| `quiet` | any | Unchanged upstream quiet delivery |
| `wakeup` | idle | Unchanged upstream followup turn |
| `wakeup` | running | One next-step context message, preserving upstream report identity and accounting |
| `wakeup` | user-cancelled | Retained context through `inject`, with no automatic restart |
| `wakeup` | missing parent | Upstream authorization and parent error behavior |

The plugin does not copy report content, create report messages, modify DSH package files, or patch prototypes.

## Verification

```bash
npm test
npm install --no-save --package-lock=false @deepseek-ai/dsh@0.1.0-rc.6
DSH_INSTALL_DIR=$PWD npm run test:integration
npm pack --dry-run

# Against a running DSH web profile with this plugin installed:
npm run test:live
npm run test:live-cancel
```

Tests cover the agreed seams documented in [`docs/spec.md`](docs/spec.md): Cordis install/teardown, exact `reportFrom` routing, child-scoped continuation settlement, and real AgentLoop probes. Every private rc.6 seam test is explicitly labelled `[version-sensitive: DSH rc.6 ...]`. The delivery probe verifies running-parent context and idle-parent wakeup. The cancellation probe stops a parent while report context is pending, requires a bounded stable stopped interval, awaits explicit prompt acceptance, and correlates the subsequent completed turn with that prompt before walking ordered `turn/start`/`turn/end` boundaries with an `openTurn`; this proves the retained report and settlement are each claimed once in the accepted recovery turn and zero times before it. Both live probes require a configured model and are intentionally not part of credential-free GitHub Actions.

## Removal

Remove the profile entry or package. Teardown disables the policy and restores the previous method when it still owns the seam. Already accepted reports remain owned by DSH and are not removed.

## Long-term direction

This repository is a version-locked compatibility Adapter. The long-term DSH design should add an explicit `adaptive` report delivery policy backed by an Agent runtime primitive that atomically performs context-first delivery with a fallback wake latch.

## License

MIT
