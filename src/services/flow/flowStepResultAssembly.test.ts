import { describe, expect, test } from "bun:test"
import { Either } from "effect"
import { EnvironmentError, SessionNotFoundError } from "../../domain/errors"
import type { PlannedStep } from "../../domain/flow-planner"
import type { ArtifactRecord } from "../../domain/output"
import type { ActionExecutionOutcome } from "../SessionRegistry"
import {
  assembleFlowResult,
  buildActionOutcomeStepResult,
  buildFlowStepResult,
  classifyFastFailureCode,
  diffArtifacts,
  errorSummary,
  failureVerdict,
  failureWarnings,
  foldFlowStepOutcome,
  mergeVerdict,
  plannedExecutionProfile,
  plannedTransportLane,
  successWarnings,
  toFailedStep,
} from "./flowStepResultAssembly"

// PRB-073 AC-4: this file imports only pure helpers plus domain error/step
// types — no SessionRegistryLive, no ArtifactStore, no Effect Layer.

const tapPlannedStep: PlannedStep = {
  kind: "verified",
  index: 1,
  step: { kind: "tap", target: { kind: "point", x: 1, y: 2 } } as never,
}

const fastPlannedStep: PlannedStep = {
  kind: "fast-single",
  index: 1,
  step: { kind: "tap", target: { kind: "point", x: 1, y: 2 } } as never,
}

describe("failureVerdict", () => {
  test("maps a session-wait-timeout EnvironmentError to timed-out", () => {
    const error = new EnvironmentError({ code: "session-wait-timeout", reason: "r", nextStep: "n", details: [] })
    expect(failureVerdict(error)).toBe("timed-out")
  })

  test("maps every other error to failed", () => {
    const error = new EnvironmentError({ code: "session-action-failed", reason: "r", nextStep: "n", details: [] })
    expect(failureVerdict(error)).toBe("failed")
  })
})

describe("errorSummary", () => {
  test("reads sessionId off a SessionNotFoundError instead of .reason", () => {
    const error = new SessionNotFoundError({ sessionId: "abc", nextStep: "n" })
    expect(errorSummary(error)).toBe("Session abc was not found.")
  })

  test("reads .reason off every other SessionActionError", () => {
    const error = new EnvironmentError({ code: "x", reason: "boom", nextStep: "n", details: [] })
    expect(errorSummary(error)).toBe("boom")
  })
})

describe("failureWarnings", () => {
  test("collects nextStep and details, and appends the continueOnError note", () => {
    const error = new EnvironmentError({ code: "x", reason: "boom", nextStep: "retry it", details: ["detail-a"] })
    expect(failureWarnings({ error, continued: true })).toEqual([
      "retry it",
      "detail-a",
      "Step failed but flow continued because continueOnError was enabled.",
    ])
  })

  test("omits the continueOnError note when the flow stopped", () => {
    const error = new EnvironmentError({ code: "x", reason: "boom", nextStep: "retry it", details: [] })
    expect(failureWarnings({ error, continued: false })).toEqual(["retry it"])
  })
})

describe("classifyFastFailureCode", () => {
  test("classifies a not-found-shaped reason as target-not-found", () => {
    expect(classifyFastFailureCode("no element matched the selector")).toBe("session-action-target-not-found")
  })

  test("classifies every other reason as a generic action failure", () => {
    expect(classifyFastFailureCode("runner crashed")).toBe("session-action-failed")
  })
})

describe("plannedExecutionProfile / plannedTransportLane", () => {
  test("fast-single and batch-sequence are the fast profile", () => {
    expect(plannedExecutionProfile(fastPlannedStep)).toBe("fast")
    expect(plannedExecutionProfile({ kind: "batch-sequence", index: 1, step: { actions: [] } as never })).toBe("fast")
  })

  test("verified is the verified profile", () => {
    expect(plannedExecutionProfile(tapPlannedStep)).toBe("verified")
  })

  test("a fast-single wait step routes to the host-single lane", () => {
    const waitPlanned: PlannedStep = { kind: "fast-single", index: 1, step: { kind: "wait", timeoutMs: 10 } as never }
    expect(plannedTransportLane(waitPlanned)).toBe("host-single")
  })

  test("a fast-single non-wait step routes to the runner-single lane", () => {
    expect(plannedTransportLane(fastPlannedStep)).toBe("runner-single")
  })

  test("batch-sequence routes to the runner-batch lane", () => {
    expect(plannedTransportLane({ kind: "batch-sequence", index: 1, step: { actions: [] } as never })).toBe("runner-batch")
  })
})

describe("mergeVerdict", () => {
  test("timed-out dominates every other verdict", () => {
    expect(mergeVerdict("passed", "timed-out")).toBe("timed-out")
    expect(mergeVerdict("failed", "timed-out")).toBe("timed-out")
  })

  test("failed dominates passed", () => {
    expect(mergeVerdict("passed", "failed")).toBe("failed")
  })

  test("passed stays passed", () => {
    expect(mergeVerdict("passed", "passed")).toBe("passed")
  })
})

describe("diffArtifacts", () => {
  test("returns only artifacts new since `before`", () => {
    const before = [{ key: "a" }, { key: "b" }] as unknown as ReadonlyArray<ArtifactRecord>
    const after = [{ key: "a" }, { key: "b" }, { key: "c" }] as unknown as ReadonlyArray<ArtifactRecord>
    expect(diffArtifacts(before, after)).toEqual([{ key: "c" }] as unknown as Array<ArtifactRecord>)
  })
})

describe("buildFlowStepResult / toFailedStep", () => {
  test("derives executionProfile/transportLane from the planned step, and defaults evidence/sequenceChildFailure", () => {
    const result = buildFlowStepResult({
      plannedStep: tapPlannedStep,
      kind: "tap",
      summary: "ok",
      verdict: "passed",
      matchedRef: null,
      latestSnapshotId: "snap-1",
      retryCount: 0,
      retryReasons: [],
      warnings: [],
      handledMs: 12,
    })

    expect(result.executionProfile).toBe("verified")
    expect(result.transportLane).toBe("host-single")
    expect(result.evidence).toEqual({
      requested: { success: "end", failure: "snapshot" },
      captures: [],
      evidenceMs: 0,
    })
    expect(result.sequenceChildFailure).toBeNull()

    const failed = toFailedStep({ ...result, verdict: "failed" })
    expect(failed).toEqual({
      index: 1,
      kind: "tap",
      summary: "ok",
      verdict: "failed",
      executionProfile: "verified",
      transportLane: "host-single",
      handledMs: 12,
      evidence: {
        requested: { success: "end", failure: "snapshot" },
        captures: [],
        evidenceMs: 0,
      },
      sequenceChildFailure: null,
    })
  })
})

describe("buildActionOutcomeStepResult", () => {
  const step = { kind: "tap", continueOnError: false, target: { kind: "point", x: 1, y: 2 } } as never

  test("Left (effect failure) folds into a failed step using errorSummary/failureVerdict", () => {
    const outcome = Either.left(new EnvironmentError({ code: "session-wait-timeout", reason: "boom", nextStep: "n", details: [] }))
    const result = buildActionOutcomeStepResult({
      plannedStep: tapPlannedStep,
      step,
      continueOnError: false,
      latestSnapshotIdBefore: "prior-snap",
      outcome,
    })

    expect(result.verdict).toBe("timed-out")
    expect(result.summary).toBe("boom")
    expect(result.latestSnapshotId).toBe("prior-snap")
  })

  test("Right with ok:false folds into a failed step carrying the executor's retry metadata and evidence", () => {
    // PRB-093 review finding: a failed step's best-effort failure snapshot
    // must survive into the flow step result instead of being defaulted
    // away to an empty evidence report.
    const outcome: Either.Either<ActionExecutionOutcome, never> = Either.right({
      ok: false,
      error: new EnvironmentError({ code: "session-action-failed", reason: "no element", nextStep: "n", details: [] }),
      retry: { retryCount: 2, retryReasons: ["not-found: x"] },
      evidence: {
        requested: { success: "end", failure: "snapshot" },
        captures: [{ reason: "policy-failure", phase: "post", snapshotId: "@failure-1", ms: 9 }],
        evidenceMs: 9,
      },
    })
    const result = buildActionOutcomeStepResult({
      plannedStep: tapPlannedStep,
      step,
      continueOnError: false,
      latestSnapshotIdBefore: null,
      outcome,
    })

    expect(result.verdict).toBe("failed")
    expect(result.retryCount).toBe(2)
    expect(result.retryReasons).toEqual(["not-found: x"])
    expect(result.evidence.captures).toEqual([{ reason: "policy-failure", phase: "post", snapshotId: "@failure-1", ms: 9 }])
    expect(result.evidence.evidenceMs).toBe(9)
  })

  test("Right with ok:true folds into a passed step using the executor's result", () => {
    const outcome: Either.Either<ActionExecutionOutcome, never> = Either.right({
      ok: true,
      result: {
        summary: "tapped it",
        action: "tap",
        matchedRef: "ref-1",
        resolvedBy: "semantic",
        statusLabel: "ok",
        latestSnapshotId: "snap-2",
        artifact: null,
        recordingLength: 1,
        handledMs: 5,
        retryCount: 0,
        retryReasons: [],
        verdict: null,
        waitedMs: null,
        polledCount: null,
        evidence: {
          requested: { success: "end", failure: "snapshot" },
          captures: [{ reason: "policy-post", phase: "post", snapshotId: "snap-2", ms: 4 }],
          evidenceMs: 4,
        },
      },
    })
    const result = buildActionOutcomeStepResult({
      plannedStep: tapPlannedStep,
      step,
      continueOnError: false,
      latestSnapshotIdBefore: null,
      outcome,
    })

    expect(result.verdict).toBe("passed")
    expect(result.summary).toBe("tapped it")
    expect(result.matchedRef).toBe("ref-1")
    expect(result.latestSnapshotId).toBe("snap-2")
    expect(result.evidence.captures).toHaveLength(1)
  })
})

describe("foldFlowStepOutcome", () => {
  const baseStepResult = buildFlowStepResult({
    plannedStep: tapPlannedStep,
    kind: "tap",
    summary: "ok",
    verdict: "passed",
    matchedRef: null,
    latestSnapshotId: null,
    retryCount: 1,
    retryReasons: [],
    warnings: [],
    handledMs: null,
  })

  test("a passed step never sets failedStep and never stops the loop", () => {
    const folded = foldFlowStepOutcome({
      executedSteps: [],
      createdArtifacts: [],
      overallVerdict: "passed",
      totalRetries: 0,
      failedStep: null,
      stepResult: baseStepResult,
      stepArtifacts: [],
      continueOnError: false,
    })

    expect(folded.stoppedEarly).toBe(false)
    expect(folded.failedStep).toBeNull()
    expect(folded.totalRetries).toBe(1)
    expect(folded.executedSteps).toHaveLength(1)
  })

  test("a failed step with continueOnError false stops the loop", () => {
    const folded = foldFlowStepOutcome({
      executedSteps: [],
      createdArtifacts: [],
      overallVerdict: "passed",
      totalRetries: 0,
      failedStep: null,
      stepResult: { ...baseStepResult, verdict: "failed" },
      stepArtifacts: [],
      continueOnError: false,
    })

    expect(folded.stoppedEarly).toBe(true)
    expect(folded.overallVerdict).toBe("failed")
    expect(folded.failedStep?.verdict).toBe("failed")
  })

  test("a failed step with continueOnError true keeps the loop going", () => {
    const folded = foldFlowStepOutcome({
      executedSteps: [],
      createdArtifacts: [],
      overallVerdict: "passed",
      totalRetries: 0,
      failedStep: null,
      stepResult: { ...baseStepResult, verdict: "failed" },
      stepArtifacts: [],
      continueOnError: true,
    })

    expect(folded.stoppedEarly).toBe(false)
  })
})

describe("assembleFlowResult", () => {
  test("dedupes artifacts by key and reports a clean-pass summary when nothing failed", () => {
    const artifacts = [{ key: "a" }, { key: "a" }, { key: "b" }] as never
    const result = assembleFlowResult({
      sessionId: "s1",
      executedAt: "2026-01-01T00:00:00.000Z",
      executedSteps: [],
      createdArtifacts: artifacts,
      overallVerdict: "passed",
      totalRetries: 0,
      failedStep: null,
      stoppedEarly: false,
      finalSnapshotId: "snap-final",
    })

    expect(result.artifacts).toHaveLength(2)
    expect(result.verdict).toBe("passed")
    expect(result.summary).toContain("successfully")
    expect(result.finalSnapshotId).toBe("snap-final")
  })

  test("reports a stopped-early summary naming the failed step's index", () => {
    const failedStep = toFailedStep(buildFlowStepResult({
      plannedStep: tapPlannedStep,
      kind: "tap",
      summary: "boom",
      verdict: "failed",
      matchedRef: null,
      latestSnapshotId: null,
      retryCount: 0,
      retryReasons: [],
      warnings: [],
      handledMs: null,
    }))

    const result = assembleFlowResult({
      sessionId: "s1",
      executedAt: "2026-01-01T00:00:00.000Z",
      executedSteps: [],
      createdArtifacts: [],
      overallVerdict: "failed",
      totalRetries: 0,
      failedStep,
      stoppedEarly: true,
      finalSnapshotId: null,
    })

    expect(result.summary).toContain("failed at step 1")
  })
})

describe("successWarnings", () => {
  test("adds the selector-drift warning only for a semantic-resolved ref fallback", () => {
    const step = { kind: "tap", target: { kind: "ref", fallback: { kind: "semantic" } } } as never
    const withoutFallback = successWarnings({ step, baseWarnings: [], resolvedBy: "point" })
    const withFallback = successWarnings({ step, baseWarnings: [], resolvedBy: "semantic" })

    expect(withoutFallback).toEqual([])
    expect(withFallback).toHaveLength(1)
  })
})
