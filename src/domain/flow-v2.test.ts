import { describe, expect, test } from "bun:test"
import { UnsupportedFlowContractError } from "./errors"
import {
  decodeFlowV2Contract,
  decodeSessionFlowContract,
  FlowV2ContractSchema,
  SessionFlowContractSchema,
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

// PRB-093 (relocated PRB-082 gate 8 clause 2, per the wave-1 acceptance
// review — see PRB-093.md's Notes): contract-test the evidence-policy
// migration against the canonical v2 flow contract that PRB-082 left as the
// single flow surface. `SessionFlowContractSchema` must remain the *same*
// schema reference as `FlowV2ContractSchema` (not a structurally-similar
// copy), and existing current-flow fixture behavior must keep decoding
// through the evidence-policy change.
describe("PRB-093 contract-tests the evidence-policy migration against the canonical v2 flow contract", () => {
  test("SessionFlowContractSchema is FlowV2ContractSchema (identity, not a parallel copy)", () => {
    expect(SessionFlowContractSchema).toBe(FlowV2ContractSchema)
  })

  test("a current-flow fixture predating evidencePolicy still decodes and validates unchanged", () => {
    // Mirrors docs/examples/flows/verified-only-v2.json — no evidencePolicy
    // field anywhere, exactly like every flow authored before PRB-093.
    const flow = decodeSessionFlowContract({
      contract: "probe.session-flow/v2",
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
          kind: "assert",
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
          expectation: { text: "Ready" },
        },
      ],
    })

    expect(validateFlowV2Contract(flow)).toBeNull()
    expect(flow.contract).toBe("probe.session-flow/v2")
    // The migration adds an evidencePolicy field to mutation steps and to
    // sequence steps; it does not require callers who never set one to
    // change anything.
    expect((flow.steps[1] as { readonly evidencePolicy?: unknown }).evidencePolicy).toBeUndefined()
  })

  test("a sequence step's evidencePolicy round-trips through the canonical contract, replacing the deleted checkpoint vocabulary", () => {
    const flow = decodeSessionFlowContract({
      contract: "probe.session-flow/v2",
      execution: "fast",
      steps: [
        {
          kind: "sequence",
          evidencePolicy: { success: "around", failure: "none" },
          actions: [
            { kind: "tap", target: { kind: "point", x: 1, y: 2 } },
          ],
        },
      ],
    })

    expect(validateFlowV2Contract(flow)).toBeNull()
    const sequenceStep = flow.steps[0] as { readonly evidencePolicy?: { readonly success?: string; readonly failure?: string } }
    expect(sequenceStep.evidencePolicy).toEqual({ success: "around", failure: "none" })
    // The old checkpoint vocabulary is gone -- a payload still carrying it
    // decodes (Schema.Struct tolerates excess keys) but the key contributes
    // nothing; no compatibility path was built for it (PRB-093's Notes).
    expect((sequenceStep as { readonly checkpoint?: unknown }).checkpoint).toBeUndefined()
  })
})
