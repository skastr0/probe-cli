import { describe, expect, test } from "bun:test"
import type { CommandResult, CommandRunner } from "../commandRunner"
import { runSimulatorLane } from "./simulatorLane"

const ok = (stdout: string): CommandResult => ({ status: 0, stdout, stderr: "" })
const fail = (stderr: string): CommandResult => ({ status: 1, stdout: "", stderr })

const listPayload = (state: string) =>
  JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
        { udid: "FIXTURE-UDID", name: "iPhone 16 Pro", state, isAvailable: true },
      ],
    },
  })

describe("simulator lane", () => {
  test("reports attempted-failed when simctl list devices fails outright", async () => {
    const runner: CommandRunner = () => fail("simctl not found")
    const result = await runSimulatorLane(runner)

    expect(result.lane).toBe("simulator")
    expect(result.status).toBe("attempted-failed")
    expect(result.receipts.length).toBeGreaterThan(0)
  })

  test("reports attempted-failed when no available devices are reported", async () => {
    const runner: CommandRunner = (_command, args) => {
      if (args.includes("available")) {
        return ok(JSON.stringify({ devices: {} }))
      }

      return fail("unexpected call")
    }

    const result = await runSimulatorLane(runner)

    expect(result.status).toBe("attempted-failed")
    expect(result.details.some((line) => line.includes("No available"))).toBe(true)
  })

  test("boots, confirms, and shuts down a previously-shutdown simulator", async () => {
    const calls: Array<ReadonlyArray<string>> = []

    const runner: CommandRunner = (_command, args) => {
      calls.push(args)

      if (args.includes("available")) {
        return ok(listPayload("Shutdown"))
      }

      if (args[1] === "boot") {
        return ok("")
      }

      if (args[1] === "list" && args.includes("FIXTURE-UDID")) {
        return ok(listPayload("Booted"))
      }

      if (args[1] === "shutdown") {
        return ok("")
      }

      return fail("unexpected call")
    }

    const result = await runSimulatorLane(runner)

    expect(result.status).toBe("ran")
    expect(calls.some((args) => args[1] === "boot")).toBe(true)
    expect(calls.some((args) => args[1] === "shutdown")).toBe(true)
  })

  test("skips boot/shutdown when the simulator is already booted", async () => {
    const calls: Array<ReadonlyArray<string>> = []

    const runner: CommandRunner = (_command, args) => {
      calls.push(args)

      if (args.includes("available")) {
        return ok(listPayload("Booted"))
      }

      if (args[1] === "list" && args.includes("FIXTURE-UDID")) {
        return ok(listPayload("Booted"))
      }

      return fail("unexpected call")
    }

    const result = await runSimulatorLane(runner)

    expect(result.status).toBe("ran")
    expect(calls.some((args) => args[1] === "boot")).toBe(false)
    expect(calls.some((args) => args[1] === "shutdown")).toBe(false)
  })
})
