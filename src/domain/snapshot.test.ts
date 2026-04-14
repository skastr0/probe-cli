import { describe, expect, test } from "bun:test"
import { buildSessionSnapshotResult, buildSnapshotArtifact, type RunnerSnapshotNode } from "./snapshot"

const node = (overrides: Partial<RunnerSnapshotNode> = {}): RunnerSnapshotNode => ({
  type: "other",
  identifier: null,
  label: null,
  value: null,
  placeholder: null,
  frame: null,
  state: null,
  interactive: false,
  children: [],
  ...overrides,
})

const rawSnapshot = (root: RunnerSnapshotNode) => ({
  capturedAt: "2026-04-10T00:00:00.000Z",
  statusLabel: "Ready for attach/control validation",
  metrics: {
    rawNodeCount: 3,
    prunedNodeCount: 3,
    interactiveNodeCount: 1,
  },
  root,
})

const artifactRecord = {
  key: "snapshot-s1",
  label: "snapshot-@s1",
  kind: "json" as const,
  summary: "snapshot artifact",
  absolutePath: "/tmp/snapshot.json",
  relativePath: "snapshots/snapshot.json",
  external: false,
  createdAt: "2026-04-10T00:00:00.000Z",
}

describe("snapshot domain", () => {
  test("preserves identifier-backed refs and reports updates", () => {
    const first = buildSnapshotArtifact({
      previous: null,
      nextSnapshotIndex: 1,
      nextElementRefIndex: 1,
      raw: rawSnapshot(
        node({
          type: "application",
          children: [
            node({
              type: "staticText",
              identifier: "fixture.status.label",
              label: "Ready for attach/control validation",
            }),
            node({
              type: "button",
              identifier: "fixture.form.applyButton",
              label: "Apply Input",
              interactive: true,
            }),
          ],
        }),
      ),
    })
    const second = buildSnapshotArtifact({
      previous: first.artifact,
      nextSnapshotIndex: first.nextSnapshotIndex,
      nextElementRefIndex: first.nextElementRefIndex,
      raw: rawSnapshot(
        node({
          type: "application",
          children: [
            node({
              type: "staticText",
              identifier: "fixture.status.label",
              label: "Input applied: delta",
            }),
            node({
              type: "button",
              identifier: "fixture.form.applyButton",
              label: "Apply Input",
              interactive: true,
            }),
          ],
        }),
      ),
    })

    expect(first.artifact.root.children[0]?.ref).toBe(second.artifact.root.children[0]?.ref)
    expect(second.artifact.diff.kind).toBe("changed")
    expect(second.artifact.diff.summary.updated).toBe(1)
    expect(second.artifact.diff.summary.remapped).toBe(0)
    expect(second.artifact.diff.highlights[0]?.description).toContain("fixture.status.label")
  })

  test("remaps weak structural refs when weak identity drifts", () => {
    const first = buildSnapshotArtifact({
      previous: null,
      nextSnapshotIndex: 1,
      nextElementRefIndex: 1,
      raw: rawSnapshot(
        node({
          type: "application",
          children: [
            node({
              type: "other",
              frame: { x: 0, y: 0, width: 40, height: 40 },
            }),
          ],
        }),
      ),
    })
    const second = buildSnapshotArtifact({
      previous: first.artifact,
      nextSnapshotIndex: first.nextSnapshotIndex,
      nextElementRefIndex: first.nextElementRefIndex,
      raw: rawSnapshot(
        node({
          type: "application",
          children: [
            node({
              type: "other",
              frame: { x: 20, y: 0, width: 40, height: 40 },
            }),
          ],
        }),
      ),
    })

    expect(second.artifact.metrics.remappedRefCount).toBe(1)
    expect(second.artifact.diff.remappedRefs[0]?.ref).toBe(first.artifact.root.children[0]?.ref)
    expect(second.artifact.warnings.join(" ")).toContain("remapped")
  })

  test("returns an interactive preview for compact screens", () => {
    const built = buildSnapshotArtifact({
      previous: null,
      nextSnapshotIndex: 1,
      nextElementRefIndex: 1,
      raw: rawSnapshot(
        node({
          type: "application",
          children: [
            node({
              type: "button",
              identifier: "fixture.form.applyButton",
              label: "Apply Input",
              interactive: true,
            }),
          ],
        }),
      ),
    })
    const result = buildSessionSnapshotResult({
      artifact: built.artifact,
      artifactRecord,
      outputMode: "inline",
    })

    expect(result.preview?.kind).toBe("interactive")
    expect(result.preview?.nodes.length).toBe(1)
  })

  test("falls back to a collapsed preview when the interactive surface is large", () => {
    const largeInteractiveChildren = Array.from({ length: 60 }, (_, index) =>
      node({
        type: "button",
        identifier: `fixture.button.${index}`,
        label: `Button ${index}`,
        interactive: true,
      }),
    )
    const built = buildSnapshotArtifact({
      previous: null,
      nextSnapshotIndex: 1,
      nextElementRefIndex: 1,
      raw: rawSnapshot(
        node({
          type: "application",
          children: largeInteractiveChildren,
        }),
      ),
    })
    const result = buildSessionSnapshotResult({
      artifact: built.artifact,
      artifactRecord,
      outputMode: "inline",
    })

    expect(result.preview?.kind).toBe("collapsed")
    expect(result.preview?.nodes.length).toBeGreaterThan(1)
  })

  test("includes retry metadata in session snapshot results", () => {
    const built = buildSnapshotArtifact({
      previous: null,
      nextSnapshotIndex: 1,
      nextElementRefIndex: 1,
      raw: rawSnapshot(
        node({
          type: "application",
          children: [
            node({
              type: "button",
              identifier: "fixture.form.applyButton",
              label: "Apply Input",
              interactive: true,
            }),
          ],
        }),
      ),
    })

    const defaultResult = buildSessionSnapshotResult({
      artifact: built.artifact,
      artifactRecord,
      outputMode: "inline",
    })
    const retriedResult = buildSessionSnapshotResult({
      artifact: built.artifact,
      artifactRecord,
      outputMode: "inline",
      retry: {
        retryCount: 2,
        retryReasons: ["runner-timeout: timed out", "transient-transport: disconnected"],
      },
    })

    expect(defaultResult.retryCount).toBe(0)
    expect(defaultResult.retryReasons).toEqual([])
    expect(retriedResult.retryCount).toBe(2)
    expect(retriedResult.retryReasons).toHaveLength(2)
  })

  test("reports stale refs when a node disappears without remapping", () => {
    const first = buildSnapshotArtifact({
      previous: null,
      nextSnapshotIndex: 1,
      nextElementRefIndex: 1,
      raw: rawSnapshot(
        node({
          type: "application",
          identifier: "fixture.root",
          children: [
            node({
              type: "button",
              identifier: "fixture.form.button1",
              label: "Button 1",
              interactive: true,
            }),
            node({
              type: "button",
              identifier: "fixture.form.button2",
              label: "Button 2",
              interactive: true,
            }),
          ],
        }),
      ),
    })
    const second = buildSnapshotArtifact({
      previous: first.artifact,
      nextSnapshotIndex: first.nextSnapshotIndex,
      nextElementRefIndex: first.nextElementRefIndex,
      raw: rawSnapshot(
        node({
          type: "application",
          identifier: "fixture.root",
          children: [
            node({
              type: "button",
              identifier: "fixture.form.button1",
              label: "Button 1",
              interactive: true,
            }),
          ],
        }),
      ),
    })

    expect(second.artifact.diff.staleRefs.length).toBe(1)
    expect(second.artifact.diff.staleRefs[0]).toBe(first.artifact.root.children[1]?.ref)
    expect(second.artifact.diff.summary.removed).toBe(1)
    expect(second.artifact.diff.summary.added).toBe(0)
    expect(second.artifact.metrics.staleRefCount).toBe(1)
  })

  test("omits preview in auto mode when tree exceeds budget", () => {
    const manyNodesChildren = Array.from({ length: 200 }, (_, index) =>
      node({
        type: "button",
        identifier: `fixture.node.${index}`,
        label: `Node ${index}`,
        interactive: true,
      }),
    )
    const built = buildSnapshotArtifact({
      previous: null,
      nextSnapshotIndex: 1,
      nextElementRefIndex: 1,
      raw: rawSnapshot(
        node({
          type: "application",
          children: manyNodesChildren,
        }),
      ),
    })
    const result = buildSessionSnapshotResult({
      artifact: built.artifact,
      artifactRecord,
      outputMode: "auto",
    })

    expect(result.preview).toBeNull()
    expect(result.summary).toContain("omitted")
  })

  test("diff summary counts exclude remapped refs from added/removed", () => {
    const first = buildSnapshotArtifact({
      previous: null,
      nextSnapshotIndex: 1,
      nextElementRefIndex: 1,
      raw: rawSnapshot(
        node({
          type: "application",
          children: [
            node({
              type: "other",
              frame: { x: 0, y: 0, width: 40, height: 40 },
              label: "First Label",
            }),
          ],
        }),
      ),
    })
    const second = buildSnapshotArtifact({
      previous: first.artifact,
      nextSnapshotIndex: first.nextSnapshotIndex,
      nextElementRefIndex: first.nextElementRefIndex,
      raw: rawSnapshot(
        node({
          type: "application",
          children: [
            node({
              type: "other",
              frame: { x: 20, y: 0, width: 40, height: 40 },
              label: "Second Label",
            }),
          ],
        }),
      ),
    })

    expect(second.artifact.diff.summary.remapped).toBe(1)
    expect(second.artifact.diff.summary.added).toBe(0)
    expect(second.artifact.diff.summary.removed).toBe(0)
    expect(second.artifact.diff.summary.stale).toBe(0)
    expect(second.artifact.diff.staleRefs.length).toBe(0)
    const result = buildSessionSnapshotResult({
      artifact: second.artifact,
      artifactRecord,
      outputMode: "inline",
    })
    expect(result.summary).toContain("weakly remapped")
  })
})
