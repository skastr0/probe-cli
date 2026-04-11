import { describe, expect, test } from "bun:test"
import {
  buildRecordedSessionAction,
  buildRunnerUiActionPayload,
  evaluateAssertion,
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
    expect(resolution.target?.ref).toBe("@e3")
    expect(resolution.target?.resolvedBy).toBe("semantic")
  })

  test("records resolved actions with stable semantic fallbacks", () => {
    const resolved: ResolvedSnapshotTarget = {
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
    expect(recorded.target.fallback?.identifier).toBe("fixture.form.input")
    expect(recorded.target.fallback?.label).toBeNull()
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
    expect(payload.locator.label).toBeNull()
    expect(payload.locator.type).toBe("button")
    expect(payload.locator.ordinal).toBeNull()
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
})
