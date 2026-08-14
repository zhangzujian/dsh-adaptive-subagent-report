# Adaptive Subagent Report Delivery Specification

## Problem

DeepSeek Harness 0.1.0-rc.6 configures continuable subagent reports with `reportDelivery: wakeup` by default. The report service sends wakeup reports through `parent.followup()`, placing them in the parent's next-turn inbox. A parent whose current turn runs for a long time cannot claim those reports, so the queue grows while the parent continues working.

## Public seams under test

The implementation is tested at three agreed seams:

1. The Cordis plugin interface: `apply(ctx)` installs one wrapper and teardown restores the prior method without damaging later wrappers.
2. The subagent report interface: `ctx.subagents.reportFrom(child, content, options)` preserves explicit quiet delivery, keeps idle wakeup delivery as followup, and routes running wakeup delivery to next-step context.
3. The real DSH AgentLoop interface: reports received by a running parent do not enter next-turn, reports received by an idle parent wake it, pending context cannot remain stranded after the terminal driver window, and accepted report messages are inserted once.

## Required behavior

### Routing

- Explicit `delivery: quiet` is unchanged.
- `delivery: wakeup` with an idle parent uses the original followup path.
- `delivery: wakeup` with a running parent keeps the original report service path and waking accounting, but the one report send is routed to `parent.steer(message)` instead of `parent.followup(message)`.
- Missing parents, unauthorized children, cancellation, activation closing, framing, message identity, and error translation remain owned by the original DSH report service.

### Terminal liveness

DSH 0.1.0-rc.6 has a narrow interval where an Agent still reports `running` after its final turn decision but before the driver publishes `idle`. If a routed report remains in `nextStep` after the parent becomes idle, the plugin must wake that exact live parent without inserting a second report message.

The compatibility implementation may use a version-guarded rc.6 AgentLoop wake seam. It must fail loudly when the expected seam is unavailable rather than silently claiming complete protection.

### Ordering and identity

- One successful report creates one report message ID.
- The plugin never creates, copies, edits, or reorders report content.
- Multiple reports preserve the original inbox insertion order.
- Tail wake behavior wakes existing pending work; it never reinserts the report.

### Compatibility

- Supported DSH release: exactly `0.1.0-rc.6`.
- The plugin runs in the Host plane and injects `subagents` and `agents`.
- It must not modify DSH package files or prototypes.
- Unsupported object shapes fail during installation or first incompatible use with an actionable error.

### Teardown

- Teardown disables the policy before attempting restoration.
- If the plugin still owns the wrapped method, the exact previous own descriptor or prototype lookup is restored.
- If a later wrapper replaced the method, teardown does not overwrite it; the inactive wrapper becomes a pass-through if reached later.
- Pending reports remain owned by DSH and are not removed during teardown.

## Non-goals

- Report content coalescing, summarization, deduplication, or rate limiting.
- Durable offline mailboxes.
- Exactly-once behavior across model retries.
- Changes to one-shot subagents or settlement notices.
- Automatic conversion of ordinary user queue messages.
