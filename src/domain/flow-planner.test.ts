import { describe, expect, test } from "bun:test"
import { decodeFlowContract } from "./action"
import { planFlowExecution } from "./flow-planner"
import { decodeFlowV2Contract, validateFlowV2Contract } from "./flow-v2"

describe("flow planner", () => {
  test("plans v1 contracts into verified, checkpoint, and evidence units", () => {
    const flow = decodeFlowContract({
      contract: "probe.session-flow/v1",
      steps: [
        { kind: "snapshot" },
        {
          kind: "tap",
          target: {
            kind: "semantic",
            identifier: "fixture.primaryButton",
            label: null,
            value: null,
            placeholder: null,
            type: "button",
            section: null,
            interactive: true,
          },
        },
        {
          kind: "screenshot",
        },
      ],
    })

    expect(planFlowExecution(flow).steps.map((step) => step.kind)).toEqual([
      "checkpoint",
      "verified",
      "evidence",
    ])
  })

  test("generates a stable plan for v2 flows", () => {
    const flow = decodeFlowV2Contract({
      contract: "probe.session-flow/v2",
      execution: "fast",
      steps: [
        {
          kind: "tap",
          target: {
            kind: "semantic",
            identifier: "fixture.primaryButton",
            label: null,
            value: null,
            placeholder: null,
            type: "button",
            section: null,
            interactive: true,
          },
        },
        {
          kind: "assert",
          execution: "verified",
          target: {
            kind: "semantic",
            identifier: "fixture.statusLabel",
            label: null,
            value: null,
            placeholder: null,
            type: "staticText",
            section: null,
            interactive: false,
          },
          expectation: {
            text: "Ready",
          },
        },
        {
          kind: "sequence",
          checkpoint: "end",
          actions: [
            {
              kind: "tap",
              target: {
                kind: "semantic",
                identifier: "fixture.primaryButton",
                label: null,
                value: null,
                placeholder: null,
                type: "button",
                section: null,
                interactive: true,
              },
            },
            {
              kind: "wait",
              timeoutMs: 250,
              condition: "duration",
              target: null,
              text: null,
            },
          ],
        },
        {
          kind: "screenshot",
          execution: "verified",
        },
      ],
    })

    expect(validateFlowV2Contract(flow)).toBeNull()

    const firstPlan = planFlowExecution(flow)
    const secondPlan = planFlowExecution(flow)

    expect(firstPlan).toEqual(secondPlan)
    expect(firstPlan.steps.map((step) => ({ kind: step.kind, index: step.index }))).toEqual([
      { kind: "fast-single", index: 1 },
      { kind: "checkpoint", index: 2 },
      { kind: "batch-sequence", index: 3 },
      { kind: "evidence", index: 4 },
    ])
  })
})
