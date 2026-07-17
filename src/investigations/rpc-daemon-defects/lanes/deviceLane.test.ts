import { describe, expect, test } from "bun:test"
import type { CommandResult, CommandRunner } from "../commandRunner"
import { runDeviceLane } from "./deviceLane"

const fail = (stderr: string): CommandResult => ({ status: 1, stdout: "", stderr })

const runnerWritingJsonOutput = (payload: unknown): CommandRunner => (_command, args) => {
  const outputPathIndex = args.indexOf("--json-output") + 1
  const outputPath = args[outputPathIndex]!
  Bun.write(outputPath, JSON.stringify(payload))
  return { status: 0, stdout: "", stderr: "" }
}

describe("device lane", () => {
  test("reports attempted-failed, not silently skipped, when devicectl fails", async () => {
    const runner: CommandRunner = () => fail("devicectl not found")
    const result = await runDeviceLane(runner)

    expect(result.lane).toBe("device")
    expect(result.status).toBe("attempted-failed")
    expect(result.receipts.length).toBeGreaterThan(0)
    expect(result.summary.length).toBeGreaterThan(0)
  })

  test("reports attempted-failed with an explicit reason when no device is attached", async () => {
    const result = await runDeviceLane(runnerWritingJsonOutput({ result: { devices: [] } }))

    expect(result.status).toBe("attempted-failed")
    expect(result.summary.toLowerCase()).toContain("no physical device")
  })

  test("reports ran when devicectl finds at least one known device", async () => {
    const result = await runDeviceLane(
      runnerWritingJsonOutput({
        result: {
          devices: [
            {
              deviceProperties: { name: "Fixture iPhone" },
              hardwareProperties: { udid: "FIXTURE-DEVICE-UDID" },
            },
          ],
        },
      }),
    )

    expect(result.status).toBe("ran")
    expect(result.details.some((line) => line.includes("Fixture iPhone"))).toBe(true)
  })
})
