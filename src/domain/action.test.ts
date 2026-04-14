import { describe, expect, test } from "bun:test"
import {
  buildRecordedSessionAction,
  buildRunnerUiActionPayload,
  decodeSessionAction,
  evaluateAssertion,
  resolveActionSelectorInSnapshot,
  resolveRecordedActionTargetInSnapshot,
  type RecordedActionTarget,
  type ResolvedSnapshotTarget,
} from "./action"
import type { StoredSnapshotArtifact, StoredSnapshotNode } from "./snapshot"

const storedNode = (overrides: Partial<StoredSnapshotNode> = {}): StoredSnapshotNode => ({
  ref: "@e1",
  type: "other",
  identifier: null,
  label: null,
  value: null,
  placeholder: null,
  frame: null,
  state: null,
  interactive: false,
  identity: "weak",
  children: [],
  ...overrides,
})

const snapshot = (root: StoredSnapshotNode): StoredSnapshotArtifact => ({
  contract: "probe.snapshot/artifact-v1",
  snapshotId: "@s1",
  capturedAt: "2026-04-10T00:00:00.000Z",
  previousSnapshotId: null,
  statusLabel: "Ready",
  metrics: {
    rawNodeCount: 4,
    nodeCount: 4,
    interactiveNodeCount: 1,
    maxDepth: 2,
    weakIdentityNodeCount: 0,
    preservedRefCount: 0,
    newRefCount: 4,
    remappedRefCount: 0,
    staleRefCount: 0,
  },
  diff: {
    kind: "initial",
    previousSnapshotId: null,
    summary: { added: 4, removed: 0, updated: 0, remapped: 0, stale: 0 },
    highlights: [],
    staleRefs: [],
    remappedRefs: [],
  },
  warnings: [],
  root,
  renderings: {
    interactive: { totalNodes: 0, nodes: [] },
    collapsed: { totalNodes: 0, nodes: [] },
  },
})

describe("action domain", () => {
  test("falls back to semantic matching when the preferred ref drifts", () => {
    const current = snapshot(
      storedNode({
        ref: "@e1",
        type: "application",
        identity: "strong",
        children: [
          storedNode({
            ref: "@e2",
            type: "staticText",
            identifier: "fixture.status.label",
            label: "Ready",
            identity: "strong",
          }),
          storedNode({
            ref: "@e3",
            type: "button",
            identifier: "fixture.form.applyButton",
            label: "Apply Input",
            interactive: true,
            identity: "strong",
          }),
        ],
      }),
    )

    const recorded: RecordedActionTarget = {
      preferredRef: "@e2",
      fallback: {
        kind: "semantic",
        identifier: "fixture.form.applyButton",
        label: null,
        value: null,
        placeholder: null,
        type: "button",
        section: null,
        interactive: true,
      },
      description: "fixture.form.applyButton (button)",
    }

    const resolution = resolveRecordedActionTargetInSnapshot(current, recorded)
    expect(resolution.outcome).toBe("matched")
    expect(resolution.target?.kind).toBe("snapshot")
    if (resolution.target?.kind !== "snapshot") {
      throw new Error(`Expected a snapshot-backed resolution, received ${resolution.target?.kind ?? "null"}.`)
    }
    expect(resolution.target.ref).toBe("@e3")
    expect(resolution.target?.resolvedBy).toBe("semantic")
  })

  test("records resolved actions with stable semantic fallbacks", () => {
    const resolved: ResolvedSnapshotTarget = {
      kind: "snapshot",
      ref: "@e7",
      resolvedBy: "semantic",
      section: "fixture.form.sectionLabel",
      node: storedNode({
        ref: "@e7",
        type: "textField",
        identifier: "fixture.form.input",
        placeholder: "Type fixture input",
        interactive: true,
        identity: "strong",
      }),
    }

    const recorded = buildRecordedSessionAction(
      {
        kind: "type",
        target: {
          kind: "semantic",
          identifier: null,
          label: null,
          value: null,
          placeholder: "Type fixture input",
          type: "textField",
          section: null,
          interactive: true,
        },
        text: "delta",
        replace: true,
      },
      resolved,
    )

    if (recorded.kind !== "type") {
      throw new Error(`Expected a recorded type action, received ${recorded.kind}.`)
    }

    expect(recorded.target.preferredRef).toBe("@e7")
    if (recorded.target.fallback?.kind !== "semantic") {
      throw new Error(`Expected a semantic fallback, received ${recorded.target.fallback?.kind ?? "null"}.`)
    }
    expect(recorded.target.fallback.identifier).toBe("fixture.form.input")
    expect(recorded.target.fallback.label).toBeNull()
  })

  test("records point selectors verbatim for replay", () => {
    const recorded = buildRecordedSessionAction(
      {
        kind: "tap",
        target: {
          kind: "point",
          x: 120,
          y: 240,
        },
      },
      null,
    )

    if (recorded.kind !== "tap") {
      throw new Error(`Expected a recorded tap action, received ${recorded.kind}.`)
    }

    expect(recorded.target.preferredRef).toBeNull()
    expect(recorded.target.fallback).toEqual({
      kind: "point",
      x: 120,
      y: 240,
    })
  })

  test("builds runner payloads from resolved stable identity", () => {
    const current = snapshot(
      storedNode({
        ref: "@e1",
        type: "application",
        identity: "strong",
        children: [
          storedNode({
            ref: "@e9",
            type: "button",
            identifier: "fixture.navigation.detailButton",
            label: "Open Detail",
            interactive: true,
            identity: "strong",
          }),
        ],
      }),
    )

    const resolved: ResolvedSnapshotTarget = {
      kind: "snapshot",
      ref: "@e9",
      resolvedBy: "ref",
      section: null,
      node: storedNode({
        ref: "@e9",
        type: "button",
        identifier: "fixture.navigation.detailButton",
        label: "Open Detail",
        interactive: true,
        identity: "strong",
      }),
    }

    const payload = buildRunnerUiActionPayload(
      {
        kind: "tap",
        target: {
          kind: "ref",
          ref: "@e9",
          fallback: null,
        },
      },
      resolved,
      current,
    )

    expect(payload.locator.identifier).toBe("fixture.navigation.detailButton")
    expect(payload.locator.kind).toBe("semantic")
    expect(payload.locator.label).toBeNull()
    expect(payload.locator.type).toBe("button")
    expect(payload.locator.ordinal).toBeNull()
  })

  test("builds runner payloads from point selectors without a snapshot", () => {
    const payload = buildRunnerUiActionPayload(
      {
        kind: "tap",
        target: {
          kind: "point",
          x: 88,
          y: 144,
        },
      },
      {
        kind: "point",
        x: 88,
        y: 144,
        resolvedBy: "point",
      },
      null,
    )

    expect(payload.locator).toEqual({
      kind: "point",
      identifier: null,
      label: null,
      value: null,
      placeholder: null,
      type: null,
      section: null,
      interactive: null,
      ordinal: null,
      x: 88,
      y: 144,
    })
  })

  test("encodes section and ordinal hints for duplicate weak runner targets", () => {
    const current = snapshot(
      storedNode({
        ref: "@e1",
        type: "application",
        identity: "strong",
        children: [
          storedNode({
            ref: "@e2",
            type: "other",
            label: "Problem Inputs",
            identity: "weak",
            children: [
              storedNode({
                ref: "@e3",
                type: "button",
                label: "Choose",
                interactive: true,
                identity: "weak",
              }),
              storedNode({
                ref: "@e4",
                type: "button",
                label: "Choose",
                interactive: true,
                identity: "weak",
              }),
            ],
          }),
        ],
      }),
    )

    const resolved: ResolvedSnapshotTarget = {
      kind: "snapshot",
      ref: "@e4",
      resolvedBy: "ref",
      section: "Problem Inputs",
      node: storedNode({
        ref: "@e4",
        type: "button",
        label: "Choose",
        interactive: true,
        identity: "weak",
      }),
    }

    const payload = buildRunnerUiActionPayload(
      {
        kind: "tap",
        target: {
          kind: "semantic",
          identifier: null,
          label: "Choose",
          value: null,
          placeholder: null,
          type: "button",
          section: "Problem Inputs",
          interactive: true,
        },
      },
      resolved,
      current,
    )

    expect(payload.locator.label).toBe("Choose")
    expect(payload.locator.section).toBe("Problem Inputs")
    expect(payload.locator.interactive).toBe(true)
    expect(payload.locator.ordinal).toBe(2)
  })

  test("evaluates assertions against resolved snapshot targets", () => {
    const evaluation = evaluateAssertion(
      {
        outcome: "matched",
        reason: "matched",
        target: {
          kind: "snapshot",
          ref: "@e2",
          resolvedBy: "ref",
          section: null,
          node: storedNode({
            ref: "@e2",
            type: "staticText",
            identifier: "fixture.status.label",
            label: "Input applied: delta",
            identity: "strong",
          }),
        },
      },
      {
        exists: true,
        visible: null,
        hidden: null,
        text: null,
        label: "Input applied: delta",
        value: null,
        type: "staticText",
        enabled: null,
        selected: null,
        focused: null,
        interactive: false,
      },
    )

    expect(evaluation.ok).toBe(true)
    expect(evaluation.matchedRef).toBe("@e2")
  })

  test("treats positive frame bounds as visible even for non-interactive nodes", () => {
    const evaluation = evaluateAssertion(
      {
        outcome: "matched",
        reason: "matched",
        target: {
          kind: "snapshot",
          ref: "@e3",
          resolvedBy: "semantic",
          section: null,
          node: storedNode({
            ref: "@e3",
            type: "staticText",
            identifier: "fixture.status.label",
            label: "Ready",
            frame: { x: 10, y: 12, width: 120, height: 24 },
            interactive: false,
            identity: "strong",
          }),
        },
      },
      {
        exists: true,
        visible: true,
        hidden: null,
        text: null,
        label: null,
        value: null,
        type: null,
        enabled: null,
        selected: null,
        focused: null,
        interactive: null,
      },
    )

    expect(evaluation.ok).toBe(true)
    expect(evaluation.matchedRef).toBe("@e3")
  })

  test("treats offscreen or zero-area frame bounds as hidden", () => {
    const evaluation = evaluateAssertion(
      {
        outcome: "matched",
        reason: "matched",
        target: {
          kind: "snapshot",
          ref: "@e4",
          resolvedBy: "semantic",
          section: null,
          node: storedNode({
            ref: "@e4",
            type: "button",
            identifier: "fixture.problem.offscreenButton",
            label: "Offscreen",
            frame: { x: -220, y: 40, width: 0, height: 44 },
            interactive: true,
            identity: "strong",
          }),
        },
      },
      {
        exists: true,
        visible: null,
        hidden: true,
        text: null,
        label: null,
        value: null,
        type: null,
        enabled: null,
        selected: null,
        focused: null,
        interactive: null,
      },
    )

    expect(evaluation.ok).toBe(true)
    expect(evaluation.matchedRef).toBe("@e4")
  })

  test("fails closed to interactive heuristics when no frame data is available", () => {
    const evaluation = evaluateAssertion(
      {
        outcome: "matched",
        reason: "matched",
        target: {
          kind: "snapshot",
          ref: "@e5",
          resolvedBy: "semantic",
          section: null,
          node: storedNode({
            ref: "@e5",
            type: "other",
            identifier: "fixture.problem.unknownVisibility",
            interactive: false,
            identity: "strong",
          }),
        },
      },
      {
        exists: true,
        visible: true,
        hidden: null,
        text: null,
        label: null,
        value: null,
        type: null,
        enabled: null,
        selected: null,
        focused: null,
        interactive: null,
      },
    )

    expect(evaluation.ok).toBe(false)
    expect(evaluation.summary).toContain("interactive=false as hidden")
  })

  test("confirms absence selectors when the inner selector is missing", () => {
    const current = snapshot(
      storedNode({
        ref: "@e1",
        type: "application",
        identity: "strong",
        children: [],
      }),
    )

    const resolution = resolveActionSelectorInSnapshot(current, {
      kind: "absence",
      negate: {
        kind: "semantic",
        identifier: "fixture.loading.spinner",
        label: null,
        value: null,
        placeholder: null,
        type: "other",
        section: null,
        interactive: null,
      },
    })

    expect(resolution.outcome).toBe("matched")
    expect(resolution.target?.kind).toBe("absence")

    const evaluation = evaluateAssertion(resolution, {
      exists: true,
      visible: null,
      hidden: null,
      text: null,
      label: null,
      value: null,
      type: null,
      enabled: null,
      selected: null,
      focused: null,
      interactive: null,
    })

    expect(evaluation.ok).toBe(true)
    expect(evaluation.resolvedBy).toBe("absence")
    expect(evaluation.matchedRef).toBeNull()
  })

  test("fails absence selectors closed when the inner selector is present", () => {
    const current = snapshot(
      storedNode({
        ref: "@e1",
        type: "application",
        identity: "strong",
        children: [
          storedNode({
            ref: "@e2",
            type: "button",
            identifier: "fixture.form.applyButton",
            label: "Apply Input",
            interactive: true,
            identity: "strong",
          }),
        ],
      }),
    )

    const resolution = resolveActionSelectorInSnapshot(current, {
      kind: "absence",
      negate: {
        kind: "semantic",
        identifier: "fixture.form.applyButton",
        label: null,
        value: null,
        placeholder: null,
        type: "button",
        section: null,
        interactive: true,
      },
    })

    expect(resolution.outcome).toBe("not-found")
    expect(resolution.reason).toContain("Expected absence")
  })

  test("resolves point selectors without a snapshot", () => {
    const resolution = resolveActionSelectorInSnapshot(null, {
      kind: "point",
      x: 64,
      y: 96,
    })

    expect(resolution).toEqual({
      outcome: "matched",
      reason: "Resolved point(64, 96) in the interaction-root coordinate space.",
      target: {
        kind: "point",
        x: 64,
        y: 96,
        resolvedBy: "point",
      },
    })
  })

  test("decodes semantic role aliases into canonical type fields", () => {
    const action = decodeSessionAction({
      kind: "tap",
      target: {
        kind: "semantic",
        identifier: null,
        label: "Apply Input",
        value: null,
        placeholder: null,
        role: "button",
        section: null,
        interactive: true,
      },
    })

    if (action.kind !== "tap") {
      throw new Error(`Expected tap action, received ${action.kind}.`)
    }

    if (action.target.kind !== "semantic") {
      throw new Error(`Expected semantic target, received ${action.target.kind}.`)
    }

    expect(action.target.type).toBe("button")
  })

  test("decodes point and absence selectors from json payloads", () => {
    const pointAction = decodeSessionAction({
      kind: "tap",
      target: {
        kind: "point",
        x: 24,
        y: 48,
      },
    })

    const absenceAction = decodeSessionAction({
      kind: "assert",
      target: {
        kind: "absence",
        negate: {
          kind: "semantic",
          identifier: "fixture.loading.spinner",
          label: null,
          value: null,
          placeholder: null,
          type: "other",
          section: null,
          interactive: null,
        },
      },
      expectation: {
        exists: true,
        label: null,
        value: null,
        type: null,
        enabled: null,
        selected: null,
        focused: null,
        interactive: null,
      },
    })

    if (pointAction.kind !== "tap") {
      throw new Error(`Expected tap action, received ${pointAction.kind}.`)
    }

    if (absenceAction.kind !== "assert") {
      throw new Error(`Expected assert action, received ${absenceAction.kind}.`)
    }

    expect(pointAction.target.kind).toBe("point")
    expect(absenceAction.target.kind).toBe("absence")
    if (absenceAction.target.kind !== "absence" || absenceAction.target.negate.kind !== "semantic") {
      throw new Error("Expected absence action with a semantic negate selector.")
    }
    expect(absenceAction.target.negate.type).toBe("other")
  })
})
