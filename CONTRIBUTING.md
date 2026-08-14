# Contributing

## Design vocabulary

Use Module, Interface, Seam, Adapter, Implementation, Depth, Leverage, and Locality with their codebase-design meanings.

## Code standards

- Use native ECMAScript modules and Node.js 24 APIs.
- Keep the exported Cordis Interface minimal.
- Do not copy DSH report authorization, message framing, inbox insertion, or claim logic.
- The rc.6 tail-liveness Adapter may only inspect an accepted MessageId in `nextStep` and call the structurally validated `wakeDriver()` seam; keep that code isolated and label its tests as version-sensitive.
- Preserve original Promise identity and synchronous no-await report acceptance.
- Every behavior change starts with a failing test at an agreed public seam.
- Tests use public Interfaces unless an rc.6 compatibility assertion is explicitly identified as version-sensitive.
- Fail loudly on incompatible DSH shapes.
- Teardown must be compare-and-swap safe and must not overwrite later wrappers.
- Human-facing repository text, code comments, commits, issues, and reviews are written in English.
