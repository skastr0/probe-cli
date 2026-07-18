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

### 9. PRB-085 outcome: AppleProcessSupervisor stayed on raw `node:child_process`

Accessed: 2026-07-13.

- **Decision:** `@effect/platform` is still not a workspace dependency (checked:
  absent from `package.json` and `node_modules` as of this pass). Adding it was
  out of scope for PRB-085 under a hard no-new-dependency constraint set for
  that change, so `src/services/AppleProcessSupervisor.ts` uses raw
  `node:child_process` -- the "documented, tested exception" this pack's own
  guidance (section 6) already carves out -- but now isolated behind a single
  adapter instead of duplicated across `SessionRegistry.ts`, `SimulatorHarness.ts`,
  `RealDeviceHarness.ts`, `PerfService.ts`, and `ProbeKernel.ts`.
- **Observed (this pass, generic shell children, not Apple tooling):** `spawn(...,
  { detached: true })` makes the child its own process-group leader; killing
  the group with `process.kill(-pid, "SIGTERM")` then a bounded grace window
  then `process.kill(-pid, "SIGKILL")` reliably takes down a multi-process
  descendant tree (`sh -c "sleep 30 & sleep 30 & sleep 30 & wait"` fully
  cleared, verified via `ps -g <pgid>`) on macOS. This validates section 8's
  "promising" note for generic POSIX process groups.
- **Not yet validated against the real tool seams named in section 8.** This
  pass had no simulator (`xcrun simctl` present but no booted device) and no
  paired iOS device available, so `xcodebuild`, `xctrace`, `simctl`,
  `devicectl`, `log stream`, and `lldb`'s actual behavior under
  SIGTERM/SIGKILL and under a killed process group is still unconfirmed --
  only their invocation/parsing wrappers were migrated onto the shared
  supervisor's foreground/streamed-to-artifact path (`SessionRegistry.runHostCommand`,
  `SimulatorHarness.runCommandWithExit/runCommand/runCommandWithCapturedStdout`,
  `RealDeviceHarness.runCommand`, `PerfService.runCommand/runCommandToFile/liveStartRecording`,
  `ProbeKernel.runHostCommand/runXmllint`). The long-lived runner-wrapper
  processes in `SimulatorHarness.ts` and `RealDeviceHarness.ts` (the actual
  `xcodebuild test-without-building` + XCUITest runner handles, with their own
  `ps`-derived process-group detection in `terminateRunnerProcess`/`inspectProcess`)
  and the LLDB Python bridge in `LldbBridge.ts` were deliberately left on their
  existing bespoke termination logic rather than risking a same-pass rewrite of
  session-critical framed IPC with no device/simulator hardware to verify against.
- **Open question carried forward:** whether `xcodebuild`/`xctrace` propagate
  SIGTERM to their own child processes cleanly, or need a longer grace window /
  SIGINT first -- unresolved, needs a real device/simulator lane.

### 10. PRB-085 review-fix: SIGINT vs SIGTERM racing on a graceful `stop()`

Accessed: 2026-07-17.

- **Regression found (code-level, confirmed via `git show 9993e78^` diff
  against the pre-migration implementation):** the pre-migration
  `PerfService.liveStartRecording(...).stop()` sent only SIGINT and awaited
  natural exit with no forced escalation at all (bounded only by the
  recording's own overall `timeoutMs`). The migrated `AppleProcessHandle.stop(signal)`
  always chained straight into `escalateIfRunning`, which unconditionally
  sends SIGTERM -- so `stop("SIGINT")` sent SIGINT and SIGTERM to the process
  group within the same tick, before the SIGINT-specific handler (e.g.
  xctrace finalizing/flushing its `.trace` bundle) had any uncontested time to
  run.
- **Fix:** `AppleProcessSupervisor.ts` now has `stopGracefully(child, signal,
  gracePeriodMs)`: a non-SIGTERM `stop()` signal gets a full, uncontested
  `gracePeriodMs` window on its own, and only escalates through the existing
  TERM -> grace -> KILL ladder (`escalateIfRunning`) if the process is still
  running after that window. A `stop("SIGTERM")` call is unchanged (SIGTERM
  is already rung one of that same ladder). This directly answers section 9's
  carried-forward open question for the SIGINT-first half: Probe's own
  signal-sequencing no longer races SIGTERM in behind SIGINT.
- **Still not device/simulator-validated:** whether `xctrace` itself actually
  uses its SIGINT window to finalize/flush a `.trace` bundle (vs. exiting
  immediately either way) remains unconfirmed -- this pass had no simulator
  hardware. What changed is Probe's own signal sequencing (verified via two
  new `bun test` cases in `AppleProcessSupervisor.test.ts` against a real
  `/bin/sh` child with `trap ... INT`/`trap ... INT TERM`, not against
  `xctrace`), not xctrace's internal response to it. The open question is
  narrowed, not closed: does `xctrace` do anything different with the grace
  window it's now actually given.

### 11. PRB-085 review-fix: the long-lived runner-wrapper and LLDB bridge migrations, deferred in section 9, are now done

Accessed: 2026-07-17.

- **Closed:** the four raw `node:child_process.spawn` production sites
  section 9 deliberately left unmigrated are now all supervisor-registered:
  `SimulatorHarness.recordSimulatorVideoWithSimctl` (via a new generic
  `startMarkedRecording` helper -- spawn, watch stderr for a caller-supplied
  marker via the supervisor's new `onStderrChunk` hook, request a graceful
  stop), `SimulatorHarness`/`RealDeviceHarness`'s `startWrapperProcess`/
  `stopWrapperProcess` (the `xcodebuild test-without-building` + XCUITest
  runner handle, now `spawnAppleProcessHandle`-backed; RealDeviceHarness's own
  `terminateRunnerProcess`/`inspectProcess`/`killRunnerTarget`/
  `waitForProcessExit`/`processExists` cluster is now dead code and was
  deleted rather than left behind -- SimulatorHarness kept its own copy since
  it is still load-bearing there for stale-pid reaping across daemon restarts,
  a genuinely different case a live supervisor registry cannot cover), and
  `LldbBridge.ts` (via new `AppleProcessSupervisor` support for `stdin: "pipe"`
  and `externalStdout: true` -- the bridge's line-framed JSON-RPC protocol
  needs a writable stdin and a raw, caller-owned stdout stream for `readline`,
  which the supervisor did not support before this pass).
- **Supervisor contract grew three capabilities to support this**, all
  additive/optional on `AppleProcessSpec`: `onStderrChunk`/`onStdoutChunk`
  (observe raw chunks without disturbing the bounded capture -- lets a wrapper
  detect a domain marker like `simctl`'s "Recording started" while lifecycle
  stays supervisor-owned), `stdin: "pipe"` + `stdout: Writable/Readable` on
  `spawnHandle`'s returned handle (only when requested), and `signal?:
  AbortSignal` on `run()` (races the owned scope the same way fiber
  interruption already does -- aborting interrupts the loser, which runs the
  same `escalateIfRunning` release as a direct interrupt).
- **`externalStdout` exists to close a real race, not by accident:** the
  supervisor's own bounded-capture listener attaches synchronously right
  after spawn; a caller that only gets the handle back later (after at least
  one microtask) would lose any stdout emitted in between if the supervisor's
  own listener had already started draining it. `externalStdout: true` skips
  attaching that listener, which keeps the stream in Node's default
  paused/buffered mode (nothing lost, not even a race window) until the
  caller attaches its own consumer.
- **Observed, real hardware, this pass (booted `iPhone 16 Pro` simulator,
  `xcrun simctl io <udid> recordVideo`):** `startMarkedRecording` against the
  real `simctl` binary correctly detected the `Recording started` stderr
  marker, ran for the requested duration, stopped via SIGINT (`exitCode: 0`),
  produced a real non-empty `.mov` file, and left no orphaned `simctl`
  process behind (`ps aux` clean immediately after). This directly narrows
  section 9's "not yet validated against the real tool seams" gap for the
  `simctl recordVideo` seam specifically.
- **Still not validated against real hardware:** the `xcodebuild
  test-without-building` + XCUITest runner-wrapper migration and the LLDB
  Python bridge migration were verified with the same rigor as the rest of
  this codebase's process-helper tests (real `/bin/sh`/`/usr/bin/python3`
  children exercising the exact spawn/stdio/kill-escalation/descendant-tree
  mechanics -- see `SimulatorHarness.processHelpers.test.ts`,
  `RealDeviceHarness.processHelpers.test.ts`,
  `LldbBridge.processHelpers.test.ts`), but not against a real xcodebuild
  build + real LLDB attach, which this pass did not attempt (a real
  device/simulator XCUITest build is a much larger, slower, provisioning-
  dependent operation than the code-level migration this pass covers, and a
  real LLDB attach needs a live debuggable target process). This is the same
  boundary section 9 already drew between "Probe's own spawn/kill mechanics"
  (now supervisor-proven) and "the real Apple tool's behavior under this
  exact termination path" (still open) -- narrowed for `simctl`, unchanged for
  `xcodebuild`/`lldb`.
- **Latent gap found (not fixed, not caused by this pass, real and
  reproducible):** `AppleProcessSupervisor`'s `escalateIfRunning` only signals
  the owned process group if the tracked child itself has not yet exited
  (`hasExited(child)` gates the whole ladder). If a supervised child exits on
  its own while a *grandchild* it spawned (via a mechanism that inherits the
  child's stdio, e.g. Python's `os.system(...)` backgrounding a job without
  redirecting its fds) is still alive, that grandchild is never signaled --
  it is orphaned, and if it still holds the stdout/stderr pipe open, the
  supervisor's own `waitForClose` (which waits for the child's `'close'`
  event, itself gated on every stdio holder closing) can hang. Reproduced
  directly while building `LldbBridge.processHelpers.test.ts`'s descendant
  fault test (a fake bridge script using `os.system` to fork background
  `sleep` jobs that inherited stdio hung the test until the fix below); not
  triggered by any of this pass's actual production code (none of the four
  migrated call sites spawn-and-abandon a stdio-inheriting grandchild -- the
  real LLDB bridge script does not use `os.system` at all, and `simctl`/
  `xcodebuild` were confirmed clean via the real-hardware and fake-command
  tests above). Worked around in the test by redirecting the fake
  grandchildren's stdio (`</dev/null >/dev/null 2>/dev/null`) instead of
  papering over it in the supervisor. A real fix (e.g. attempting the
  process-group signal on every `stop()`/finalizer path regardless of
  `hasExited`, since a pgid signal is a no-op for a genuinely empty group)
  is a supervisor-level change with its own blast radius and deserves a
  dedicated look, not a same-pass patch bolted onto an already-large diff --
  flagged here as a follow-up, not filed against any of this pass's own
  call sites.
- **Fixed (PRB-101):** the follow-up above is closed. `waitForClose` (not
  `escalateIfRunning`'s `hasExited` bail, which stays as the cheap common-path
  fast-return for a genuinely fully-exited process/group) now self-heals: it
  listens for `'exit'` in addition to `'close'`, and if `'exit'` fires without
  a prompt `'close'` -- exactly the "grandchild still holds the pipe" shape
  above -- it re-signals the process group (still a valid target even after
  the tracked leader has exited, as long as any member survives; a fully
  empty group is a harmless no-op via `trySignalGroup`'s ESRCH fallback)
  through the same TERM -> grace -> KILL ladder, then gives the pipe one
  bounded window before giving up and resolving with the exit's own
  code/signal. This closes the hang at its actual root cause: the previous
  code never reached any kill-escalation logic at all once the tracked leader
  had already exited, because the whole `runManaged`/`spawnHandleManaged`
  wait was blocked forever on `'close'` before the acquireRelease finalizer
  (which is what called `escalateIfRunning`) could ever run. Proven by
  `AppleProcessSupervisor.test.ts`'s "grandchild fault test: a backgrounded
  job outliving the leader while holding stdout is signaled and cannot hang
  waitForClose" -- a `sh -c "echo leader-done; sleep 30 &"` leader (no
  `wait`, so it exits immediately while the backgrounded `sleep` still holds
  the inherited stdout pipe) now resolves promptly and leaves zero surviving
  process-group members, instead of hanging.
