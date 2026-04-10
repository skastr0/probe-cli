# Effect CLI daemon API notes

Accessed: 2026-04-09

Legend:

- **Observed** = directly supported by a cited source.
- **Implementation detail** = directly observed in current source, but not guaranteed as a stable public contract.
- **Inference** = derived for Probe and called out as such.

## 1. `@effect/cli`

- **Observed:** `@effect/cli` interacts with platform-specific services like the file system and terminal, so Node CLIs also need `@effect/platform-node`. Source: package README.
- **Observed:** The README’s Node examples wire CLI execution as:

  ```ts
  cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
  ```

  Source: package README.

- **Observed:** Built-in CLI capabilities include help, version, shell completions, and wizard mode. Source: package README.
- **Observed:** The library supports a top-level command plus nested subcommands, with explicit `Args` and `Options`. Source: package README.

## 2. Runtime + `ManagedRuntime`

- **Observed:** A `Runtime<R>` executes effects and contains `Context<R>`, `FiberRefs`, and `RuntimeFlags`. Source: runtime docs.
- **Observed:** `Effect.run*` helpers use the default runtime behind the scenes. Source: runtime docs.
- **Observed:** When you need to customize runtime configuration for the whole application from the top level, Effect’s docs point to `ManagedRuntime.make(layer)`. Source: runtime docs.
- **Observed:** `ManagedRuntime.make` converts a `Layer` into a runtime that can execute effects using the services provided by that layer. Sources: runtime docs, `ManagedRuntime` API docs.
- **Observed:** Public `ManagedRuntime` methods include:
  - `runFork`
  - `runSyncExit`
  - `runSync`
  - `runCallback`
  - `runPromise`
  - `runPromiseExit`
  - `dispose`
  - `disposeEffect`

  Source: `ManagedRuntime` API docs.

- **Observed:** The runtime docs position `ManagedRuntime` as especially useful when Effect is integrated into an external framework or non-Effect host. Source: runtime docs.

## 3. `Layer` and `Layer.scoped`

- **Observed:** Layers are the Effect abstraction for constructing services while keeping dependency details out of the service interface. Source: layers docs.
- **Observed:** Layers are shared by default; the same layer used twice is allocated once unless you opt into freshness. Sources: layers docs, `Layer` API docs.
- **Observed:** `Layer.scoped` constructs a layer from a scoped effect and removes `Scope` from the resulting public requirements. Source: `Layer` API docs.
- **Observed:** `Layer.launch` “builds this layer and uses it until it is interrupted,” and the docs call out long-lived apps such as an HTTP server as the motivating use-case. Sources: layers docs, `Layer` API docs.
- **Observed:** `Layer.toRuntime` converts a layer into a scoped runtime. Source: `Layer` API docs.
- **Observed:** `Layer.buildWithScope` keeps the layer’s resources alive until the specified scope is closed. Source: `Layer` API docs.
- **Observed:** `Layer.extendScope` exists when resource lifetime must outlive the effect the layer is directly provided to. Source: `Layer` API docs.

## 4. `Scope`, finalizers, and `Effect.acquireRelease`

- **Observed:** `Scope` is Effect’s core resource-lifetime construct. Closing a scope releases all resources in it. Source: scope docs.
- **Observed:** Finalizers run in reverse order. Source: scope docs.
- **Observed:** `Effect.addFinalizer` attaches cleanup logic that runs on success, failure, or interruption when the effect is scoped. Source: scope docs.
- **Observed:** `Effect.scoped` creates a scope, runs the effect inside it, and closes the scope automatically when the effect finishes. Source: scope docs.
- **Observed:** `Effect.acquireRelease(acquire, release)` guarantees the release action runs once acquisition succeeded and the scope later closes. Source: scope docs.
- **Observed:** The docs explicitly state acquisition is uninterruptible to avoid partially-acquired resources. Source: scope docs.

## 5. `@effect/platform` command execution

- **Observed:** `Command.make` creates a command description; it does not execute anything by itself. Sources: platform command docs, `Command` API docs.
- **Observed:** Public command combinators relevant to Probe include:
  - `env`
  - `feed`
  - `pipeTo`
  - `runInShell`
  - `stdin`
  - `stdout`
  - `stderr`
  - `workingDirectory`

  Source: `Command` API docs.

- **Observed:** Public execution helpers relevant to Probe include:
  - `exitCode`
  - `lines`
  - `start`
  - `stream`
  - `streamLines`
  - `string`

  Source: `Command` API docs.

- **Observed:** `Command.start(command)` returns `Effect<Process, PlatformError, CommandExecutor | Scope>`. Sources: platform command docs, `Command` API docs.
- **Observed:** `Process` exposes:
  - `pid`
  - `exitCode`
  - `isRunning`
  - `kill(signal?)`
  - `stdin` sink
  - `stdout` stream
  - `stderr` stream

  Source: `CommandExecutor` API docs.

- **Observed:** The platform command docs show `Command.start` being used under `Effect.scoped(...)` when callers need access to `process.exitCode`, `process.stdout`, and `process.stderr`. Source: platform command docs.
- **Observed:** The platform command docs show `Command.stdout("inherit")` as the direct way to stream command stdout to the parent process stdout. Source: platform command docs.

## 6. Node runtime + graceful main

- **Observed:** `NodeRuntime.runMain` is the primary Node entrypoint for Effect applications. Source: guidelines docs.
- **Observed:** `runMain` handles built-in error reporting, exit codes, logging, and signal management. Source: platform runtime docs.
- **Observed:** The guidelines docs explicitly say `runMain` handles `SIGINT`/Ctrl+C graceful teardown by interrupting fibers and releasing resources. Source: guidelines docs.

## 7. Current `NodeCommandExecutor` supervision behavior

These findings come from current source code and should be treated as **implementation detail**, not stable API contract.

- **Implementation detail:** `NodeCommandExecutor.layer` is currently a `Layer<CommandExecutor, never, FileSystem>`. Sources: Node command executor API docs, raw source.
- **Implementation detail:** The executor validates the configured working directory with `FileSystem.access` before spawn. Source: raw internal executor source.
- **Implementation detail:** Standard commands currently spawn via Node’s `child_process.spawn(...)` and wrap the child in `Effect.acquireRelease(...)`. Source: raw internal executor source.
- **Implementation detail:** The current implementation sets `detached: process.platform !== "win32"` for spawned commands. Source: raw internal executor source.
- **Implementation detail:** On release, if the process is still running, the executor attempts to kill the process group with `SIGTERM`, falls back to killing the handle directly, then awaits exit. Source: raw internal executor source.
- **Implementation detail:** On POSIX, the current implementation uses `process.kill(-handle.pid!, signal)` to target the child process group. Source: raw internal executor source.
- **Implementation detail:** On Windows, the current implementation uses `taskkill /pid <pid> /T /F` for process-tree cleanup. Source: raw internal executor source.
- **Implementation detail:** If command stdin is modeled as a stream, the executor currently feeds it into the process via `Effect.forkDaemon(Stream.run(...))`. Source: raw internal executor source.

## 8. Raw Node child-process semantics that still matter

- **Observed:** `spawn()` is the core async primitive and does not block the Node event loop. Source: Node child-process docs.
- **Observed:** `exec()` spawns a shell and buffers output. Source: Node child-process docs.
- **Observed:** `execFile()` runs the executable directly without a shell by default and is more efficient than `exec()` for direct executable launches. Source: Node child-process docs.
- **Observed:** Default stdio pipes have limited capacity; if stdout/stderr are not consumed, the child can block on pipe backpressure. Source: Node child-process docs.
- **Observed:** `exec()` / `execFile()` have `maxBuffer`; if exceeded, the child is terminated and buffered output is truncated. Source: Node child-process docs.
- **Observed:** `AbortSignal` is supported across `spawn()`, `exec()`, `execFile()`, and `fork()`. Source: Node child-process docs.
- **Observed:** `close` fires after process termination **and** stdio closure; `exit` can happen while stdio is still open; `error` may fire instead / first when spawn or kill fails. Source: Node child-process docs.
- **Observed:** Shell-backed execution is unsafe with unsanitized input. Source: Node child-process docs.
