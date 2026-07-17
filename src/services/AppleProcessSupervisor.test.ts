import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Either, Fiber, Layer } from "effect"
import { ChildProcessError } from "../domain/errors"
import { AppleProcessSupervisor, AppleProcessSupervisorLive } from "./AppleProcessSupervisor"

const withSupervisor = <A, E>(
  effect: Effect.Effect<A, E, AppleProcessSupervisor>,
): Promise<A> => Effect.runPromise(Effect.scoped(Effect.provide(effect, AppleProcessSupervisorLive)))

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "apple-process-supervisor-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

/** Every pid currently alive in the process group led by `pgid` (best-effort, macOS/Linux `ps`). */
const processGroupMembers = (pgid: number): ReadonlyArray<number> => {
  try {
    const output = execFileSync("ps", ["-o", "pid=", "-g", String(pgid)], { encoding: "utf8" })
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(Number)
  } catch {
    return []
  }
}

describe("AppleProcessSupervisor", () => {
  test("run captures stdout, stderr, and exit code for a foreground command", async () => {
    const result = await withSupervisor(
      Effect.flatMap(AppleProcessSupervisor, (supervisor) =>
        supervisor.run({
          command: "/bin/sh",
          commandArgs: ["-c", "echo out-line; echo err-line 1>&2; exit 7"],
        })),
    )

    expect(result.stdout.trim()).toBe("out-line")
    expect(result.stderr.trim()).toBe("err-line")
    expect(result.exitCode).toBe(7)
    expect(result.stdoutTruncated).toBe(false)
  })

  test("run does not throw on a non-zero exit code -- exit interpretation is caller policy", async () => {
    const result = await withSupervisor(
      Effect.flatMap(AppleProcessSupervisor, (supervisor) =>
        supervisor.run({ command: "/bin/sh", commandArgs: ["-c", "exit 3"] })),
    )

    expect(result.exitCode).toBe(3)
  })

  test("run fails with a typed ChildProcessError when the command cannot be spawned", async () => {
    const exit = await withSupervisor(
      Effect.flatMap(AppleProcessSupervisor, (supervisor) =>
        supervisor.run({ command: "/definitely/not/a/real/binary", commandArgs: [] })).pipe(Effect.either),
    )

    expect(Either.isLeft(exit)).toBe(true)
    if (Either.isLeft(exit)) {
      expect(exit.left).toBeInstanceOf(ChildProcessError)
      expect(exit.left.code).toBe("command-spawn-failed")
    }
  })

  test("registers the child before the caller observes a handle and deregisters only after close", async () => {
    const observed = await withSupervisor(
      Effect.gen(function* () {
        const supervisor = yield* AppleProcessSupervisor
        const before = yield* supervisor.activeChildCount
        const runFiber = yield* Effect.fork(
          supervisor.run({ command: "/bin/sh", commandArgs: ["-c", "sleep 0.2"] }),
        )
        yield* Effect.sleep(Duration.millis(50))
        const during = yield* supervisor.activeChildCount
        yield* Fiber.join(runFiber)
        const after = yield* supervisor.activeChildCount
        return { before, during, after }
      }),
    )

    expect(observed.before).toBe(0)
    expect(observed.during).toBe(1)
    expect(observed.after).toBe(0)
  })

  test("timeout resolves with timedOut: true (never throws) and kills the child -- callers build their own typed error", async () => {
    const result = await withSupervisor(
      Effect.flatMap(AppleProcessSupervisor, (supervisor) =>
        supervisor.run({
          command: "/bin/sh",
          commandArgs: ["-c", "echo partial; sleep 30"],
          timeoutMs: 150,
          gracePeriodMs: 100,
        })),
    )

    expect(result.timedOut).toBe(true)
    expect(result.exitCode).not.toBe(0)
    // Full output captured before the kill is still available -- not just a tail excerpt.
    expect(result.stdout.trim()).toBe("partial")
  })

  test(
    "fiber interruption (client disconnect / request cancel) sends TERM -> grace -> KILL to the whole process group",
    async () => {
      const scriptPath = "/bin/sh"
      const before = await withSupervisor(
        Effect.gen(function* () {
          const supervisor = yield* AppleProcessSupervisor

          const runFiber = yield* Effect.fork(
            supervisor.run({
              command: scriptPath,
              // A process-group leader that forks three descendants and waits on them.
              commandArgs: ["-c", "sleep 30 & sleep 30 & sleep 30 & wait"],
              gracePeriodMs: 150,
            }),
          )

          yield* Effect.sleep(Duration.millis(150))
          const count = yield* supervisor.activeChildCount
          yield* Fiber.interrupt(runFiber)
          // Give the SIGTERM -> grace -> SIGKILL escalation time to complete.
          yield* Effect.sleep(Duration.millis(500))
          const after = yield* supervisor.activeChildCount
          return { count, after }
        }),
      )

      expect(before.count).toBe(1)
      expect(before.after).toBe(0)
    },
  )

  test("descendant fault test: zero surviving descendants after interrupt-equivalent stop", async () => {
    // detached: true makes the leader's own pid its process-group id, so a
    // long-lived handle gives us a real pgid to assert against with `ps`.
    const pgid = await withSupervisor(
      Effect.gen(function* () {
        const supervisor = yield* AppleProcessSupervisor
        const handle = yield* supervisor.spawnHandle({
          command: "/bin/sh",
          commandArgs: ["-c", "sleep 30 & sleep 30 & sleep 30 & wait"],
          gracePeriodMs: 150,
        })

        yield* Effect.sleep(Duration.millis(150))
        const membersBeforeStop = processGroupMembers(handle.pid)
        // stop() and fiber-interruption both route through the same
        // escalateIfRunning (TERM -> grace -> KILL -> join) implementation.
        yield* Effect.promise(() => handle.stop())
        return { pgid: handle.pid, membersBeforeStop }
      }),
    )

    expect(pgid.membersBeforeStop.length).toBeGreaterThan(0)
    expect(processGroupMembers(pgid.pgid).length).toBe(0)
  })

  test("daemon shutdown fault test: closing the supervisor's scope kills stragglers", async () => {
    let pid = -1

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const supervisor = yield* AppleProcessSupervisor
          const handle = yield* supervisor.spawnHandle({
            command: "/bin/sh",
            commandArgs: ["-c", "sleep 30"],
            gracePeriodMs: 150,
          })
          pid = handle.pid
          // The provided layer's scope closes when this effect completes, without
          // an explicit stop() -- simulating daemon shutdown. The layer's own
          // finalizer must still kill the child.
        }),
        AppleProcessSupervisorLive,
      ),
    )

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  test("spawnHandle exposes a long-lived process with explicit stop()", async () => {
    const outcome = await withSupervisor(
      Effect.gen(function* () {
        const supervisor = yield* AppleProcessSupervisor
        const handle = yield* supervisor.spawnHandle({
          command: "/bin/sh",
          commandArgs: ["-c", "trap 'exit 0' TERM; while true; do sleep 0.05; done"],
          gracePeriodMs: 300,
        })

        const runningBeforeStop = handle.isRunning()
        const result = yield* Effect.promise(() => handle.stop())
        return { runningBeforeStop, result }
      }),
    )

    expect(outcome.runningBeforeStop).toBe(true)
    expect(outcome.result.exitCode === 0 || outcome.result.signal !== null).toBe(true)
  })

  test("stop(SIGINT) lets a polite signal exit cleanly instead of racing an immediate SIGTERM behind it", async () => {
    // Regression coverage: stop() used to always chain straight into
    // escalateIfRunning, which sends SIGTERM immediately regardless of which
    // signal was just sent -- a tool that only traps SIGINT (like xctrace)
    // would get SIGINT and SIGTERM nearly simultaneously. A generous grace
    // period here makes the assertion meaningful: if SIGTERM were still being
    // raced in immediately, the process would still exit quickly (since
    // nothing traps TERM), so a long grace period alone wouldn't prove
    // anything -- the elapsed-time bound below is what actually distinguishes
    // "exited via its own INT trap" from "got killed".
    const start = Date.now()

    const outcome = await withSupervisor(
      Effect.gen(function* () {
        const supervisor = yield* AppleProcessSupervisor
        const handle = yield* supervisor.spawnHandle({
          command: "/bin/sh",
          commandArgs: ["-c", "trap 'exit 0' INT; while true; do sleep 0.05; done"],
          gracePeriodMs: 5_000,
        })

        // Give the shell time to reach and install the trap before signaling
        // it -- otherwise this races the shell's own startup and SIGINT can
        // arrive under its default (terminate, not caught) disposition.
        yield* Effect.sleep(Duration.millis(150))

        return yield* Effect.promise(() => handle.stop("SIGINT"))
      }),
    )

    expect(outcome.exitCode).toBe(0)
    expect(outcome.signal).toBeNull()
    // Exited via its own trap almost immediately -- nowhere near the 5s grace
    // window, which only a forced escalation would have consumed.
    expect(Date.now() - start).toBeLessThan(2_000)
  })

  test("stop(SIGINT) still escalates through TERM -> KILL if the process ignores every signal but KILL", async () => {
    const outcome = await withSupervisor(
      Effect.gen(function* () {
        const supervisor = yield* AppleProcessSupervisor
        const handle = yield* supervisor.spawnHandle({
          command: "/bin/sh",
          // Ignores both the initial polite signal and the TERM escalation
          // step, so only the final SIGKILL can end it -- proves the ladder's
          // safety net still runs, not just its new graceful first rung.
          commandArgs: ["-c", "trap '' INT TERM; while true; do sleep 0.05; done"],
          gracePeriodMs: 200,
        })

        // See the previous test -- avoid racing the shell's own startup.
        yield* Effect.sleep(Duration.millis(150))

        return yield* Effect.promise(() => handle.stop("SIGINT"))
      }),
    )

    expect(outcome.exitCode).toBeNull()
    expect(outcome.signal).toBe("SIGKILL")
  })

  test("bounded in-memory output stays capped while the artifact keeps the exact full bytes (5 MB)", async () => {
    await withTempDir(async (dir) => {
      const sourcePath = join(dir, "source.bin")
      const artifactPath = join(dir, "stdout.log")
      // ASCII text so the in-memory byte cap and the UTF-8-decoded string length
      // agree exactly -- command stdout/stderr from Apple CLIs is text, not the
      // arbitrary binary this test would otherwise need replacement-character
      // accounting for.
      const line = "probe-apple-process-supervisor-fault-test-fixture-line\n"
      const repeated = Buffer.from(line.repeat(Math.ceil((5 * 1024 * 1024) / line.length)), "utf8")
      const payload = repeated.subarray(0, 5 * 1024 * 1024)
      await Bun.write(sourcePath, payload)

      const maxBufferedBytes = 64 * 1024

      const result = await withSupervisor(
        Effect.flatMap(AppleProcessSupervisor, (supervisor) =>
          supervisor.run({
            command: "/bin/cat",
            commandArgs: [sourcePath],
            stdoutArtifactPath: artifactPath,
            maxBufferedBytes,
          })),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdoutBytesWritten).toBe(payload.byteLength)
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(maxBufferedBytes)
      expect(result.stdoutTruncated).toBe(true)

      const written = await readFile(artifactPath)
      expect(written.byteLength).toBe(payload.byteLength)
      expect(written.equals(payload)).toBe(true)
    })
  })

  test("large output cannot deadlock the child -- an unread pipe still drains", async () => {
    const result = await withSupervisor(
      Effect.flatMap(AppleProcessSupervisor, (supervisor) =>
        supervisor.run({
          command: "/bin/sh",
          commandArgs: ["-c", "head -c 3145728 /dev/zero | tr '\\0' 'a'"],
          maxBufferedBytes: 1024,
          timeoutMs: 10_000,
        })),
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdoutBytesWritten).toBe(3 * 1024 * 1024)
  })

  test("completion leaves no live registry entries, timers, or children behind", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const supervisor = yield* AppleProcessSupervisor
          yield* supervisor.run({ command: "/bin/sh", commandArgs: ["-c", "exit 0"] })
          const count = yield* supervisor.activeChildCount
          expect(count).toBe(0)
        }),
        AppleProcessSupervisorLive,
      ),
    )
  })

  // Every other test in this file exercises AppleProcessSupervisorLive's
  // finalizer through a freshly built-and-closed layer scope (withSupervisor /
  // Effect.provide directly) -- that is the exact gap the review found: the
  // *production* daemon path never builds/closes a layer scope, it uses the
  // module-level ManagedRuntime that backs runAppleProcess/spawnAppleProcessHandle,
  // which never closed on its own before disposeAppleProcessSupervisorRuntime
  // existed. This test proves the fix on that real path -- via a subprocess,
  // since disposing the module-level runtime is a one-shot, process-lifetime
  // operation that would otherwise poison every other test file in this run
  // that also imports the module-level promise bridges.
  test("disposeAppleProcessSupervisorRuntime closes the module-level runtime and kills stragglers", async () => {
    await withTempDir(async (dir) => {
      const scriptPath = join(dir, "dispose-check.ts")
      const supervisorModulePath = join(import.meta.dir, "AppleProcessSupervisor.ts")

      await writeFile(
        scriptPath,
        [
          `import { spawnAppleProcessHandle, disposeAppleProcessSupervisorRuntime } from ${JSON.stringify(supervisorModulePath)}`,
          "const handle = await spawnAppleProcessHandle({ command: \"/bin/sh\", commandArgs: [\"-c\", \"sleep 30\"], gracePeriodMs: 150 })",
          "process.stdout.write(`${handle.pid}\\n`)",
          "await disposeAppleProcessSupervisorRuntime()",
          "process.exit(0)",
        ].join("\n"),
        "utf8",
      )

      const stdout = execFileSync(process.execPath, ["run", scriptPath], { encoding: "utf8", timeout: 10_000 })
      const pid = Number(stdout.trim())

      expect(Number.isInteger(pid)).toBe(true)
      expect(() => process.kill(pid, 0)).toThrow()
    })
  })

  test("onStderrChunk observes raw chunks without disturbing the supervisor's own bounded capture", async () => {
    const observed: Array<string> = []

    const result = await withSupervisor(
      Effect.flatMap(AppleProcessSupervisor, (supervisor) =>
        supervisor.run({
          command: "/bin/sh",
          commandArgs: ["-c", "echo mark-one 1>&2; echo mark-two 1>&2"],
          onStderrChunk: (chunk) => observed.push(chunk.toString("utf8")),
        })),
    )

    expect(observed.join("")).toContain("mark-one")
    expect(observed.join("")).toContain("mark-two")
    // The hook is additive -- the supervisor's own bounded capture is unaffected.
    expect(result.stderr).toContain("mark-one")
    expect(result.stderr).toContain("mark-two")
  })

  test("spawnHandle with stdin: \"pipe\" exposes a writable stdin the caller can drive", async () => {
    const outcome = await withSupervisor(
      Effect.gen(function* () {
        const supervisor = yield* AppleProcessSupervisor
        const handle = yield* supervisor.spawnHandle({
          command: "/bin/cat",
          commandArgs: [],
          stdin: "pipe",
          gracePeriodMs: 300,
        })

        expect(handle.stdin).not.toBeNull()
        handle.stdin?.write("hello-from-parent\n")
        handle.stdin?.end()

        return yield* Effect.promise(() => handle.awaitExit)
      }),
    )

    expect(outcome.exitCode).toBe(0)
    expect(outcome.stdout.trim()).toBe("hello-from-parent")
  })

  test(
    "spawnHandle with externalStdout: true leaves stdout paused for the caller -- no chunk lost to an eager default listener",
    async () => {
      const outcome = await withSupervisor(
        Effect.gen(function* () {
          const supervisor = yield* AppleProcessSupervisor
          const handle = yield* supervisor.spawnHandle({
            command: "/bin/sh",
            commandArgs: ["-c", "echo line-one; echo line-two"],
            externalStdout: true,
            gracePeriodMs: 300,
          })

          expect(handle.stdout).not.toBeNull()

          const collected: ReadonlyArray<string> = yield* Effect.promise(() =>
            new Promise<ReadonlyArray<string>>((resolve) => {
              const chunks: Array<string> = []
              // Attaching this listener only now (after spawn already returned)
              // is exactly the race an eager default listener would lose --
              // externalStdout guarantees the stream stayed paused until here.
              handle.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")))
              handle.stdout?.on("end", () => resolve(chunks))
            }))

          return { joined: collected.join(""), result: yield* Effect.promise(() => handle.awaitExit) }
        }),
      )

      expect(outcome.joined).toContain("line-one")
      expect(outcome.joined).toContain("line-two")
      // externalStdout means the supervisor's own capture stays empty --
      // the caller owns the stream instead.
      expect(outcome.result.stdout).toBe("")
    },
  )

  test("run() cancels via AbortSignal -- resolves cancelled: true and leaves zero surviving descendants", async () => {
    const controller = new AbortController()

    const observed = await withSupervisor(
      Effect.gen(function* () {
        const supervisor = yield* AppleProcessSupervisor
        const runFiber = yield* Effect.fork(
          supervisor.run({
            command: "/bin/sh",
            // A process-group leader that forks two descendants and waits on
            // them -- the same shape the descendant fault tests above use.
            commandArgs: ["-c", "echo partial; sleep 30 & sleep 30 & wait"],
            signal: controller.signal,
            gracePeriodMs: 150,
          }),
        )

        yield* Effect.sleep(Duration.millis(150))
        const during = yield* supervisor.activeChildCount
        controller.abort()
        const result = yield* Fiber.join(runFiber)
        const after = yield* supervisor.activeChildCount

        return { during, after, result }
      }),
    )

    expect(observed.during).toBe(1)
    expect(observed.after).toBe(0)
    expect(observed.result.cancelled).toBe(true)
    expect(observed.result.timedOut).toBe(false)
    expect(observed.result.stdout.trim()).toBe("partial")
    expect(observed.result.exitCode).not.toBe(0)
  })

  test("run() never triggers cancellation when the signal never aborts", async () => {
    const controller = new AbortController()

    const result = await withSupervisor(
      Effect.flatMap(AppleProcessSupervisor, (supervisor) =>
        supervisor.run({
          command: "/bin/sh",
          commandArgs: ["-c", "echo done; exit 0"],
          signal: controller.signal,
        })),
    )

    expect(result.cancelled).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe("done")
  })

  test("stdin/stdout pipe handle still leaves zero surviving descendants after stop()", async () => {
    const pgid = await withSupervisor(
      Effect.gen(function* () {
        const supervisor = yield* AppleProcessSupervisor
        const handle = yield* supervisor.spawnHandle({
          command: "/bin/sh",
          commandArgs: ["-c", "sleep 30 & sleep 30 & wait"],
          stdin: "pipe",
          externalStdout: true,
          gracePeriodMs: 150,
        })

        // Drain stdout so the child can never block on pipe backpressure.
        handle.stdout?.resume()

        yield* Effect.sleep(Duration.millis(150))
        const membersBeforeStop = processGroupMembers(handle.pid)
        yield* Effect.promise(() => handle.stop())
        return { pgid: handle.pid, membersBeforeStop }
      }),
    )

    expect(pgid.membersBeforeStop.length).toBeGreaterThan(0)
    expect(processGroupMembers(pgid.pgid).length).toBe(0)
  })
})
