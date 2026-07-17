import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChildProcessError } from "../domain/errors"
import { liveStartRecording, runCommand, runCommandToFile } from "./PerfService"

// These exercise the real AppleProcessSupervisor-backed implementations (not the
// PerfCommandRunner mock every other PerfService.test.ts case uses), proving the
// PRB-085 migration preserved runCommand/runCommandToFile/liveStartRecording's
// external contract.

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "perf-process-helpers-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

describe("PerfService process helpers (real spawn, via AppleProcessSupervisor)", () => {
  test("runCommand resolves stdout/stderr/exitCode for a real process", async () => {
    const result = await runCommand({
      command: "/bin/sh",
      commandArgs: ["-c", "echo hello; echo world 1>&2"],
      timeoutMs: 5_000,
    })

    expect(result.stdout.trim()).toBe("hello")
    expect(result.stderr.trim()).toBe("world")
    expect(result.exitCode).toBe(0)
  })

  test("runCommand rejects with command-failed on non-zero exit", async () => {
    await expect(
      runCommand({ command: "/bin/sh", commandArgs: ["-c", "exit 9"], timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "command-failed", exitCode: 9 })
  })

  test("runCommand rejects with command-timeout and the original wording, and kills the child", async () => {
    const start = Date.now()
    await expect(
      runCommand({
        command: "/bin/sh",
        commandArgs: ["-c", "sleep 30"],
        timeoutMs: 150,
        gracePeriodMs: 100,
      }),
    ).rejects.toMatchObject({ code: "command-timeout" })

    expect(Date.now() - start).toBeLessThan(2_000)
  })

  test("runCommandToFile streams stdout to the artifact path and reports exact bytesWritten", async () => {
    await withTempDir(async (dir) => {
      const outputPath = join(dir, "export.xml")
      const payload = "<row>a</row><row>b</row>"
      const result = await runCommandToFile({
        command: "/bin/sh",
        commandArgs: ["-c", `printf '%s' '${payload}'`],
        timeoutMs: 5_000,
        outputPath,
        budget: { maxBytes: 1024, maxRows: 10 },
      })

      expect(result.exitCode).toBe(0)
      expect(result.rowCount).toBe(2)
      expect(result.bytesWritten).toBe(Buffer.byteLength(payload, "utf8"))

      const written = await readFile(outputPath, "utf8")
      expect(written).toBe(payload)
    })
  })

  test("runCommandToFile rejects with the budget error and removes the partial artifact", async () => {
    await withTempDir(async (dir) => {
      const outputPath = join(dir, "export.xml")
      const rowTag = "<row>"
      const oversized = rowTag.repeat(5)

      await expect(
        runCommandToFile({
          command: "/bin/sh",
          commandArgs: ["-c", `printf '%s' '${oversized}'`],
          timeoutMs: 5_000,
          outputPath,
          budget: { maxBytes: 1024, maxRows: 2 },
        }),
      ).rejects.toMatchObject({ kind: "rows" })

      await expect(readFile(outputPath)).rejects.toThrow()
    })
  })

  test(
    "liveStartRecording waits for the startup signal, then stop() sends SIGINT and joins exit",
    async () => {
      const startupNotificationKey = `probe.test.perf-process-helpers.${process.pid}.${Date.now()}`

      const handle = await liveStartRecording({
        command: "/bin/sh",
        commandArgs: [
          "-c",
          `notifyutil -p ${startupNotificationKey}; trap 'exit 0' INT; while true; do sleep 0.05; done`,
        ],
        startupNotificationKey,
        // notifyutil's post/wait handshake is two independently-scheduled real
        // processes racing a Darwin distributed-notification registration --
        // under host contention (this file's other process-helper cases each
        // spawn real children too) the wait side has been observed to take
        // noticeably longer than 5s to register before the post fires,
        // without the handshake itself being broken; 5s reproducibly timed
        // this specific case out under contention even in this file alone.
        startupTimeoutMs: 15_000,
        timeoutMs: 30_000,
        gracePeriodMs: 1_000,
      })

      const result = await handle.stop()
      expect(result.wasRunning).toBe(true)
      expect(result.exitCode === 0 || result.exitCode === null).toBe(true)
    },
    // Covers the widened startupTimeoutMs above plus the recording/stop work
    // that follows it -- bun's 5000ms default test timeout is otherwise the
    // tighter wall here.
    20_000,
  )

  test("liveStartRecording rejects if the command exits before signaling startup", async () => {
    const startupNotificationKey = `probe.test.perf-process-helpers.never-posted.${process.pid}.${Date.now()}`

    const failure = await liveStartRecording({
      command: "/bin/sh",
      commandArgs: ["-c", "exit 1"],
      startupNotificationKey,
      startupTimeoutMs: 2_000,
      timeoutMs: 5_000,
      gracePeriodMs: 500,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ChildProcessError)
  })
})
