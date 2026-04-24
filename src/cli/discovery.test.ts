import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { runExamplesCommand, runSchemaCommand } from "./discovery"

const captureConsoleLogs = async (effect: Effect.Effect<unknown, unknown, never>) => {
  const originalConsoleLog = console.log
  const lines: Array<string> = []

  console.log = (...args: Array<unknown>) => {
    lines.push(args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
  }

  try {
    await Effect.runPromise(effect)
  } finally {
    console.log = originalConsoleLog
  }

  return lines.join("\n")
}

describe("cli discovery commands", () => {
  test("schema list exposes scriptable payload contracts", async () => {
    const output = await captureConsoleLogs(runSchemaCommand(["list", "--output-json"]))
    const envelope = JSON.parse(output)

    expect(envelope.ok).toBe(true)
    expect(envelope.command).toBe("schema list")
    expect(envelope.data.schemas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schema_id: "probe.command.session.open.input/v1",
          command: "session open",
          rpc_method: "session.open",
        }),
        expect.objectContaining({
          schema_id: "probe.rpc.frames/v1",
        }),
      ]),
    )
  })

  test("schema show exposes payload controls and shapes", async () => {
    const output = await captureConsoleLogs(runSchemaCommand(["show", "session.open", "--output-json"]))
    const envelope = JSON.parse(output)

    expect(envelope.ok).toBe(true)
    expect(envelope.data.schema.schema_id).toBe("probe.command.session.open.input/v1")
    expect(envelope.data.schema.input_controls).toContain("--input-json <json>")
    expect(envelope.data.schema.payload_shape.bundleId).toContain("dev.probe.fixture")
  })

  test("examples show returns executable canonical JSON usage", async () => {
    const output = await captureConsoleLogs(runExamplesCommand(["show", "session-action-tap-json", "--output-json"]))
    const envelope = JSON.parse(output)

    expect(envelope.ok).toBe(true)
    expect(envelope.data.example.invocation).toContain("--input-json")
    expect(envelope.data.example.invocation).toContain("--output-json")
    expect(envelope.data.example.payload.action.kind).toBe("tap")
  })
})
