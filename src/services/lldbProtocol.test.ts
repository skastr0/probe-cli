import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  decodeLldbBridgeFrame,
  decodeLldbBridgeRequest,
  encodeLldbBridgeRequestLine,
} from "./lldbProtocol"

const bridgeSpike = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "knowledge", "lldb-python", "bridge-spike-results.json"), "utf8"),
) as {
  readonly tooling: {
    readonly bridgeReady: unknown
  }
  readonly commands: Record<string, { readonly request: unknown; readonly response: unknown }>
}

describe("lldb bridge protocol", () => {
  test("decodes the bridge ready frame from the validated LLDB spike", () => {
    const ready = decodeLldbBridgeFrame(bridgeSpike.tooling.bridgeReady)

    expect(ready.kind).toBe("ready")
    if (ready.kind === "ready") {
      expect(ready.initFilesSkipped).toBe(true)
      expect(ready.asyncMode).toBe(false)
      expect(ready.lldbVersion).toContain("lldb-")
    }
  })

  test("decodes the attach response and preserves process stop metadata", () => {
    const frame = decodeLldbBridgeFrame(bridgeSpike.commands.attach.response)

    expect(frame.kind).toBe("response")
    if (frame.kind === "response" && frame.command === "attach" && frame.ok) {
      expect(frame.process.pid).toBeGreaterThan(0)
      expect(frame.process.state).toBe("stopped")
      expect(frame.process.selectedThread?.stopReason).toBe("signal")
    }
  })

  test("decodes vars responses with nested child values", () => {
    const frame = decodeLldbBridgeFrame(bridgeSpike.commands.vars.response)

    expect(frame.kind).toBe("response")
    if (frame.kind === "response" && frame.command === "vars" && frame.ok) {
      expect(frame.variables[1]?.name).toBe("label")
      expect(frame.variables[1]?.children?.[0]?.name).toBe("*label")
      expect(frame.variables.some((variable) => variable.name === "derived" && variable.value === "21")).toBe(true)
    }
  })

  test("decodes eval responses with the policy knobs Probe surfaces", () => {
    const frame = decodeLldbBridgeFrame(bridgeSpike.commands.evalExpression.response)

    expect(frame.kind).toBe("response")
    if (frame.kind === "response" && frame.command === "eval" && frame.ok) {
      expect(frame.expression).toBe("counter + derived")
      expect(frame.result.value).toBe("28")
      expect(frame.options.timeoutMs).toBe(500)
      expect(frame.options.suppressPersistentResult).toBe(true)
    }
  })

  test("decodes exited continue responses without pretending the target is still stopped", () => {
    const frame = decodeLldbBridgeFrame(bridgeSpike.commands.exitAfterCrash.response)

    expect(frame.kind).toBe("response")
    if (frame.kind === "response" && frame.command === "continue" && frame.ok) {
      expect(frame.process.state).toBe("exited")
      expect(frame.process.selectedThread?.stopReason).toBe("none")
    }
  })

  test("round-trips request encoding through the same request decoder", () => {
    const encoded = encodeLldbBridgeRequestLine({
      id: "lldb-42",
      command: "eval",
      expression: "counter + derived",
      threadIndexId: 1,
      frameIndex: 2,
      timeoutMs: 500,
    })

    const decoded = decodeLldbBridgeRequest(JSON.parse(encoded))
    expect(decoded).toEqual({
      id: "lldb-42",
      command: "eval",
      expression: "counter + derived",
      threadIndexId: 1,
      frameIndex: 2,
      timeoutMs: 500,
    })
  })

  test("fails with a focused error when eval request timeouts stop being numeric", () => {
    const broken = {
      id: "lldb-43",
      command: "eval",
      expression: "counter + derived",
      threadIndexId: 1,
      frameIndex: 2,
      timeoutMs: "500",
    }

    expect(() => decodeLldbBridgeRequest(broken)).toThrow(/Invalid LLDB bridge request:.*timeoutMs/)
  })
})
