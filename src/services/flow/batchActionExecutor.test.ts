import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { EnvironmentError } from "../../domain/errors"
import type { FlowSequenceStep } from "../../domain/flow-v2"
import type { PlannedStep } from "../../domain/flow-planner"
import type { RunnerCommandResult } from "../SimulatorHarness"
import type { FlowExecutorDeps } from "./flowExecutorDeps"
import {
  buildBatchSequenceChildFailure,
  buildBatchStepResult,
  buildRunnerBatchSequencePayload,
  executeBatchActionStep,
  toFlowSequenceActionKind,
} from "./batchActionExecutor"
import { makeFakeSimulatorRecord, makeUnusedFlowExecutorDeps } from "./flowExecutorTestSupport"

// PRB-073 AC-4: imports only the executor, domain types, and the shared
// fixtures above — no SessionRegistryLive, no ArtifactStore, no Layer.

const baseRunnerCommandResult: RunnerCommandResult = {
  ok: true,
  action: "uiActionBatch",
  error: null,
  payload: null,
  snapshotPayloadPath: null,
  handledMs: 30,
  statusLabel: "ok",
  snapshotNodeCount: null,
  hostRttMs: 5,
}

const sequenceStep: FlowSequenceStep = {
  kind: "sequence",
  actions: [{ kind: "tap", target: { kind: "point", x: 1, y: 2 } }],
} as never

const plannedStep: PlannedStep = { kind: "batch-sequence", index: 1, step: sequenceStep }

describe("buildRunnerBatchSequencePayload / toFlowSequenceActionKind", () => {
  test("encodes a wait action distinctly from UI actions", () => {
    const payload = buildRunnerBatchSequencePayload([{ kind: "wait", timeoutMs: 10 } as never])
    expect(payload.actions).toEqual([{ kind: "wait", timeoutMs: 10 }])
  })

  test("round-trips every known child action kind, and rejects an unknown one", () => {
    for (const kind of ["tap", "multiTap", "press", "swipe", "type", "scroll", "wait"] as const) {
      expect(toFlowSequenceActionKind(kind)).toBe(kind)
    }
    expect(toFlowSequenceActionKind("not-a-kind")).toBeNull()
    expect(toFlowSequenceActionKind(undefined)).toBeNull()
  })

  // PRB-092: multiTap as a batch child goes through the exact same
  // direct-runner-payload builder as tap/press/swipe/type/scroll — "one
  // domain schema" for both the direct-action and batch-child shapes.
  test("encodes a multiTap child carrying tapCount/interTapDelayMs", () => {
    const payload = buildRunnerBatchSequencePayload([
      {
        kind: "multiTap",
        target: { kind: "point", x: 1, y: 2 },
        tapCount: 5,
        interTapDelayMs: 60,
      } as never,
    ])
    expect(payload.actions).toHaveLength(1)
    const child = payload.actions[0] as { kind: string; tapCount?: number; interTapDelayMs?: number }
    expect(child.kind).toBe("multiTap")
    expect(child.tapCount).toBe(5)
    expect(child.interTapDelayMs).toBe(60)
  })
})

describe("buildBatchSequenceChildFailure", () => {
  test("returns null when the runner reports no failing child index", () => {
    const failure = buildBatchSequenceChildFailure({
      step: sequenceStep,
      response: { ...baseRunnerCommandResult, failedActionIndex: null },
      failureReason: "boom",
    })
    expect(failure).toBeNull()
  })

  test("resolves the failing child's kind from the planned step when the index is known", () => {
    const failure = buildBatchSequenceChildFailure({
      step: sequenceStep,
      response: { ...baseRunnerCommandResult, failedActionIndex: 0 },
      failureReason: "boom",
    })
    expect(failure).toEqual({ index: 1, kind: "tap", summary: "boom" })
  })
})

describe("executeBatchActionStep", () => {
  test("never fails as an Effect — a capability gate miss reports through the outcome, not the error channel", async () => {
    const record = makeFakeSimulatorRecord({ capabilities: [] })
    const deps = makeUnusedFlowExecutorDeps()

    const outcome = await Effect.runPromise(
      executeBatchActionStep({ sessionId: "s1", record, step: sequenceStep, deps }),
    )

    expect(outcome.ok).toBe(false)
  })

  test("dispatches through deps.sendRunnerCommand, captures the default post-batch evidence snapshot, and reports ok:true", async () => {
    const record = makeFakeSimulatorRecord()
    const dispatch: { action: string | null } = { action: null }
    let snapshotCaptures = 0
    const deps: FlowExecutorDeps = {
      ...makeUnusedFlowExecutorDeps(),
      sendRunnerCommand: (_sessionId, _record, action) => {
        dispatch.action = action
        return Effect.succeed(baseRunnerCommandResult)
      },
      captureSnapshotArtifactInternal: () => {
        snapshotCaptures += 1
        return Effect.succeed({ artifact: { snapshotId: "@s1" }, artifactRecord: {}, handledMs: 7 } as never)
      },
      updateHealthCheck: () => {},
      persistRecordHealth: () => Effect.void,
    }

    const outcome = await Effect.runPromise(
      executeBatchActionStep({ sessionId: "s1", record, step: sequenceStep, deps }),
    )

    expect(dispatch.action).toBe("uiActionBatch")
    expect(outcome.ok).toBe(true)
    // PRB-093: default policy (success=end) captures exactly one post-batch
    // snapshot regardless of child count -- the old "none"-by-default
    // checkpoint captured nothing.
    expect(snapshotCaptures).toBe(1)
    if (outcome.ok) {
      expect(outcome.value.evidenceCaptures).toEqual([{ reason: "policy-post", phase: "post", snapshotId: "@s1", ms: 7 }])
    }
  })

  test("policy success=none skips the post-batch snapshot for an N-child batch", async () => {
    const record = makeFakeSimulatorRecord()
    let snapshotCaptures = 0
    const deps: FlowExecutorDeps = {
      ...makeUnusedFlowExecutorDeps(),
      sendRunnerCommand: () => Effect.succeed(baseRunnerCommandResult),
      captureSnapshotArtifactInternal: () => {
        snapshotCaptures += 1
        return Effect.succeed({ artifact: { snapshotId: "@s1" }, artifactRecord: {}, handledMs: 7 } as never)
      },
      updateHealthCheck: () => {},
      persistRecordHealth: () => Effect.void,
    }
    const noneStep: FlowSequenceStep = {
      ...sequenceStep,
      actions: [
        { kind: "tap", target: { kind: "point", x: 1, y: 2 } },
        { kind: "tap", target: { kind: "point", x: 3, y: 4 } },
        { kind: "tap", target: { kind: "point", x: 5, y: 6 } },
      ],
      evidencePolicy: { success: "none" },
    } as never

    const outcome = await Effect.runPromise(
      executeBatchActionStep({ sessionId: "s1", record, step: noneStep, deps }),
    )

    expect(outcome.ok).toBe(true)
    expect(snapshotCaptures).toBe(0)
    if (outcome.ok) {
      expect(outcome.value.evidenceCaptures).toEqual([])
    }
  })

  test("policy success=around captures exactly one pre and one post snapshot regardless of child count", async () => {
    const record = makeFakeSimulatorRecord()
    let snapshotCaptures = 0
    const deps: FlowExecutorDeps = {
      ...makeUnusedFlowExecutorDeps(),
      sendRunnerCommand: () => Effect.succeed(baseRunnerCommandResult),
      captureSnapshotArtifactInternal: () => {
        snapshotCaptures += 1
        return Effect.succeed({
          artifact: { snapshotId: `@s${snapshotCaptures}` },
          artifactRecord: {},
          handledMs: 7,
        } as never)
      },
      updateHealthCheck: () => {},
      persistRecordHealth: () => Effect.void,
    }
    const aroundStep: FlowSequenceStep = {
      ...sequenceStep,
      actions: [
        { kind: "tap", target: { kind: "point", x: 1, y: 2 } },
        { kind: "tap", target: { kind: "point", x: 3, y: 4 } },
      ],
      evidencePolicy: { success: "around" },
    } as never

    const outcome = await Effect.runPromise(
      executeBatchActionStep({ sessionId: "s1", record, step: aroundStep, deps }),
    )

    expect(outcome.ok).toBe(true)
    expect(snapshotCaptures).toBe(2)
    if (outcome.ok) {
      expect(outcome.value.evidenceCaptures.map((capture) => capture.phase)).toEqual(["pre", "post"])
    }
  })
})

describe("buildBatchStepResult", () => {
  test("a dispatch failure folds into a failed FlowV2StepResult", () => {
    const result = buildBatchStepResult({
      plannedStep,
      step: sequenceStep,
      continueOnError: false,
      outcome: { ok: false, error: new EnvironmentError({ code: "x", reason: "dispatch failed", nextStep: "n", details: [] }) },
      latestSnapshotIdBefore: null,
    })

    expect(result.verdict).toBe("failed")
    expect(result.summary).toBe("dispatch failed")
    expect(result.evidence).toEqual({
      requested: { success: "end", failure: "snapshot" },
      captures: [],
      evidenceMs: 0,
    })
  })

  test("a successful batch with no captures reports passed and falls back to the prior snapshot id", () => {
    const result = buildBatchStepResult({
      plannedStep,
      step: sequenceStep,
      continueOnError: false,
      outcome: {
        ok: true,
        value: { response: baseRunnerCommandResult, evidenceCaptures: [], postCaptureError: null },
      },
      latestSnapshotIdBefore: "prior-snap",
    })

    expect(result.verdict).toBe("passed")
    expect(result.latestSnapshotId).toBe("prior-snap")
    expect(result.handledMs).toBe(30)
  })

  test("a runner-reported child failure surfaces sequenceChildFailure", () => {
    const result = buildBatchStepResult({
      plannedStep,
      step: sequenceStep,
      continueOnError: false,
      outcome: {
        ok: true,
        value: {
          response: { ...baseRunnerCommandResult, ok: false, error: "child failed", failedActionIndex: 0 },
          evidenceCaptures: [],
          postCaptureError: null,
        },
      },
      latestSnapshotIdBefore: null,
    })

    expect(result.verdict).toBe("failed")
    expect(result.sequenceChildFailure).toEqual({ index: 1, kind: "tap", summary: "child failed" })
  })
})
