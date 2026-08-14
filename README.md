# dsh-adaptive-subagent-report

A Host-plane Cordis compatibility plugin for DeepSeek Harness `0.1.0-rc.6`.

Continuable Background subagents report through `parent.followup()` by default. A parent whose current turn runs for a long time cannot claim those next-turn messages, so the queue grows even though the parent keeps working. This plugin makes wakeup report delivery state-aware:

- idle parent: keep the original `followup()` wakeup;
- running parent: preserve the original report service and waking accounting, but route that report send through `steer()` so it enters `next-step` context;
- terminal driver gap: if the accepted report is still pending after the exact parent becomes idle, wake the existing context without inserting a second report.

## Compatibility

The implementation deliberately targets exactly:

- `@deepseek-ai/dsh-agent@0.1.0-rc.6`
- `@deepseek-ai/dsh-subagent@0.1.0-rc.6`
- `@deepseek-ai/cordis@4.0.1`
- Node.js 24 or newer

The terminal-gap safeguard uses the rc.6 AgentLoop wake seam after structural validation. An incompatible running Agent fails loudly instead of silently losing the safeguard.

## Installation

Add the package to the DSH profile:

```bash
dsh plugin --profile web add github:zhangzujian/dsh-adaptive-subagent-report
```

Or add a local checkout to `cordis.patch.yml`:

```yaml
- insert:
    - id: adaptive-subagent-report
      name: file:///absolute/path/to/dsh-adaptive-subagent-report/index.mjs?v=0.1.0
```

The plugin injects `subagents` and `agents` and must run in the Host plane. Do not install it inside an agent preset isolate.

## Behavior

| Requested delivery | Parent state | Result |
| --- | --- | --- |
| `quiet` | any | Unchanged upstream quiet delivery |
| `wakeup` | idle | Unchanged upstream followup turn |
| `wakeup` | running | One next-step context message, preserving upstream report identity and accounting |
| `wakeup` | missing parent | Upstream authorization and parent error behavior |

The plugin does not copy report content, create report messages, modify DSH package files, or patch prototypes.

## Verification

```bash
npm test
npm install --no-save --package-lock=false @deepseek-ai/dsh@0.1.0-rc.6
DSH_INSTALL_DIR=$PWD npm run test:integration
npm pack --dry-run
```

Tests cover the agreed public seams documented in [`docs/spec.md`](docs/spec.md): Cordis install/teardown, `reportFrom` routing, and rc.6 integration behavior.

## Removal

Remove the profile entry or package. Teardown disables the policy and restores the previous method when it still owns the seam. Already accepted reports remain owned by DSH and are not removed.

## Long-term direction

This repository is a version-locked compatibility Adapter. The long-term DSH design should add an explicit `adaptive` report delivery policy backed by an Agent runtime primitive that atomically performs context-first delivery with a fallback wake latch.

## License

MIT
