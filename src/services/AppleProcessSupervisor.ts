import { type ChildProcess, spawn } from "node:child_process"
import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { Readable, Transform, Writable } from "node:stream"
import { Context, Duration, Effect, Layer, ManagedRuntime, Ref } from "effect"
import { ChildProcessError } from "../domain/errors"

/**
 * AppleProcessSupervisor is the single lifecycle owner for child processes Probe
 * spawns to drive Apple developer tooling (xcodebuild, xcrun simctl, xcrun
 * devicectl, xctrace, log, xmllint, and the ffmpeg/ffprobe host helpers used by
 * the runner wrappers).
 *
 * Tool wrappers (SessionRegistry, SimulatorHarness, RealDeviceHarness,
 * PerfService, ProbeKernel) keep invocation + output parsing only. This service
 * owns:
 *   - registering a child before the caller ever observes a handle
 *   - continuously draining stdout/stderr so a busy pipe cannot deadlock a tool
 *   - bounded in-memory output with artifact-backed full output (append-only,
 *     never a whole-history rewrite)
 *   - TERM -> bounded grace -> KILL escalation against the owned process group
 *   - deregistering a child only after it has exited and its stdio has closed
 *
 * `@effect/platform/Command` is the long-term preferred surface for this (see
 * knowledge/effect-cli-daemon/integration-notes.md) but is not a workspace
 * dependency yet and adding one is out of scope for this change. Raw
 * `node:child_process` is used here as the documented, tested exception the
 * same notes call out -- isolated behind this single adapter instead of being
 * duplicated at every call site.
 */

export interface AppleProcessSpec {
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** Kills the process group and fails with a `command-timeout` ChildProcessError. */
  readonly timeoutMs?: number
  /**
   * `run()` only: when this signal aborts, the process group is torn down
   * through the same TERM -> grace -> KILL ladder fiber interruption already
   * uses (aborting races the underlying scope, interrupting it) and the
   * result resolves with `cancelled: true` instead of throwing. Lets a caller
   * thread an external cancellation source (e.g. an RPC client disconnect)
   * through to the owned child without inventing a second kill path.
   */
  readonly signal?: AbortSignal
  /** Grace window between SIGTERM and SIGKILL on interruption/timeout. Default 2000ms. */
  readonly gracePeriodMs?: number
  /** When set, the full stdout stream is also appended to this path, never rewritten. */
  readonly stdoutArtifactPath?: string
  /** When set, the full stderr stream is also appended to this path, never rewritten. */
  readonly stderrArtifactPath?: string
  /** Caps how many bytes of stdout/stderr are retained in memory. Default 2 MiB per stream. */
  readonly maxBufferedBytes?: number
  /** Optional transform the raw stdout bytes are piped through before capture/artifact write. */
  readonly stdoutTransform?: Transform
  /**
   * Called with the original spawn-time error (e.g. Node's ENOENT) before it is
   * wrapped into a `ChildProcessError`. Lets a caller that needs the raw OS
   * error code (optional-tool detection such as "is ffmpeg installed") recover
   * it without the supervisor leaking `node:child_process` error shapes into
   * its own typed error contract.
   */
  readonly onSpawnError?: (error: unknown) => void
  /**
   * Observes each raw stdout/stderr chunk as it arrives, in addition to (not
   * instead of) the supervisor's own bounded capture/artifact write. This is
   * for a caller that needs to react to output as it streams -- e.g.
   * detecting a tool's "recording started" marker on stderr to know when a
   * bounded duration window should begin -- while the supervisor keeps owning
   * draining, registration, and kill escalation. Output parsing stays the
   * wrapper's job; only lifecycle stays here.
   */
  readonly onStdoutChunk?: (chunk: Buffer) => void
  readonly onStderrChunk?: (chunk: Buffer) => void
  /**
   * `spawnHandle` only: requests a writable stdin pipe on the child (default
   * "ignore", matching every other call site). Only meaningful for a
   * long-lived handle that needs to send input after spawn (e.g. LldbBridge's
   * line-framed JSON-RPC protocol over stdin/stdout).
   */
  readonly stdin?: "ignore" | "pipe"
  /**
   * `spawnHandle` only: when true, the supervisor does not attach its own
   * stdout capture listener -- the caller drives `AppleProcessHandle.stdout`
   * directly instead (e.g. piping it through `readline` for a line-framed
   * protocol). The child's stdout stream stays in paused/buffered mode until
   * the caller attaches its own consumer, so nothing is lost to the race an
   * eagerly-attached default listener would create by consuming chunks before
   * the caller has a chance to add its own. `AppleProcessResult.stdout` is
   * always empty for a call made with this set.
   */
  readonly externalStdout?: boolean
}

export interface AppleProcessResult {
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  readonly stdoutBytesWritten: number
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly durationMs: number
  /**
   * True when `timeoutMs` elapsed before the process closed on its own. `run`
   * still resolves (it never throws for a timeout, only for a genuine spawn
   * failure) with whatever stdout/stderr had been captured up to the kill --
   * callers that want a typed `ChildProcessError` on timeout build one from
   * this flag, keeping full access to the captured output for their own
   * logging/artifact policy instead of only a truncated excerpt.
   */
  readonly timedOut: boolean
  /**
   * True when `spec.signal` aborted before the process closed on its own.
   * `run()` still resolves (never throws for a cancellation, only for a
   * genuine spawn failure) with whatever stdout/stderr had been captured up
   * to the kill, mirroring `timedOut`.
   */
  readonly cancelled: boolean
}

export interface AppleProcessHandle {
  readonly pid: number
  readonly isRunning: () => boolean
  /**
   * Sends `signal` (default SIGTERM). A SIGTERM stop escalates straight to
   * the TERM -> grace -> KILL ladder. Any other signal (e.g. SIGINT, to let a
   * tool like xctrace finalize its own output) gets a full, uncontested grace
   * window on its own before that ladder engages -- it is never raced against
   * an immediate SIGTERM. Either way this joins exit before resolving.
   */
  readonly stop: (signal?: NodeJS.Signals) => Promise<AppleProcessResult>
  readonly awaitExit: Promise<AppleProcessResult>
  /** Present only when the spec set `stdin: "pipe"`; `null` otherwise. */
  readonly stdin: Writable | null
  /** Present only when the spec set `externalStdout: true`; `null` otherwise. */
  readonly stdout: Readable | null
}

const defaultGracePeriodMs = 2_000
const defaultMaxBufferedBytes = 2 * 1024 * 1024

const commandLabel = (spec: { readonly command: string; readonly commandArgs: ReadonlyArray<string> }): string =>
  `${spec.command} ${spec.commandArgs.join(" ")}`

/**
 * Bounded in-memory capture with append-only, artifact-backed full output.
 * Chunks are written to the artifact stream exactly once, in arrival order --
 * this is the generalized fix for the whole-history rewrite bug this glyph
 * removes from RealDeviceHarness (the old code re-joined and rewrote the
 * entire accumulated stderr string on every chunk).
 */
class BoundedSink {
  private readonly chunks: Array<Buffer> = []
  private bufferedBytes = 0
  private bytesWritten = 0
  truncated = false
  private readonly artifactStream: WriteStream | undefined

  constructor(private readonly maxBytes: number, artifactPath: string | undefined) {
    this.artifactStream = artifactPath ? createWriteStream(artifactPath, { flags: "a" }) : undefined
  }

  write(chunk: Buffer): void {
    this.bytesWritten += chunk.byteLength
    this.artifactStream?.write(chunk)

    if (this.bufferedBytes >= this.maxBytes) {
      this.truncated = this.truncated || chunk.byteLength > 0
      return
    }

    const remaining = this.maxBytes - this.bufferedBytes
    const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk
    this.chunks.push(Buffer.from(slice))
    this.bufferedBytes += slice.byteLength

    if (slice.byteLength < chunk.byteLength) {
      this.truncated = true
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8")
  }

  totalBytesWritten(): number {
    return this.bytesWritten
  }

  close(): Effect.Effect<void> {
    if (!this.artifactStream) {
      return Effect.void
    }

    const stream = this.artifactStream

    return Effect.async<void>((resume) => {
      stream.end(() => resume(Effect.void))
    })
  }
}

const trySignalGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal)
    return
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      return
    }
  }

  try {
    process.kill(pid, signal)
  } catch {
    // Process already gone; nothing left to signal.
  }
}

const hasExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null

/**
 * Resolves once `child`'s stdio has fully closed -- but never hangs forever
 * over it. A grandchild that inherited the write end of stdout/stderr (e.g.
 * a job the tracked leader backgrounded and then exited without ever
 * `wait`-ing on) can outlive the leader while still holding that pipe open:
 * Node's 'close' event needs every holder of the pipe to let go, not just
 * the direct child, so a naive close-only wait can hang indefinitely even
 * though the tracked process itself is long gone -- and since this is the
 * same wait every caller (runManaged, spawnHandleManaged, the acquireRelease
 * finalizer) ultimately joins before it can do anything else, that hang
 * previously meant the finalizer that would otherwise TERM/KILL the process
 * group was never even reached.
 *
 * Once 'exit' fires without a prompt 'close', this re-signals the process
 * group (still a valid target even after the original leader has exited, as
 * long as any member survives -- `trySignalGroup`'s ESRCH fallback makes a
 * fully-empty group a harmless no-op) through the same TERM -> grace -> KILL
 * ladder used elsewhere, then gives the pipe one bounded window to actually
 * close before giving up and resolving with the exit's own code/signal. The
 * caller gets whatever output had already streamed in instead of the
 * supervisor hanging forever over a pipe a surviving grandchild may never
 * release on its own.
 */
const waitForClose = (
  child: ChildProcess,
  gracePeriodMs: number = defaultGracePeriodMs,
): Effect.Effect<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> =>
  Effect.async((resume) => {
    if (hasExited(child)) {
      resume(Effect.succeed({ code: child.exitCode, signal: child.signalCode }))
      return
    }

    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let forceTimer: ReturnType<typeof setTimeout> | undefined

    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return
      }
      settled = true
      if (killTimer !== undefined) {
        clearTimeout(killTimer)
      }
      if (forceTimer !== undefined) {
        clearTimeout(forceTimer)
      }
      resume(Effect.succeed({ code, signal }))
    }

    child.once("close", (code, signal) => settle(code, signal as NodeJS.Signals | null))

    child.once("exit", (exitCode, exitSignal) => {
      const pid = child.pid

      if (pid === undefined) {
        settle(exitCode, exitSignal as NodeJS.Signals | null)
        return
      }

      trySignalGroup(pid, "SIGTERM")

      killTimer = setTimeout(() => {
        if (settled) {
          return
        }
        trySignalGroup(pid, "SIGKILL")
        forceTimer = setTimeout(
          () => settle(exitCode, exitSignal as NodeJS.Signals | null),
          gracePeriodMs,
        )
      }, gracePeriodMs)
    })
  })

/** TERM the owned process group, wait a bounded grace period, escalate to KILL, then join exit. */
const escalateIfRunning = (child: ChildProcess, gracePeriodMs: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    const pid = child.pid

    if (pid === undefined || hasExited(child)) {
      return
    }

    trySignalGroup(pid, "SIGTERM")

    const timer = yield* Effect.fork(Effect.sleep(Duration.millis(gracePeriodMs)))
    yield* waitForClose(child, gracePeriodMs).pipe(Effect.raceFirst(Effect.fromFiber(timer)))

    if (!hasExited(child)) {
      trySignalGroup(pid, "SIGKILL")
    }

    yield* waitForClose(child, gracePeriodMs)
  })

/**
 * Sends a non-SIGTERM "polite" signal (e.g. SIGINT to let xctrace finalize
 * and flush its .trace bundle) and gives it a full, uncontested grace window
 * to work before anything more aggressive is sent. Only escalates through the
 * TERM -> grace -> KILL ladder if the process is still alive after that first
 * window -- racing SIGTERM in immediately behind SIGINT (as a single shared
 * grace window would) can abort a tool's SIGINT-specific graceful-shutdown
 * routine before it finishes, which is exactly the failure this avoids.
 */
const stopGracefully = (
  child: ChildProcess,
  signal: NodeJS.Signals,
  gracePeriodMs: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const pid = child.pid

    if (pid === undefined || hasExited(child)) {
      return
    }

    trySignalGroup(pid, signal)

    const timer = yield* Effect.fork(Effect.sleep(Duration.millis(gracePeriodMs)))
    yield* waitForClose(child, gracePeriodMs).pipe(Effect.raceFirst(Effect.fromFiber(timer)))

    if (!hasExited(child)) {
      yield* escalateIfRunning(child, gracePeriodMs)
    }
  })

type ChildRegistry = Ref.Ref<Map<number, ChildProcess>>

const registerChild = (registry: ChildRegistry, pid: number | undefined, child: ChildProcess): Effect.Effect<void> =>
  pid === undefined
    ? Effect.void
    : Ref.update(registry, (current) => {
      const next = new Map(current)
      next.set(pid, child)
      return next
    })

const deregisterChild = (registry: ChildRegistry, pid: number | undefined): Effect.Effect<void> =>
  pid === undefined
    ? Effect.void
    : Ref.update(registry, (current) => {
      if (!current.has(pid)) {
        return current
      }
      const next = new Map(current)
      next.delete(pid)
      return next
    })

const spawnChild = (spec: AppleProcessSpec, stdin: "ignore" | "pipe"): Effect.Effect<ChildProcess, ChildProcessError> =>
  Effect.async((resume) => {
    const child = spawn(spec.command, [...spec.commandArgs], {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: [stdin, "pipe", "pipe"],
      // Every supervised child becomes its own process-group leader so TERM/KILL
      // can be delivered to the whole descendant tree, not just the direct child.
      detached: true,
    })

    child.once("error", (error) => {
      spec.onSpawnError?.(error)
      resume(
        Effect.fail(
          new ChildProcessError({
            code: "command-spawn-failed",
            command: commandLabel(spec),
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Verify the local toolchain installation and retry the command.",
            exitCode: null,
            stderrExcerpt: "",
          }),
        ),
      )
    })

    child.once("spawn", () => resume(Effect.succeed(child)))
  })

const attachSinks = (
  child: ChildProcess,
  spec: AppleProcessSpec,
  stdoutSink: BoundedSink,
  stderrSink: BoundedSink,
): void => {
  // `externalStdout` callers (LldbBridge's line-framed stdin/stdout protocol)
  // drive `child.stdout` themselves via the handle -- leaving it unattached
  // here keeps the stream in paused/buffered mode until they do, instead of
  // this listener eagerly consuming (and discarding) chunks emitted before
  // the caller has a chance to attach its own reader.
  if (!spec.externalStdout) {
    const stdoutSource = spec.stdoutTransform ? child.stdout?.pipe(spec.stdoutTransform) : child.stdout
    stdoutSource?.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
      stdoutSink.write(buffer)
      spec.onStdoutChunk?.(buffer)
    })
    // A transform-driven pipeline can emit 'error' (e.g. an export-budget guard
    // rejecting more output than the caller wants to accept). The transform's own
    // failure reason surfaces through the caller's post-processing of the result;
    // this listener's job is only to stop treating the child as worth keeping
    // alive -- TERM it immediately instead of waiting for its natural exit or the
    // full timeout window.
    stdoutSource?.on("error", () => {
      if (spec.stdoutTransform && child.pid !== undefined && !hasExited(child)) {
        trySignalGroup(child.pid, "SIGTERM")
      }
    })
  }
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrSink.write(chunk)
    spec.onStderrChunk?.(chunk)
  })
}

const buildResult = (args: {
  readonly closeResult: { readonly code: number | null; readonly signal: NodeJS.Signals | null }
  readonly stdoutSink: BoundedSink
  readonly stderrSink: BoundedSink
  readonly startedAt: number
  readonly timedOut: boolean
  readonly cancelled?: boolean
}): AppleProcessResult => ({
  stdout: args.stdoutSink.text(),
  stderr: args.stderrSink.text(),
  stdoutTruncated: args.stdoutSink.truncated,
  stderrTruncated: args.stderrSink.truncated,
  stdoutBytesWritten: args.stdoutSink.totalBytesWritten(),
  exitCode: args.closeResult.code,
  signal: args.closeResult.signal,
  durationMs: Date.now() - args.startedAt,
  timedOut: args.timedOut,
  cancelled: args.cancelled ?? false,
})

/** Resolves once `signal` aborts (or immediately if it already has). */
const awaitAbort = (signal: AbortSignal): Effect.Effect<void> =>
  signal.aborted
    ? Effect.void
    : Effect.async<void>((resume) => {
      const onAbort = () => resume(Effect.void)
      signal.addEventListener("abort", onAbort, { once: true })
      return Effect.sync(() => signal.removeEventListener("abort", onAbort))
    })

const ensureArtifactDirectories = (spec: AppleProcessSpec): Effect.Effect<void> =>
  Effect.promise(async () => {
    await Promise.all(
      [spec.stdoutArtifactPath, spec.stderrArtifactPath]
        .filter((path): path is string => path !== undefined)
        .map((path) => mkdir(dirname(path), { recursive: true })),
    )
  })

const runManaged = (
  registry: ChildRegistry,
  spec: AppleProcessSpec,
): Effect.Effect<AppleProcessResult, ChildProcessError> =>
  Effect.gen(function* () {
    const startedAt = Date.now()
    const gracePeriodMs = spec.gracePeriodMs ?? defaultGracePeriodMs
    const stdoutSink = new BoundedSink(spec.maxBufferedBytes ?? defaultMaxBufferedBytes, spec.stdoutArtifactPath)
    const stderrSink = new BoundedSink(spec.maxBufferedBytes ?? defaultMaxBufferedBytes, spec.stderrArtifactPath)

    yield* ensureArtifactDirectories(spec)

    const scoped = Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawnChild(spec, "ignore")

        // Registered before this Effect ever returns a handle/result to the
        // caller, and only removed (via the release below) after the process
        // has exited and its stdio has closed.
        yield* Effect.acquireRelease(registerChild(registry, child.pid, child), () =>
          Effect.gen(function* () {
            yield* escalateIfRunning(child, gracePeriodMs)
            yield* deregisterChild(registry, child.pid)
          }))

        attachSinks(child, spec, stdoutSink, stderrSink)

        const closeResult = yield* waitForClose(child, gracePeriodMs)
        return closeResult
      }),
    )

    const timed = spec.timeoutMs === undefined
      ? scoped.pipe(Effect.map((closeResult) => ({ timedOut: false as const, closeResult })))
      : scoped.pipe(
        Effect.timeoutFail({
          duration: Duration.millis(spec.timeoutMs),
          onTimeout: () => "apple-process-timeout" as const,
        }),
        Effect.map((closeResult) => ({ timedOut: false as const, closeResult })),
        Effect.catchAll((failure) =>
          failure === "apple-process-timeout"
            ? Effect.succeed({ timedOut: true as const, closeResult: { code: null, signal: null } })
            : Effect.fail(failure)),
      )

    // `spec.signal` races the whole timed/scoped computation the same way
    // `Fiber.interrupt` already does in the fiber-interruption test below --
    // aborting interrupts the loser (`timed`, wrapping `scoped`), which runs
    // the acquireRelease release above (TERM -> grace -> KILL) exactly like a
    // direct interrupt would. No second kill path to keep in sync.
    const raced = spec.signal === undefined
      ? timed.pipe(Effect.map((outcome) => ({ ...outcome, cancelled: false as const })))
      : Effect.raceFirst(
        timed.pipe(Effect.map((outcome) => ({ ...outcome, cancelled: false as const }))),
        awaitAbort(spec.signal).pipe(
          Effect.as({ timedOut: false as const, cancelled: true as const, closeResult: { code: null, signal: null } }),
        ),
      )

    const outcome = yield* raced
    yield* stdoutSink.close()
    yield* stderrSink.close()

    // A timeout/cancellation never fails `run` -- the process is already
    // killed by this point (the scope's release ran via interruption), and
    // the caller keeps full access to whatever stdout/stderr was captured
    // before the kill to build its own typed error / log artifact instead of
    // only a tail excerpt.
    return buildResult({
      closeResult: outcome.closeResult,
      stdoutSink,
      stderrSink,
      startedAt,
      timedOut: outcome.timedOut,
      cancelled: outcome.cancelled,
    })
  })

const spawnHandleManaged = (
  registry: ChildRegistry,
  spec: AppleProcessSpec,
): Effect.Effect<AppleProcessHandle, ChildProcessError> =>
  Effect.gen(function* () {
    const startedAt = Date.now()
    const gracePeriodMs = spec.gracePeriodMs ?? defaultGracePeriodMs
    const stdoutSink = new BoundedSink(spec.maxBufferedBytes ?? defaultMaxBufferedBytes, spec.stdoutArtifactPath)
    const stderrSink = new BoundedSink(spec.maxBufferedBytes ?? defaultMaxBufferedBytes, spec.stderrArtifactPath)

    yield* ensureArtifactDirectories(spec)

    const child = yield* spawnChild(spec, spec.stdin ?? "ignore")
    const pid = child.pid

    yield* registerChild(registry, pid, child)
    attachSinks(child, spec, stdoutSink, stderrSink)

    let timedOut = false

    // A long-lived handle can still carry an overall timeout (e.g. a bounded
    // recording window): a daemon-forked watchdog escalates it the same way
    // interruption/stop() do, independent of whoever is holding the handle.
    if (spec.timeoutMs !== undefined) {
      yield* Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(spec.timeoutMs!))
        if (!hasExited(child)) {
          timedOut = true
          yield* escalateIfRunning(child, gracePeriodMs)
        }
      }).pipe(Effect.forkDaemon)
    }

    let settled: Promise<AppleProcessResult> | undefined
    const settle = (): Promise<AppleProcessResult> => {
      if (!settled) {
        settled = Effect.runPromise(
          Effect.gen(function* () {
            const closeResult = yield* waitForClose(child, gracePeriodMs)
            yield* deregisterChild(registry, pid)
            yield* stdoutSink.close()
            yield* stderrSink.close()
            return buildResult({ closeResult, stdoutSink, stderrSink, startedAt, timedOut })
          }),
        )
      }
      return settled
    }

    return {
      pid: pid ?? -1,
      isRunning: () => !hasExited(child),
      stop: (signal = "SIGTERM") =>
        Effect.runPromise(
          Effect.gen(function* () {
            if (signal === "SIGTERM") {
              yield* escalateIfRunning(child, gracePeriodMs)
            } else {
              yield* stopGracefully(child, signal, gracePeriodMs)
            }
            return yield* Effect.promise(() => settle())
          }),
        ),
      awaitExit: settle(),
      stdin: spec.stdin === "pipe" ? (child.stdin ?? null) : null,
      stdout: spec.externalStdout ? (child.stdout ?? null) : null,
    } satisfies AppleProcessHandle
  })

export class AppleProcessSupervisor extends Context.Tag("@probe/AppleProcessSupervisor")<
  AppleProcessSupervisor,
  {
    /** Foreground or streamed-to-artifact execution. Resolves once the process closes. */
    readonly run: (spec: AppleProcessSpec) => Effect.Effect<AppleProcessResult, ChildProcessError>
    /** Long-lived handle (e.g. a background recording or wrapper process) with explicit stop(). */
    readonly spawnHandle: (spec: AppleProcessSpec) => Effect.Effect<AppleProcessHandle, ChildProcessError>
    readonly activeChildCount: Effect.Effect<number>
  }
>() {}

export const AppleProcessSupervisorLive = Layer.scoped(
  AppleProcessSupervisor,
  Effect.gen(function* () {
    const registry: ChildRegistry = yield* Ref.make(new Map<number, ChildProcess>())

    // Defensive backstop for daemon shutdown: kill anything still registered
    // that a caller's own scope/interruption did not already clean up.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const remaining = yield* Ref.get(registry)
        for (const child of remaining.values()) {
          yield* escalateIfRunning(child, defaultGracePeriodMs)
        }
        yield* Ref.set(registry, new Map())
      }).pipe(Effect.catchAll(() => Effect.void)))

    return AppleProcessSupervisor.of({
      run: (spec) => runManaged(registry, spec),
      spawnHandle: (spec) => spawnHandleManaged(registry, spec),
      activeChildCount: Ref.get(registry).pipe(Effect.map((current) => current.size)),
    })
  }),
)

const runtime = ManagedRuntime.make(AppleProcessSupervisorLive)

/**
 * `runtime.runPromise` rejects a failed Effect with a FiberFailure wrapper, not
 * the raw typed error -- routing the failure channel through `Effect.either`
 * first and re-throwing manually keeps every Promise-bridge caller's existing
 * `instanceof ChildProcessError` checks working unchanged.
 */
const runPromiseUnwrapped = <A, E>(effect: Effect.Effect<A, E, AppleProcessSupervisor>): Promise<A> =>
  runtime.runPromise(Effect.either(effect)).then((either) => {
    if (either._tag === "Left") {
      throw either.left
    }
    return either.right
  })

/** Promise bridge for the existing Promise-shaped call sites in the tool wrappers. */
export const runAppleProcess = (spec: AppleProcessSpec): Promise<AppleProcessResult> =>
  runPromiseUnwrapped(Effect.flatMap(AppleProcessSupervisor, (supervisor) => supervisor.run(spec)))

/** Promise bridge for long-lived handles (background recordings, wrapper processes). */
export const spawnAppleProcessHandle = (spec: AppleProcessSpec): Promise<AppleProcessHandle> =>
  runPromiseUnwrapped(Effect.flatMap(AppleProcessSupervisor, (supervisor) => supervisor.spawnHandle(spec)))

/**
 * Closes the module-level runtime's scope, running `AppleProcessSupervisorLive`'s
 * defensive finalizer (kill anything still registered) before the daemon
 * process exits. `ManagedRuntime.make(...)` never closes its own scope on its
 * own -- the finalizer that daemon-shutdown fault tests prove against a
 * directly-built-and-closed layer scope only reaches a real running daemon if
 * something in the daemon's own shutdown path calls this. `probe serve`'s
 * shutdown (`ProbeKernel.serve`'s `onMetadataRemove`) is that caller.
 *
 * Not for use in request-scoped code -- this is a process-lifetime, call-once
 * operation. Once disposed, further `runAppleProcess`/`spawnAppleProcessHandle`
 * calls on this module fail; only call this when the daemon itself is
 * shutting down.
 */
export const disposeAppleProcessSupervisorRuntime = (): Promise<void> => runtime.dispose()
