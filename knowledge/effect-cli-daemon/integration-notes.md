# Effect CLI daemon integration notes

Accessed: 2026-04-09

Legend:

- **Observed** = directly supported by cited sources.
- **Inference** = derived for Probe from the observed sources.

## Observed foundations

1. **Node entrypoint:** `NodeRuntime.runMain` is the standard Node entrypoint for Effect apps and handles error logging, exit codes, signals, and teardown.
2. **Layer-shaped long-lived apps:** `Layer.launch` exists specifically for applications that are themselves long-lived layers.
3. **Top-level custom runtime:** `ManagedRuntime` is the documented bridge for top-level custom runtimes and non-Effect host/framework integration.
4. **Scoped subprocesses:** `Command.start` exposes a `Process` handle and requires `Scope`; current Node executor source uses `acquireRelease` so cleanup happens when the scope closes.
5. **Raw Node constraints still apply:** child stdout/stderr must be consumed or explicitly ignored; shell execution expands the attack surface; buffered helpers (`exec`, `execFile`) are poor fits for large or streaming output.

## Probe-oriented guidance

### 1. Daemon entrypoint

- **Inference:** Prefer a layer-shaped daemon for `probe serve` and run it with `NodeRuntime.runMain(Layer.launch(...))` when the daemon can be modeled primarily as services.
- **Inference:** This best matches Probe’s architecture: one long-lived kernel, explicit teardown, and daemon-owned subprocess cleanup.

```ts
import { Layer } from "effect"
import { NodeRuntime } from "@effect/platform-node"

// Inference: placeholder shape for Probe's daemon
NodeRuntime.runMain(Layer.launch(ProbeDaemonLive))
```

### 2. Where `ManagedRuntime` belongs

- **Observed:** `ManagedRuntime` is for top-level custom runtimes and external integrations.
- **Inference:** Use it at the **boundary** where non-Effect code needs to invoke Effect repeatedly (for example: framework hooks, adapter callbacks, integration tests, or a host wrapper that cannot itself be expressed as a pure Effect main).
- **Inference:** Do **not** treat `ManagedRuntime.runPromise(...)` as the daemon’s internal orchestration primitive for every service interaction; inside the daemon, prefer ordinary `Effect` + `Layer` composition.

### 3. Thin CLI client shape

- **Observed:** `@effect/cli` is wired with `NodeContext.layer` and `NodeRuntime.runMain`, and provides built-in help/version/completions.
- **Inference:** Keep the user-facing `probe ...` commands thin: parse options with `@effect/cli`, call the daemon, print structured results, exit.
- **Inference:** This keeps CLI process-local state small and leaves session continuity in the daemon where the architecture wants it.

```ts
import { Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"

// Observed wiring pattern, adapted to Probe's naming
const cli = Command.run(RootCommand, { name: "probe", version: "<version>" })
cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
```

### 4. Modeling long-lived daemon services

- **Observed:** Layers are shared by default and `Layer.scoped` is the public API for scoped service construction.
- **Inference:** Model daemon-owned resources as `Layer.scoped` services when they must outlive a single request:
  - socket / RPC server
  - session registry
  - artifact-retention worker
  - runner bridge
  - LLDB bridge
  - log stream collector

- **Inference:** Use `Effect.acquireRelease` inside a service method only when the owned resource is intentionally short-lived and local to that one action.

```ts
import { Command } from "@effect/platform"
import { Effect, Layer } from "effect"

// Inference: placeholder Probe bridge shape
const RunnerBridgeLive = Layer.scoped(
  RunnerBridge,
  Effect.gen(function* () {
    const process = yield* Command.start(runnerCommand)
    return RunnerBridge.of({ process })
  })
)
```

### 5. Subprocess supervision notes

- **Observed:** `Command.start` gives a typed `Process` handle with `stdout`, `stderr`, `stdin`, `exitCode`, `isRunning`, and `kill`.
- **Observed:** Current Node executor implementation uses scoped acquisition and attempts process-group cleanup on release.
- **Inference:** Each long-lived Apple utility bridge should own:
  - the `Process` handle
  - stdout/stderr consumer fibers
  - a readiness handshake (`Deferred` or similar)
  - health / degraded state
  - restart policy (if the work item later calls for restart)

- **Inference:** Never leave child-process cleanup to the CLI caller; keep ownership in the daemon service scope.

### 6. When to prefer `@effect/platform/Command`

- **Inference:** Prefer `@effect/platform/Command` first for Apple/Xcode utilities because it already gives:
  - typed process handles
  - stream-based stdout/stderr
  - explicit stdin handling
  - effectful exit observation
  - scope-backed lifecycle cleanup

- **Inference:** Only drop to raw `node:child_process` when Probe needs a feature that the public Effect command surface does not obviously cover, such as:
  - Node-specific `fork()` IPC
  - PTY / terminal emulation behavior
  - very specific event sequencing or stdio edge cases

### 7. Raw Node subprocess caveats

- **Observed:** Unconsumed pipes can block a child process.
- **Inference:** For long-running tools, always either:
  - continuously consume stdout/stderr, or
  - explicitly configure them as inherited / ignored when that is truly safe.

- **Observed:** `exec()` spawns a shell and buffers output; `execFile()` buffers output too.
- **Inference:** Avoid `exec()` for Apple tools and streaming bridges; prefer direct args + streaming via `spawn()`/`Command.start` style APIs.

- **Observed:** Shell-backed subprocesses are dangerous with unsanitized input.
- **Inference:** `Command.runInShell(true)` should be an exception, not the default.

### 8. Apple-tool-specific caution

- **Observed:** Current Effect Node command execution uses detached POSIX children and process-group killing in implementation.
- **Inference:** This is promising for Probe because Apple utility wrappers often spawn descendants that should die with the session.
- **Inference:** It still needs validation with the real tool seams (`xcodebuild`, `xctrace`, `log stream`, `lldb`) before the implementation assumes identical behavior across all bridges.
