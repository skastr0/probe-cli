import { Effect } from "effect"
import type { InvestigationExecutorDeps } from "./investigationExecutorDeps"

/**
 * PRB-099: shared fixture for `InvestigationController`'s contract tests --
 * mirrors `services/flow/flowExecutorTestSupport.ts#makeUnusedFlowExecutorDeps`
 * (same file role: a test builds its scenario by spreading this and
 * overriding only the members it actually exercises).
 *
 * `nowIso`/`newInvestigationId` get real (if test-only) working defaults --
 * a monotonic fake clock and counter -- rather than dying, because unlike
 * every other member here they are called unconditionally on *every* stage
 * transition regardless of scenario (see `InvestigationController.ts`'s
 * `executeStage`), so treating them as "must always be overridden" would
 * make every single test override them for no scenario-specific reason.
 * Every hardware/daemon-touching member still dies if called, so a test
 * that forgot to stub one it actually exercises fails loudly.
 */
export const makeUnusedInvestigationExecutorDeps = (): InvestigationExecutorDeps => {
  let clockTick = 0
  let idCounter = 0

  return {
    nowIso: () => new Date(2026, 0, 1, 0, 0, clockTick++).toISOString(),
    newInvestigationId: () => `fake-investigation-${idCounter++}`,
    checkSessionReady: () => Effect.die("checkSessionReady should not be called in this test"),
    reserveRecorder: () => Effect.die("reserveRecorder should not be called in this test"),
    releaseRecorder: () => Effect.die("releaseRecorder should not be called in this test"),
    runFlow: () => Effect.die("runFlow should not be called in this test"),
    captureRepetition: () => Effect.die("captureRepetition should not be called in this test"),
    sleep: () => Effect.die("sleep should not be called in this test"),
  }
}
