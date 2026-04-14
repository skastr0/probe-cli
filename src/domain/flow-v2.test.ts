import { describe, expect, test } from "bun:test"
import { decodeFlowContract } from "./action"
import {
  decodeFlowV2Contract,
  decodeSessionFlowContract,
  validateFlowV2Contract,
} from "./flow-v2"

describe("flow v2 contract", () => {
  test("parses both v1 and v2 flow contracts", () => {
    const v1 = decodeSessionFlowContract({
      contract: "probe.session-flow/v1",
      steps: [
        { kind: "snapshot" },
      ],
    })

    const directV1 = decodeFlowContract({
      contract: "probe.session-flow/v1",
      steps: [
        { kind: "snapshot" },
      ],
    })

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

    expect(v1).toEqual(directV1)
    expect(v1.contract).toBe("probe.session-flow/v1")
    expect(v2.contract).toBe("probe.session-flow/v2")
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
})
