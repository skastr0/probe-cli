import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
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
})
