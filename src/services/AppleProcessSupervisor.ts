import { type ChildProcess, spawn } from "node:child_process"
import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { Transform } from "node:stream"
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

const waitForClose = (
  child: ChildProcess,
): Effect.Effect<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> =>
  Effect.async((resume) => {
    if (hasExited(child)) {
      resume(Effect.succeed({ code: child.exitCode, signal: child.signalCode }))
      return
    }

    child.once("close", (code, signal) => {
      resume(Effect.succeed({ code, signal: signal as NodeJS.Signals | null }))
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
    yield* waitForClose(child).pipe(Effect.raceFirst(Effect.fromFiber(timer)))

    if (!hasExited(child)) {
      trySignalGroup(pid, "SIGKILL")
    }

    yield* waitForClose(child)
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
    yield* waitForClose(child).pipe(Effect.raceFirst(Effect.fromFiber(timer)))

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
  const stdoutSource = spec.stdoutTransform ? child.stdout?.pipe(spec.stdoutTransform) : child.stdout
  stdoutSource?.on("data", (chunk: Buffer | string) => {
    stdoutSink.write(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk)
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
  child.stderr?.on("data", (chunk: Buffer) => stderrSink.write(chunk))
}

const buildResult = (args: {
  readonly closeResult: { readonly code: number | null; readonly signal: NodeJS.Signals | null }
  readonly stdoutSink: BoundedSink
  readonly stderrSink: BoundedSink
  readonly startedAt: number
  readonly timedOut: boolean
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

        const closeResult = yield* waitForClose(child)
        return closeResult
      }),
    )

    const raced = spec.timeoutMs === undefined
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

    const outcome = yield* raced
    yield* stdoutSink.close()
    yield* stderrSink.close()

    // A timeout never fails `run` -- the process is already killed by this
    // point (the scope's release ran via interruption), and the caller keeps
    // full access to whatever stdout/stderr was captured before the kill to
    // build its own typed error / log artifact instead of only a tail excerpt.
    return buildResult({ closeResult: outcome.closeResult, stdoutSink, stderrSink, startedAt, timedOut: outcome.timedOut })
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

    const child = yield* spawnChild(spec, "ignore")
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
            const closeResult = yield* waitForClose(child)
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
