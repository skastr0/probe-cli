import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChildProcessError } from "../domain/errors"
import {
  runCommandWithCapturedStdout,
  runCommandWithExit,
  runSimulatorHostCommand,
  startMarkedRecording,
  startSimulatorRunnerWrapperProcess,
  stopSimulatorRunnerWrapperProcess,
} from "./SimulatorHarness"

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

  test("runCommandWithCapturedStdout streams the full artifact past the 2 MiB in-memory cap", async () => {
    await withTempDir(async (dir) => {
      const stdoutPath = join(dir, "captured-large.out")
      const totalBytes = 5 * 1024 * 1024

      await runCommandWithCapturedStdout({
        command: "/bin/sh",
        commandArgs: ["-c", `head -c ${totalBytes} /dev/zero | tr '\\0' 'a'`],
        stdoutPath,
      })

      // This is the regression this test guards: the old implementation wrote
      // the bounded in-memory `result.stdout` (default cap 2 MiB) to disk
      // instead of the supervisor's streamed artifact, silently truncating
      // any capture -- like the `log stream` capture this backs -- larger
      // than the cap.
      const stats = await stat(stdoutPath)
      expect(stats.size).toBe(totalBytes)
    })
  })

  test("startMarkedRecording waits for the stderr marker, then stops gracefully once the duration elapses", async () => {
    const result = await startMarkedRecording({
      command: "/bin/sh",
      commandArgs: [
        "-c",
        "trap 'exit 0' INT; echo 'Recording started' 1>&2; while true; do sleep 0.05; done",
      ],
      startedMarker: "Recording started",
      startupTimeoutMs: 5_000,
      durationMs: 200,
      gracePeriodMs: 1_000,
    })

    expect(result.stopRequested).toBe(true)
    expect(result.exitCode === 0 || result.signal === "SIGINT").toBe(true)
  })

  test("startMarkedRecording requests a stop if the marker never arrives within the startup window", async () => {
    const start = Date.now()

    const result = await startMarkedRecording({
      command: "/bin/sh",
      commandArgs: ["-c", "trap 'exit 0' INT; while true; do sleep 0.05; done"],
      startedMarker: "Recording started",
      startupTimeoutMs: 200,
      durationMs: 30_000,
      gracePeriodMs: 1_000,
    })

    expect(result.stopRequested).toBe(true)
    // Stopped by the startup timeout, nowhere near the 30s duration window.
    expect(Date.now() - start).toBeLessThan(3_000)
  })

  test(
    "startSimulatorRunnerWrapperProcess/stop leave zero surviving descendants and append stderr linearly",
    async () => {
      await withTempDir(async (dir) => {
        const wrapperStderrPath = join(dir, "wrapper.stderr.log")

        const wrapper = await startSimulatorRunnerWrapperProcess({
          command: "/bin/sh",
          // A process-group leader that emits stderr and forks descendants,
          // mirroring the real xcodebuild/XCUITest wrapper shape closely
          // enough to exercise the same lifecycle path.
          commandArgs: ["-c", "echo wrapper-stderr-line 1>&2; sleep 30 & sleep 30 & wait"],
          cwd: dir,
          observerControlDirectory: join(dir, "observer-control"),
          wrapperStderrPath,
        })

        await new Promise((resolve) => setTimeout(resolve, 150))

        expect(wrapper.handle.isRunning()).toBe(true)
        const membersBeforeStop = processGroupMembers(wrapper.handle.pid)
        expect(membersBeforeStop.length).toBeGreaterThan(0)

        const logged = await readFile(wrapperStderrPath, "utf8")
        expect(logged).toContain("wrapper-stderr-line")

        await stopSimulatorRunnerWrapperProcess(wrapper)

        expect(wrapper.handle.isRunning()).toBe(false)
        expect(processGroupMembers(wrapper.handle.pid).length).toBe(0)

        const exitResult = await wrapper.exit
        expect(exitResult.code === 0 || exitResult.signal !== null).toBe(true)
      })
    },
  )

  test("stopSimulatorRunnerWrapperProcess is a no-op once the wrapper has already exited", async () => {
    await withTempDir(async (dir) => {
      const wrapper = await startSimulatorRunnerWrapperProcess({
        command: "/bin/sh",
        commandArgs: ["-c", "exit 0"],
        cwd: dir,
        observerControlDirectory: join(dir, "observer-control"),
        wrapperStderrPath: join(dir, "wrapper.stderr.log"),
      })

      await wrapper.exit
      expect(wrapper.handle.isRunning()).toBe(false)

      // Should resolve immediately without attempting to signal a dead pid.
      await stopSimulatorRunnerWrapperProcess(wrapper)
    })
  })
})
