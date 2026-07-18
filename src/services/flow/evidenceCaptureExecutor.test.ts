import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { EnvironmentError, UnsupportedCapabilityError } from "../../domain/errors"
import type { ArtifactRecord } from "../../domain/output"
import type { FlowV2LogMarkStep, FlowV2ScreenshotStep, FlowV2SnapshotStep, FlowV2VideoStep } from "../../domain/flow-v2"
import type { PlannedStep } from "../../domain/flow-planner"
import {
  captureScreenshotEvidenceStep,
  captureSnapshotEvidenceStep,
  captureVideoEvidenceStep,
  markLogEvidenceStep,
} from "./evidenceCaptureExecutor"
import type { FlowExecutorDeps } from "./flowExecutorDeps"
import { makeFakeSimulatorRecord, makeUnusedFlowExecutorDeps } from "./flowExecutorTestSupport"

// PRB-073 AC-4: imports only the executors, domain types, and the shared
// fixtures above — no SessionRegistryLive, no ArtifactStore, no Layer.

const fakeArtifact: ArtifactRecord = {
  key: "artifact-1",
  label: "artifact",
  kind: "png",
  summary: "s",
  absolutePath: "/tmp/artifact.png",
  relativePath: null,
  external: false,
  createdAt: "2026-01-01T00:00:00.000Z",
}

const snapshotPlannedStep: PlannedStep = { kind: "checkpoint", index: 1, step: { kind: "snapshot" } as never }
const screenshotPlannedStep: PlannedStep = { kind: "evidence", index: 1, step: { kind: "screenshot" } as never }
const videoPlannedStep: PlannedStep = { kind: "evidence", index: 1, step: { kind: "video" } as never }
const logMarkPlannedStep: PlannedStep = { kind: "verified", index: 1, step: { kind: "logMark" } as never }

describe("captureSnapshotEvidenceStep", () => {
  test("a capture failure folds into a failed FlowV2StepResult (no host layer required to observe it)", async () => {
    const record = makeFakeSimulatorRecord()
    const deps: FlowExecutorDeps = {
      ...makeUnusedFlowExecutorDeps(),
      captureSnapshotArtifactInternal: () =>
        Effect.fail(new UnsupportedCapabilityError({
          code: "session-snapshot-real-device-runner",
          capability: "session.snapshot",
          reason: "no live runner",
          nextStep: "n",
          details: [],
          wall: false,
        })),
    }
    const step: FlowV2SnapshotStep = { kind: "snapshot" } as never

    const result = await Effect.runPromise(
      captureSnapshotEvidenceStep({ sessionId: "s1", record, plannedStep: snapshotPlannedStep, step, continueOnError: false, deps }),
    )

    expect(result.verdict).toBe("failed")
    expect(result.summary).toBe("no live runner")
  })
})

describe("captureScreenshotEvidenceStep", () => {
  test("a successful capture reports passed and marks health ok", async () => {
    const record = makeFakeSimulatorRecord()
    const health: { ok: boolean | null } = { ok: null }
    const deps: FlowExecutorDeps = {
      ...makeUnusedFlowExecutorDeps(),
      captureScreenshotArtifact: () => Effect.succeed({ artifact: fakeArtifact, statusLabel: "ok", handledMs: 7 }),
      updateHealthCheck: (_record, _command, ok) => {
        health.ok = ok
      },
    }
    const step: FlowV2ScreenshotStep = { kind: "screenshot" } as never

    const result = await Effect.runPromise(
      captureScreenshotEvidenceStep({ sessionId: "s1", record, plannedStep: screenshotPlannedStep, step, continueOnError: false, deps }),
    )

    expect(result.verdict).toBe("passed")
    expect(health.ok).toBe(true)
    expect(result.handledMs).toBe(7)
  })

  test("a capture failure marks health failed, persists it, and reports a failed step", async () => {
    const record = makeFakeSimulatorRecord()
    let persisted = false
    const deps: FlowExecutorDeps = {
      ...makeUnusedFlowExecutorDeps(),
      captureScreenshotArtifact: () =>
        Effect.fail(new EnvironmentError({ code: "session-screenshot-failed", reason: "boom", nextStep: "n", details: [] })),
      updateHealthCheck: () => {},
      persistRecordHealth: () => {
        persisted = true
        return Effect.void
      },
    }
    const step: FlowV2ScreenshotStep = { kind: "screenshot" } as never

    const result = await Effect.runPromise(
      captureScreenshotEvidenceStep({ sessionId: "s1", record, plannedStep: screenshotPlannedStep, step, continueOnError: true, deps }),
    )

    expect(persisted).toBe(true)
    expect(result.verdict).toBe("failed")
    expect(result.warnings).toContain("Step failed but flow continued because continueOnError was enabled.")
  })
})

describe("captureVideoEvidenceStep", () => {
  test("a successful capture reports passed with the artifact's mode in the summary", async () => {
    const record = makeFakeSimulatorRecord()
    const deps: FlowExecutorDeps = {
      ...makeUnusedFlowExecutorDeps(),
      captureVideoArtifact: () => Effect.succeed({ artifact: fakeArtifact, statusLabel: "ok", mode: "mp4" as const, handledMs: 100 }),
      updateHealthCheck: () => {},
    }
    const step: FlowV2VideoStep = { kind: "video", durationMs: 1_000 } as never

    const result = await Effect.runPromise(
      captureVideoEvidenceStep({ sessionId: "s1", record, plannedStep: videoPlannedStep, step, continueOnError: false, deps }),
    )

    expect(result.verdict).toBe("passed")
    expect(result.summary).toContain("MP4 video")
  })
})

describe("markLogEvidenceStep", () => {
  test("a successful mark reports passed with the mark's summary", async () => {
    const record = makeFakeSimulatorRecord()
    const deps: FlowExecutorDeps = {
      ...makeUnusedFlowExecutorDeps(),
      markLog: () => Effect.succeed({ summary: "marked it" }),
    }
    const step: FlowV2LogMarkStep = { kind: "logMark", label: "checkpoint-a" } as never

    const result = await Effect.runPromise(
      markLogEvidenceStep({ sessionId: "s1", record, plannedStep: logMarkPlannedStep, step, continueOnError: false, deps }),
    )

    expect(result.verdict).toBe("passed")
    expect(result.summary).toBe("marked it")
  })

  test("an empty-label rejection folds into a failed step", async () => {
    const record = makeFakeSimulatorRecord()
    const deps: FlowExecutorDeps = {
      ...makeUnusedFlowExecutorDeps(),
      markLog: () =>
        Effect.fail(new EnvironmentError({ code: "x", reason: "label required", nextStep: "n", details: [] })),
    }
    const step: FlowV2LogMarkStep = { kind: "logMark", label: "" } as never

    const result = await Effect.runPromise(
      markLogEvidenceStep({ sessionId: "s1", record, plannedStep: logMarkPlannedStep, step, continueOnError: false, deps }),
    )

    expect(result.verdict).toBe("failed")
    expect(result.summary).toBe("label required")
  })
})
