import { describe, expect, test } from "bun:test"
import { UnsupportedFlowContractError } from "./errors"
import {
  decodeFlowV2Contract,
  decodeSessionFlowContract,
  validateFlowV2Contract,
} from "./flow-v2"

describe("flow v2 contract", () => {
  test("parses v2 flow contracts", () => {
    const v2 = decodeSessionFlowContract({
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
      ],
    })

    expect(v2.contract).toBe("probe.session-flow/v2")
  })

  test("rejects the removed v1 contract with a typed unsupported-contract error and a concrete migration step", () => {
    const decodeV1 = () =>
      decodeSessionFlowContract({
        contract: "probe.session-flow/v1",
        steps: [
          { kind: "snapshot" },
        ],
      })

    expect(decodeV1).toThrow(UnsupportedFlowContractError)

    try {
      decodeV1()
      throw new Error("Expected decodeV1 to throw")
    } catch (error) {
      if (!(error instanceof UnsupportedFlowContractError)) {
        throw error
      }

      expect(error.contract).toBe("probe.session-flow/v1")
      expect(error.nextStep).toContain("probe.session-flow/v2")
    }
  })

  test("rejects nested sequence children", () => {
    expect(() => decodeFlowV2Contract({
      contract: "probe.session-flow/v2",
      execution: "fast",
      steps: [
        {
          kind: "sequence",
          actions: [
            {
              kind: "sequence",
              actions: [],
            },
          ],
        },
      ],
    })).toThrow()
  })

  test("rejects fast targets that the runner cannot resolve", () => {
    const flow = decodeFlowV2Contract({
      contract: "probe.session-flow/v2",
      execution: "fast",
      steps: [
        {
          kind: "tap",
          target: {
            kind: "ref",
            ref: "@e1",
            fallback: null,
          },
        },
      ],
    })

    expect(validateFlowV2Contract(flow)).toContain("runner-resolvable target")
  })

  // PRB-092: multiTap as a direct flow step and as a sequence (batch) child
  // both decode and validate through the same domain schema.
  test("accepts multiTap as a direct fast flow step", () => {
    const flow = decodeFlowV2Contract({
      contract: "probe.session-flow/v2",
      execution: "fast",
      steps: [
        {
          kind: "multiTap",
          target: {
            kind: "semantic",
            identifier: "fixture.gesture.multiTapTarget",
            label: null,
            value: null,
            placeholder: null,
            type: "button",
            section: null,
            interactive: true,
          },
          tapCount: 5,
          interTapDelayMs: 60,
        },
      ],
    })

    expect(validateFlowV2Contract(flow)).toBeNull()
  })

  test("accepts multiTap as a sequence (batch) child", () => {
    const flow = decodeFlowV2Contract({
      contract: "probe.session-flow/v2",
      execution: "fast",
      steps: [
        {
          kind: "sequence",
          actions: [
            {
              kind: "multiTap",
              target: {
                kind: "semantic",
                identifier: "fixture.gesture.multiTapTarget",
                label: null,
                value: null,
                placeholder: null,
                type: "button",
                section: null,
                interactive: true,
              },
              tapCount: 5,
              interTapDelayMs: 60,
            },
          ],
        },
      ],
    })

    expect(validateFlowV2Contract(flow)).toBeNull()
  })

  test("rejects a sequence multiTap child outside the tapCount/interTapDelayMs bounds", () => {
    expect(() =>
      decodeFlowV2Contract({
        contract: "probe.session-flow/v2",
        execution: "fast",
        steps: [
          {
            kind: "sequence",
            actions: [
              {
                kind: "multiTap",
                target: { kind: "point", x: 1, y: 2 },
                tapCount: 21,
                interTapDelayMs: 60,
              },
            ],
          },
        ],
      })
    ).toThrow()
  })
})
