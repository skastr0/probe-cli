import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildSessionSnapshotResult, buildSnapshotArtifact, decodeRunnerSnapshotPayload, type RunnerSnapshotNode } from "./snapshot"

const loadFixture = (name: string) =>
  readFileSync(join(import.meta.dir, "..", "test-fixtures", "snapshot", name), "utf8")

const artifactRecord = {
  key: "snapshot-contract-fixture",
  label: "snapshot-@s1",
  kind: "json" as const,
  summary: "snapshot contract fixture",
  absolutePath: "/tmp/snapshot-contract-fixture.json",
  relativePath: "snapshots/snapshot-contract-fixture.json",
  external: false,
  createdAt: "2026-04-10T05:53:59.167Z",
}

const findNodeByIdentifier = (node: RunnerSnapshotNode, identifier: string): RunnerSnapshotNode | null => {
  if (node.identifier === identifier) {
    return node
  }

  for (const child of node.children) {
    const match = findNodeByIdentifier(child, identifier)
    if (match) {
      return match
    }
  }

  return null
}

describe("snapshot contract fixtures", () => {
  test("decodes the detail-view runner payload Probe currently depends on", () => {
    const raw = decodeRunnerSnapshotPayload(loadFixture("runner-detail-view.raw.json"))

    expect(raw.statusLabel).toBe("Detail view active")
    expect(raw.metrics.interactiveNodeCount).toBe(2)
    expect(findNodeByIdentifier(raw.root, "fixture.detail.popButton")?.interactive).toBe(true)
    expect(findNodeByIdentifier(raw.root, "fixture.detail.summaryLabel")?.label).toBe("Ready for attach/control validation")
  })

  test("builds a compact interactive snapshot result from the detail-view fixture", () => {
    const raw = decodeRunnerSnapshotPayload(loadFixture("runner-detail-view.raw.json"))
    const built = buildSnapshotArtifact({
      previous: null,
      nextSnapshotIndex: 1,
      nextElementRefIndex: 1,
      raw,
    })
    const result = buildSessionSnapshotResult({
      artifact: built.artifact,
      artifactRecord,
      outputMode: "inline",
    })

    expect(built.artifact.contract).toBe("probe.snapshot/artifact-v1")
    expect(built.artifact.metrics.nodeCount).toBe(11)
    expect(built.artifact.metrics.interactiveNodeCount).toBe(2)
    expect(built.artifact.warnings[0]).toContain("lack accessibility identifiers")
    expect(result.preview?.kind).toBe("interactive")
    expect(result.preview?.totalNodes).toBe(2)
    expect(result.preview?.nodes.map((node) => node.identifier)).toEqual(["BackButton", "fixture.detail.popButton"])
    expect(result.summary).toContain("initial snapshot")
  })

  test("fails loudly when the runner snapshot metrics drift away from the current contract", () => {
    const broken = JSON.parse(loadFixture("runner-detail-view.raw.json")) as {
      readonly metrics: Record<string, unknown>
    }
    const mutated = {
      ...broken,
      metrics: {
        ...broken.metrics,
        interactiveNodeCount: "2",
      },
    }

    expect(() => decodeRunnerSnapshotPayload(JSON.stringify(mutated))).toThrow(
      /Invalid runner snapshot payload:.*interactiveNodeCount/,
    )
  })
})
