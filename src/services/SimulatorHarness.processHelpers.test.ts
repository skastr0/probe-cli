import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChildProcessError } from "../domain/errors"
import { runCommandWithCapturedStdout, runCommandWithExit, runSimulatorHostCommand } from "./SimulatorHarness"

// Real, non-mocked coverage of the AppleProcessSupervisor-backed migration.

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "simulator-harness-process-helpers-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

describe("SimulatorHarness process helpers (real spawn, via AppleProcessSupervisor)", () => {
  test("runCommandWithExit resolves regardless of exit code", async () => {
    const result = await runCommandWithExit({ command: "/bin/sh", commandArgs: ["-c", "echo hi; exit 5"] })
    expect(result.stdout.trim()).toBe("hi")
    expect(result.exitCode).toBe(5)
  })

  test("runCommand (aliased runSimulatorHostCommand) resolves on success and writes the log file", async () => {
    await withTempDir(async (dir) => {
      const logPath = join(dir, "cmd.log")
      const result = await runSimulatorHostCommand({
        command: "/bin/sh",
        commandArgs: ["-c", "echo out; echo err 1>&2"],
        logPath,
      })
      expect(result.stdout.trim()).toBe("out")
      const logged = await readFile(logPath, "utf8")
      expect(logged).toContain("out")
      expect(logged).toContain("err")
    })
  })

  test("runCommand rejects with command-timeout and kills the child", async () => {
    const start = Date.now()
    await expect(
      runSimulatorHostCommand({ command: "/bin/sh", commandArgs: ["-c", "sleep 30"], timeoutMs: 150 }),
    ).rejects.toMatchObject({ code: "command-timeout" })
    expect(Date.now() - start).toBeLessThan(3_000)
  })

  test("runCommandWithCapturedStdout writes stdout to the given path and rejects on non-zero exit", async () => {
    await withTempDir(async (dir) => {
      const stdoutPath = join(dir, "captured.out")

      const ok = await runCommandWithCapturedStdout({
        command: "/bin/sh",
        commandArgs: ["-c", "echo captured"],
        stdoutPath,
      })
      expect(ok.stdout.trim()).toBe("captured")
      expect((await readFile(stdoutPath, "utf8")).trim()).toBe("captured")

      const failure = await runCommandWithCapturedStdout({
        command: "/bin/sh",
        commandArgs: ["-c", "exit 1"],
        stdoutPath,
      }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ChildProcessError)
    })
  })
})
