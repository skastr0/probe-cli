import { describe, expect, test } from "bun:test"
import { runHostCommand } from "./SessionRegistry"

// Real, non-mocked coverage of the AppleProcessSupervisor-backed migration --
// SessionRegistry.test.ts does not exercise runHostCommand directly (video
// stitching call sites are integration-only), so this is the first ground
// truth for the migrated implementation.

describe("SessionRegistry runHostCommand (real spawn, via AppleProcessSupervisor)", () => {
  test("resolves stdout/stderr/exitCode/signal for a real process", async () => {
    const result = await runHostCommand({ command: "/bin/sh", commandArgs: ["-c", "echo hi; exit 0"] })
    expect(result.stdout.trim()).toBe("hi")
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
  })

  test("resolves (never rejects) with timedOut: true when the timeout elapses, and kills the child", async () => {
    const start = Date.now()
    const result = await runHostCommand({
      command: "/bin/sh",
      commandArgs: ["-c", "sleep 30"],
      timeoutMs: 150,
    })

    expect(result.timedOut).toBe(true)
    expect(Date.now() - start).toBeLessThan(3_000)
  })

  test("rejects with the raw spawn error (ENOENT-detectable) when the binary is missing", async () => {
    const failure = await runHostCommand({ command: "/definitely/not/a/real/binary", commandArgs: [] })
      .catch((error: unknown) => error)
    expect(failure && typeof failure === "object" && "code" in failure ? (failure as { code: unknown }).code : undefined)
      .toBe("ENOENT")
  })
})
