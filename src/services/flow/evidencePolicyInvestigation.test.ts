import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { FlowSequenceStep } from "../../domain/flow-v2"
import type { FlowV2FastSingleStep } from "../../domain/flow-v2"
import { executeBatchActionStep } from "./batchActionExecutor"
import { executeDirectRunnerActionStep } from "./directRunnerActionExecutor"
import type { FlowExecutorDeps } from "./flowExecutorDeps"
import { makeFakeSimulatorRecord, makeUnusedFlowExecutorDeps } from "./flowExecutorTestSupport"

/**
 * PRB-093 acceptance criterion #12: "investigation recipes must prove every
 * repetition used the frozen policy." This is the in-process, deterministic
 * counterpart of a live-device investigation harness (see
 * src/investigations/rpc-daemon-defects for the pattern this repo already
 * uses for repeated-scenario proofs) — no PHYSICAL-DEVICE gate applies here
 * because the evidence-policy decision is pure host-side orchestration, not
 * a runner/device seam; a live-device run would exercise the same code path
 * with more latency, not different logic.
 *
 * Each recipe below repeats the SAME flow step N times through a fresh
 * fixture each iteration, with a `evidencePolicy` value that is fixed once,
 * outside the loop, and never touched inside it -- "frozen" is the loop
 * literally referencing one closed-over policy object. Every repetition's
 * actual captures are compared against every other repetition's; a single
 * assertion at the end proving them all identical is the "every repetition
 * used the frozen policy" proof — a policy that drifted between runs (e.g.
 * a stray mutation of the frozen object, or a capture path that reads a
 * different default) would show up as a mismatched repetition.
 */

const REPETITIONS = 5

describe("PRB-093 investigation recipe: frozen evidence policy across repeated runs", () => {
  test("a frozen success=end policy captures exactly one post-mutation snapshot on every repetition of a fast direct-runner tap", async () => {
    const frozenPolicy = Object.freeze({ success: "end" as const })
    const perRepetitionReasons: Array<ReadonlyArray<string>> = []

    for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
      const record = makeFakeSimulatorRecord()
      let snapshotCaptures = 0
      const deps: FlowExecutorDeps = {
        ...makeUnusedFlowExecutorDeps(),
        sendRunnerCommand: () =>
          Effect.succeed({
            ok: true,
            action: "uiAction",
            error: null,
            payload: null,
            snapshotPayloadPath: null,
            handledMs: 3,
            statusLabel: "ok",
            snapshotNodeCount: null,
            hostRttMs: 1,
          } as never),
        captureSnapshotArtifactInternal: () => {
          snapshotCaptures += 1
          return Effect.succeed({
            artifact: { snapshotId: `@rep${repetition}-s${snapshotCaptures}` },
            artifactRecord: {},
            handledMs: 2,
          } as never)
        },
        updateHealthCheck: () => {},
        persistHealth: () => Effect.void,
        syncDaemonMetadata: Effect.void,
      }
      const step: FlowV2FastSingleStep = {
        kind: "tap",
        target: { kind: "point", x: 1, y: 2 },
        evidencePolicy: frozenPolicy,
      } as never

      const outcome = await Effect.runPromise(
        executeDirectRunnerActionStep({ sessionId: `s-${repetition}`, record, step, deps }),
      )

      if (!outcome.ok) {
        throw new Error(`Repetition ${repetition} unexpectedly failed.`)
      }

      expect(outcome.result.evidence.requested).toEqual({ success: "end", failure: "snapshot" })
      perRepetitionReasons.push(outcome.result.evidence.captures.map((capture) => capture.reason))
    }

    expect(frozenPolicy).toEqual({ success: "end" })
    // Every repetition produced the exact same capture shape -- the policy
    // never drifted across the loop.
    for (const reasons of perRepetitionReasons) {
      expect(reasons).toEqual(["policy-post"])
    }
    expect(new Set(perRepetitionReasons.map((reasons) => JSON.stringify(reasons))).size).toBe(1)
  })

  test("a frozen success=none policy captures zero snapshots on every repetition of an N-child batch", async () => {
    const frozenPolicy = Object.freeze({ success: "none" as const })
    const perRepetitionCaptureCounts: Array<number> = []

    for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
      const record = makeFakeSimulatorRecord()
      let snapshotCaptures = 0
      const deps: FlowExecutorDeps = {
        ...makeUnusedFlowExecutorDeps(),
        sendRunnerCommand: () =>
          Effect.succeed({
            ok: true,
            action: "uiActionBatch",
            error: null,
            payload: null,
            snapshotPayloadPath: null,
            handledMs: 5,
            statusLabel: "ok",
            snapshotNodeCount: null,
            hostRttMs: 1,
          } as never),
        captureSnapshotArtifactInternal: () => {
          snapshotCaptures += 1
          return Effect.succeed({ artifact: { snapshotId: `@rep${repetition}` }, artifactRecord: {}, handledMs: 2 } as never)
        },
        updateHealthCheck: () => {},
        persistRecordHealth: () => Effect.void,
      }
      const step: FlowSequenceStep = {
        kind: "sequence",
        evidencePolicy: frozenPolicy,
        actions: [
          { kind: "tap", target: { kind: "point", x: 1, y: 2 } },
          { kind: "tap", target: { kind: "point", x: 3, y: 4 } },
          { kind: "tap", target: { kind: "point", x: 5, y: 6 } },
        ],
      } as never

      const outcome = await Effect.runPromise(
        executeBatchActionStep({ sessionId: `s-${repetition}`, record, step, deps }),
      )

      if (!outcome.ok) {
        throw new Error(`Repetition ${repetition} unexpectedly failed.`)
      }

      perRepetitionCaptureCounts.push(outcome.value.evidenceCaptures.length)
      expect(snapshotCaptures).toBe(0)
    }

    expect(frozenPolicy).toEqual({ success: "none" })
    expect(perRepetitionCaptureCounts).toEqual(new Array(REPETITIONS).fill(0))
  })
})
