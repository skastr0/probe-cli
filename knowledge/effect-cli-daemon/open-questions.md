# Effect CLI daemon open questions

Accessed: 2026-04-09

Legend:

- **Observed risk** = grounded in a source.
- **Inference / validation needed** = likely important for Probe, but still needs repo-specific implementation proof.

## Resolved for Probe architecture

1. **`probe serve` should be a layer-shaped daemon main.**
   - **Architecture decision (2026-04-10):** Treat `probe serve` as `NodeRuntime.runMain(Layer.launch(ProbeDaemonLive))` unless a tiny bootstrap wrapper is forced by a concrete non-layer concern.
   - **Why:** This keeps teardown, interruption, and daemon-owned resource cleanup inside ordinary Effect composition rather than around a hand-rolled runtime shell.

2. **`ManagedRuntime` is boundary-only for Probe.**
   - **Architecture decision (2026-04-10):** Reserve `ManagedRuntime` for tests, adapter callbacks, and non-Effect embeddings. Do not use it as the daemon's internal orchestration primitive.
   - **Why:** Probe wants one long-lived daemon runtime, but the daemon itself should still be expressed as layers and effects rather than repeated `runPromise(...)` calls inside the host.

## Remaining open questions

1. **Is `@effect/platform/Command` sufficient for all planned Apple bridges?**
   - **Inference / validation needed:** It looks strong for direct command execution and scoped cleanup, but LLDB or runner bridges may still require raw Node APIs if they need IPC, PTY behavior, or a lower-level event surface.

2. **How much of current `NodeCommandExecutor` behavior is safe to rely on?**
   - **Observed risk:** Process-group killing and detached POSIX children are observed in current source, but they are implementation details rather than stated public API guarantees.

3. **Do any Apple tools misbehave when launched in a detached POSIX process group?**
   - **Inference / validation needed:** Current Effect implementation does this on non-Windows. Probe should validate real tool behavior before hard-coding assumptions about signal propagation or descendant cleanup.

4. **What restart / backoff policy belongs in each long-lived bridge service?**
   - **Inference / validation needed:** The current research establishes lifecycle primitives, not Probe’s policy. Session-specific bridges may want different restart rules than the daemon root.

5. **What is the exact contract for stdout/stderr consumption for large-output Apple tools?**
   - **Observed risk:** Raw Node docs warn that unconsumed pipes can block children, and buffered helpers can truncate on `maxBuffer`. Probe should decide per integration whether to stream, inherit, or artifact-offload output.

6. **Should Probe ever enable shell execution for external tools?**
   - **Observed risk:** Shell-backed execution is the dangerous path in Node’s docs.
   - **Inference / validation needed:** Direct executable + argument arrays should likely be the default everywhere unless a specific utility requires shell features.

## Near-term risks for implementation work

- **Version-drift risk:** Effect public docs are current-web references, while the raw implementation source reflects the current `main` branch. Re-check behavior once the project pins its actual Effect package versions.
- **Lifecycle-braid risk:** It will be easy to mix daemon-owned resources and request-scoped resources unless each service clearly declares whether it is `Layer.scoped` or local `Effect.acquireRelease` ownership.
- **Subprocess-output risk:** Any long-lived bridge that forgets to consume or redirect stdout/stderr can stall under load.
- **Cleanup-assumption risk:** Depending on implicit child cleanup instead of scoped finalizers would directly violate Probe’s daemon-owned lifecycle model.
