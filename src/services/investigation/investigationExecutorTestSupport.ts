import { Effect } from "effect"
import type { InvestigationExecutorDeps } from "./investigationExecutorDeps"

/**
 * PRB-099: shared fixture for `InvestigationController`'s contract tests --
 * mirrors `services/flow/flowExecutorTestSupport.ts#makeUnusedFlowExecutorDeps`
 * exactly (same file role, same "every member dies if called" shape). A test
 * builds its scenario by spreading this and overriding only the members it
 * actually exercises, so an un-stubbed call fails loudly with a named
 * message instead of silently no-oping.
 */
export const makeUnusedInvestigationExecutorDeps = (): InvestigationExecutorDeps => ({
  nowIso: () => {
    throw new Error("nowIso: not stubbed for this test")
  },
  newInvestigationId: () => {
    throw new Error("newInvestigationId: not stubbed for this test")
  },
  checkSessionReady: () => Effect.die("checkSessionReady should not be called in this test"),
  reserveRecorder: () => Effect.die("reserveRecorder should not be called in this test"),
  releaseRecorder: () => Effect.die("releaseRecorder should not be called in this test"),
  runFlow: () => Effect.die("runFlow should not be called in this test"),
  captureRepetition: () => Effect.die("captureRepetition should not be called in this test"),
  sleep: () => Effect.die("sleep should not be called in this test"),
})
