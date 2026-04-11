import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, ManagedRuntime } from "effect"
import {
  buildSnapshotArtifact,
  buildSessionSnapshotResult,
  decodeRunnerSnapshotPayload,
  type StoredSnapshotNode,
} from "../../domain/snapshot"
import { SimulatorHarness, SimulatorHarnessLive, type OpenedSimulatorSession } from "../../services/SimulatorHarness"

const findNodeByIdentifier = (
  node: StoredSnapshotNode,
  identifier: string,
): StoredSnapshotNode | null => {
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

const main = async () => {
  const runtime = ManagedRuntime.make(SimulatorHarnessLive)
  const rootDir = process.cwd()
  const tempRoot = await mkdtemp(join(tmpdir(), "probe-snapshot-diff-"))
  let opened: OpenedSimulatorSession | null = null

  try {
    const harness = await runtime.runPromise(Effect.gen(function* () {
      return yield* SimulatorHarness
    }))

    opened = await runtime.runPromise(
      harness.openSession({
        rootDir,
        sessionId: "snapshot-diff-validate",
        artifactRoot: tempRoot,
        runnerDirectory: join(tempRoot, "runner"),
        logsDirectory: join(tempRoot, "logs"),
        bundleId: "dev.probe.fixture",
        simulatorUdid: null,
      }),
    )

    let nextSequence = opened.nextSequence
    const baselineResult = await opened.sendCommand(nextSequence, "snapshot")
    nextSequence += 1

    if (!baselineResult.snapshotPayloadPath) {
      throw new Error("Baseline snapshot did not report a payload path.")
    }

    const applyResult = await opened.sendCommand(nextSequence, "applyInput", "delta")
    nextSequence += 1

    if (!applyResult.ok) {
      throw new Error(`applyInput failed: ${applyResult.payload ?? applyResult.statusLabel}`)
    }

    const updatedResult = await opened.sendCommand(nextSequence, "snapshot")
    nextSequence += 1

    if (!updatedResult.snapshotPayloadPath) {
      throw new Error("Updated snapshot did not report a payload path.")
    }

    const baselineRaw = decodeRunnerSnapshotPayload(await readFile(baselineResult.snapshotPayloadPath, "utf8"))
    const updatedRaw = decodeRunnerSnapshotPayload(await readFile(updatedResult.snapshotPayloadPath, "utf8"))

    const baseline = buildSnapshotArtifact({
      previous: null,
      nextSnapshotIndex: 1,
      nextElementRefIndex: 1,
      raw: baselineRaw,
    })
    const updated = buildSnapshotArtifact({
      previous: baseline.artifact,
      nextSnapshotIndex: baseline.nextSnapshotIndex,
      nextElementRefIndex: baseline.nextElementRefIndex,
      raw: updatedRaw,
    })
    const baselineStatus = findNodeByIdentifier(baseline.artifact.root, "fixture.status.label")
    const updatedStatus = findNodeByIdentifier(updated.artifact.root, "fixture.status.label")

    if (!baselineStatus || !updatedStatus) {
      throw new Error("Could not find fixture.status.label in one of the captured snapshots.")
    }

    const response = buildSessionSnapshotResult({
      artifact: updated.artifact,
      artifactRecord: {
        key: "snapshot-validation",
        label: "snapshot-validation",
        kind: "json",
        summary: "validation artifact",
        absolutePath: updatedResult.snapshotPayloadPath,
        relativePath: null,
        external: false,
        createdAt: updated.artifact.capturedAt,
      },
      outputMode: "auto",
    })

    console.log(JSON.stringify({
      simulator: opened.simulator,
      snapshotIds: [baseline.artifact.snapshotId, updated.artifact.snapshotId],
      statusLabelRefStable: baselineStatus.ref === updatedStatus.ref,
      baselineStatusRef: baselineStatus.ref,
      updatedStatusRef: updatedStatus.ref,
      diff: updated.artifact.diff.summary,
      warnings: updated.artifact.warnings,
      previewKind: response.preview?.kind ?? null,
      summary: response.summary,
    }, null, 2))

    await opened.sendCommand(nextSequence, "shutdown")
  } finally {
    if (opened) {
      await opened.close().catch(() => undefined)
    }

    await rm(tempRoot, { recursive: true, force: true })
    await runtime.dispose()
  }
}

await main()
