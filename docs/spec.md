# Adaptive Subagent Report Delivery Specification

## Problem

DeepSeek Harness 0.1.0-rc.6 configures continuable subagent reports with `reportDelivery: wakeup` by default. The report service sends wakeup reports through `parent.followup()`, placing them in the parent's next-turn inbox. A parent whose current turn runs for a long time cannot claim those reports, so the queue grows while the parent continues working.

## Public seams under test

The implementation is tested at four agreed seams:

1. The Cordis plugin interface: `apply(ctx)` installs one wrapper and teardown restores the prior method without damaging later wrappers.
2. The subagent report interface: `ctx.subagents.reportFrom(child, content, options)` preserves explicit quiet delivery, keeps idle wakeup delivery as followup, and routes running wakeup delivery to next-step context.
3. The continuation settlement interface: settlement wakeup is suppressed only for a child whose report was retained by the same user-stopped parent turn. Tests touching the rc.6 continuation manager implementation are explicitly labelled `[version-sensitive: DSH rc.6 ...]`.
4. The real DSH AgentLoop interface: live probes verify running-parent context delivery, idle-parent wakeup, and that explicit user cancellation retains both report and settlement context without opening an unprompted turn. Before submitting recovery, the cancellation probe requires a bounded stable stopped interval and records the completed history boundary. It sets `recoveryRequested` only after `session.prompt` reports acceptance, then correlates the completed post-boundary running turn with the exact recovery prompt so an automatic wake racing the RPC cannot be accepted as recovery. The final history check proves both retained messages are claimed exactly once in that turn, with no claim before its boundary. Because rc.6 `user/message` history events carry no turn field, the probe walks ordered `turn/start` and matching `turn/end` events while maintaining an `openTurn`; only intervening messages are attributed to that turn, while messages between or after turns remain unscoped and cannot satisfy the recovery assertion. The terminal driver window is additionally covered by explicitly version-sensitive rc.6 seam tests because that production race cannot be scheduled deterministically through the public live interface.

## Required behavior

### Routing

- Explicit `delivery: quiet` is unchanged.
- `delivery: wakeup` with an idle parent uses the original followup path.
- `delivery: wakeup` with a running parent keeps the original report service path and waking accounting, but the one report send is routed to `parent.steer(message)` instead of `parent.followup(message)`.
- Missing parents, unauthorized children, cancellation, activation closing, framing, message identity, and error translation remain owned by the original DSH report service.

### Terminal liveness and user cancellation

DSH 0.1.0-rc.6 has a narrow interval where an Agent still reports `running` after its final turn decision but before the driver publishes `idle`. If a routed report remains in `nextStep` after the parent becomes naturally idle, the plugin must wake that exact live parent without inserting a second report message.

An explicit user cancellation takes precedence over report wakeup, including cancellation after idle publication but before a pending tail callback runs. At the temporary exact report-delivery interception, the plugin records the successfully delivered report's exact MessageId-to-childId association. On user cancellation it compares MessageIds from the rc.6 pending queues (`nextStep` for running-turn context and `nextTurn` for idle or maintenance context, including their transition overlap) only with those known associations; it never scans unrelated messages' source framing. A known accepted report that is still pending remains without tail wake, and a report arriving after cancellation is injected as retained context without starting another turn. The child is recorded as retained only after `parent.inject(message)` returns successfully; an inject failure propagates unchanged and must not cause the child's later settlement to be suppressed. A settlement notice from the same successfully retained continuable child is likewise retained without wakeup while the parent remains stopped; another child's settlement keeps upstream delivery. Stopped and retained-child state persists across turn-counter changes and unrelated settlement-driven turns. Because another child's settlement keeps upstream delivery, an unrelated rc.6 turn may normally claim retained queue entries that were already pending; state persistence guarantees that later same-child settlements remain retained, not that already-claimed messages are reserved for a future prompt. The state expires only after the original instance-level `parent.followup(message)` or `parent.steer(message)` successfully accepts a public UserMessage whose `source.kind === 'user'`; a failed delivery leaves the state intact. That explicit prompt may then claim any retained report and settlement context still pending, exactly once each.

The compatibility implementation may use version-guarded rc.6 AgentLoop abort and wake seams. It must fail loudly when an expected seam is unavailable or the AgentLoop package manifest cannot be discovered, parsed, or validated rather than silently claiming complete protection. Unit fixtures may provide the exact supported version through the private `Symbol.for('@zhangzujian/dsh-adaptive-subagent-report/test-agent-loop-version')` seam, but the implementation honors that override only inside the Node test runner and never in production.

### Ordering and identity

- One successful report creates one report message ID.
- The plugin never creates, copies, edits, or reorders report content.
- Multiple reports preserve the original inbox insertion order.
- Tail wake behavior wakes existing pending work; it never reinserts the report.

### Compatibility

- Supported DSH and `@deepseek-ai/dsh-agent-loop` release: exactly `0.1.0-rc.6`; installation must discover the runtime manifest through `DSH_INSTALL_DIR` or resolution anchored at the DSH process entry point, require a non-empty string version, and reject unresolved discovery. The package also declares an exact AgentLoop peer.
- The plugin runs in the Host plane and injects `subagents` and `agents`.
- It must not modify DSH package files or prototypes.
- Unsupported object shapes fail during installation or first incompatible use with an actionable error.

### Teardown

- Teardown disables the policy before attempting restoration.
- If the plugin still owns the wrapped method, the exact previous own descriptor or prototype lookup is restored.
- If a later wrapper replaced a report, cancellation, or user-prompt observation method, teardown does not overwrite it; the inactive wrapper becomes a pass-through if reached later and does not inspect message sources.
- Pending reports remain owned by DSH and are not removed during teardown.

## Non-goals

- Report content coalescing, summarization, deduplication, or rate limiting.
- Durable offline mailboxes.
- Exactly-once behavior across model retries.
- Changes to one-shot subagents or settlement notices unrelated to a tracked user-stopped parent.
- Automatic conversion of ordinary user queue messages.
