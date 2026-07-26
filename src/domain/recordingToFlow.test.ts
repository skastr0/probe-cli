import { describe, expect, test } from "bun:test"
import type { ActionRecordingScript } from "./action"
import { decodeSessionFlowContract } from "./flow-v2"
import { RecordingToFlowError, recordingScriptToFlowV2 } from "./recordingToFlow"

const baseScript = (steps: ActionRecordingScript["steps"]): ActionRecordingScript => ({
  contract: "probe.action-recording/script-v1",
  recordedAt: "2026-07-26T00:00:00.000Z",
  sessionId: "session-1",
  bundleId: "dev.probe.fixture",
  steps,
})

const semanticFallback = {
  preferredRef: "@e12",
  fallback: {
    kind: "semantic" as const,
    identifier: "fixture.form.applyButton",
    label: null,
    value: null,
    placeholder: null,
    type: "button" as const,
    section: null,
    interactive: true,
  },
  description: "Apply",
}

describe("recordingScriptToFlowV2", () => {
  test("converts recorded mutations into a decodable session-flow/v2 contract", () => {
    const flow = recordingScriptToFlowV2(baseScript([
      {
        kind: "type",
        target: {
          preferredRef: "@e10",
          fallback: {
            kind: "semantic",
            identifier: "fixture.form.input",
            label: null,
            value: null,
            placeholder: null,
            type: "textField",
            section: null,
            interactive: true,
          },
          description: "Input",
        },
        text: "hello",
        replace: true,
      },
      {
        kind: "tap",
        target: semanticFallback,
      },
      {
        kind: "wait",
        target: null,
        timeoutMs: 250,
        condition: "duration",
        text: null,
      },
    ]))

    expect(flow.contract).toBe("probe.session-flow/v2")
    expect(flow.steps).toHaveLength(3)

    const decoded = decodeSessionFlowContract(flow)
    expect(decoded.steps[0]?.kind).toBe("type")
    expect(decoded.steps[1]?.kind).toBe("tap")
    expect(decoded.steps[2]?.kind).toBe("wait")

    const tap = decoded.steps[1]
    if (tap?.kind === "tap") {
      expect(tap.target).toEqual(semanticFallback.fallback)
      expect(tap.execution).toBe("fast")
      expect(tap.evidencePolicy).toEqual({ success: "none", failure: "snapshot" })
    }
  })

  test("prefers fallback over preferredRef when both exist", () => {
    const flow = recordingScriptToFlowV2(baseScript([
      { kind: "tap", target: semanticFallback },
    ]))
    const step = flow.steps[0]
    expect(step?.kind).toBe("tap")
    if (step?.kind === "tap") {
      expect(step.target).toEqual(semanticFallback.fallback)
    }
  })

  test("uses preferredRef as a ref selector when fallback is null", () => {
    const flow = recordingScriptToFlowV2(baseScript([
      {
        kind: "tap",
        target: {
          preferredRef: "@e99",
          fallback: null,
          description: "orphan ref",
        },
      },
    ]))
    const step = flow.steps[0]
    expect(step?.kind).toBe("tap")
    if (step?.kind === "tap") {
      expect(step.target).toEqual({ kind: "ref", ref: "@e99", fallback: null })
    }
  })

  test("rejects empty scripts and missing selectors", () => {
    expect(() => recordingScriptToFlowV2(baseScript([]))).toThrow(RecordingToFlowError)
    expect(() => recordingScriptToFlowV2(baseScript([
      {
        kind: "tap",
        target: { preferredRef: null, fallback: null, description: "broken" },
      },
    ]))).toThrow(RecordingToFlowError)
  })
})
