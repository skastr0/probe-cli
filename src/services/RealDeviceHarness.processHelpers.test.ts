import { describe, expect, test } from "bun:test"
import { runRealDeviceHostCommand } from "./RealDeviceHarness"

// Real, non-mocked coverage of the AppleProcessSupervisor-backed migration.

describe("RealDeviceHarness runCommand (real spawn, via AppleProcessSupervisor)", () => {
  test("resolves stdout/stderr/exitCode for a real process regardless of exit code", async () => {
    const result = await runRealDeviceHostCommand({ command: "/bin/sh", commandArgs: ["-c", "echo hi; exit 4"] })
    expect(result.stdout.trim()).toBe("hi")
    expect(result.exitCode).toBe(4)
  })

  test("rejects with a plain Error on timeout and kills the child", async () => {
    const start = Date.now()
    await expect(
      runRealDeviceHostCommand({ command: "/bin/sh", commandArgs: ["-c", "sleep 30"], timeoutMs: 150 }),
    ).rejects.toThrow(/timed out after 150 ms/)
    expect(Date.now() - start).toBeLessThan(3_000)
  })

  test("rejects with the raw spawn error when the binary is missing", async () => {
    const failure = await runRealDeviceHostCommand({ command: "/definitely/not/a/real/binary", commandArgs: [] })
      .catch((error: unknown) => error)
    expect(failure && typeof failure === "object" && "code" in failure ? (failure as { code: unknown }).code : undefined)
      .toBe("ENOENT")
  })
})
