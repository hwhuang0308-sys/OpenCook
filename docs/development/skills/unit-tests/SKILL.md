---
name: unit-tests
description: Write and verify Bun tests for OpenCook services, protocols, settings and devices.
---

# Unit tests

Read AGENTS.md and the guide in the affected package. Run tests from the package directory. Use actual implementations; replace only boundaries such as HTTP responses, serial ports and cameras. Avoid global and module mocks, implementation copies, and production hooks solely for tests.

Use the Effect helpers in packages/core/test/lib/effect.ts. Use `it.effect` and TestClock for timers; fork before advancing time. Use `it.live` for real filesystem, process, socket and hardware boundary work. Do not hide timing problems with longer timeouts, skips or retries.

Use isolated temporary directories and port 0 for servers. Await readiness and resource cleanup explicitly. Clean up processes, streams, renderers and servers before deleting files. Never print real credentials or record personal camera frames in fixtures.

Core's test script and the CLI test script set a 30-second timeout. Client and SDK tests use 5 seconds. Read the affected package's script before selecting a timeout. Keep subprocess coverage focused on behavior that requires a separate process; test deterministic sensor calculations against the preserved Python reference fixtures.

For terminal rendering and keyboard interaction, read the neighboring tui-tests skill. After relevant tests pass, run `bun run check` from the repository root.
