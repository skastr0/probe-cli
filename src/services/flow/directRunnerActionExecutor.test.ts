import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { EnvironmentError } from "../../domain/errors"
import type { FlowV2FastSingleStep } from "../../domain/flow-v2"
import type { RunnerCommandResult } from "../SimulatorHarness"
import { executeDirectRunnerActionStep } from "./directRunnerActionExecutor"
import type { FlowExecutorDeps } from "./flowExecutorDeps"
import { makeFakeSimulatorRecord, makeUnusedFlowExecutorDeps } from "./flowExecutorTestSupport"

// PRB-073 AC-4: imports only the executor, domain types, and the shared
// fixtures above — no SessionRegistryLive, no ArtifactStore, no Layer.

const baseRunnerCommandResult: RunnerCommandResult = {
  ok: true,
  action: "uiAction",
  error: null,
  payload: null,
  snapshotPayloadPath: null,
  handledMs: 42,
  statusLabel: "ok",
  snapshotNodeCount: null,
  hostRttMs: 5,
}

describe("executeDirectRunnerActionStep", () => {
  test("a wait step sleeps and reports passed without dispatching to the runner", async () => {
    const record = makeFakeSimulatorRecord()
    // A holder object, not a bare `let`: bun-types' `expect().toBe()`
    // overload resolution over-narrows a `let x: string | null = null`
    // that is only ever reassigned inside a closure — see the sibling
    // test files for the same pattern.
    const updatedHealth: { command: string | null } = { command: null }
    const deps: FlowExecutorDeps = {
      ...makeUnusedFlowExecutorDeps(),
      updateHealthCheck: (_record, command) => {
        updatedHealth.command = command
      },
      persistHealth: () => Effect.void,
      syncDaemonMetadata: Effect.void,
    }
    const step: FlowV2FastSingleStep = { kind: "wait", timeoutMs: 5 } as never

    const outcome = await Effect.runPromise(
      executeDirectRunnerActionStep({ sessionId: "s1", record, step, deps }),
    )

    expect(outcome.ok).toBe(true)
    expect(updatedHealth.command).toBe("wait")
    if (outcome.ok) {
      expect(outcome.result.summary).toBe("Waited 5ms before continuing.")
    }
  })

  test("dispatches a tap through deps.sendRunnerCommand and reports passed on success", async () => {
    const record = makeFakeSimulatorRecord()
    const dispatch: { action: string | null } = { action: null }
    const deps: FlowExecutorDeps = {
      ...makeUnusedFlowExecutorDeps(),
      sendRunnerCommand: (_sessionId, _record, action) => {
        dispatch.action = action
        return Effect.succeed(baseRunnerCommandResult)
      },
      updateHealthCheck: () => {},
      persistHealth: () => Effect.void,
      syncDaemonMetadata: Effect.void,
    }
    const step: FlowV2FastSingleStep = { kind: "tap", target: { kind: "point", x: 1, y: 2 } } as never

    const outcome = await Effect.runPromise(
      executeDirectRunnerActionStep({ sessionId: "s1", record, step, deps }),
    )

    expect(dispatch.action).toBe("uiAction")
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.summary).toContain("point(1, 2)")
      expect(outcome.result.handledMs).toBe(42)
    }
  })

  test("a runner failure captures a snapshot, persists the failure, and reports ok:false", async () => {
    const record = makeFakeSimulatorRecord()
    let capturedFailureSnapshot = false
    const persistedFailure: { kind: string | null } = { kind: null }
    const deps: FlowExecutorDeps = {
      ...makeUnusedFlowExecutorDeps(),
      sendRunnerCommand: () =>
        Effect.succeed({
          ...baseRunnerCommandResult,
          ok: false,
          error: "no element matched",
        }),
      captureSnapshotArtifactInternal: () => {
        capturedFailureSnapshot = true
        // The executor only wraps this in `Effect.either` and discards the
        // result either way (it is a best-effort failure snapshot) — a
        // failure here is enough to prove it was invoked, without needing
        // a full StoredSnapshotArtifact fixture.
        return Effect.fail(new EnvironmentError({ code: "session-snapshot-failed", reason: "n/a", nextStep: "n", details: [] }))
      },
      persistActionFailure: (_sessionId, _record, kind) => {
        persistedFailure.kind = kind
        return Effect.void
      },
    }
    const step: FlowV2FastSingleStep = { kind: "tap", target: { kind: "point", x: 1, y: 2 } } as never

    const outcome = await Effect.runPromise(
      executeDirectRunnerActionStep({ sessionId: "s1", record, step, deps }),
    )

    expect(capturedFailureSnapshot).toBe(true)
    expect(persistedFailure.kind).toBe("tap")
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(EnvironmentError)
      expect(outcome.error instanceof EnvironmentError ? outcome.error.reason : null).toBe("no element matched")
    }
  })

  test("fails closed when the runner does not advertise uiAction", async () => {
    const record = makeFakeSimulatorRecord({ capabilities: [] })
    const deps = makeUnusedFlowExecutorDeps()
    const step: FlowV2FastSingleStep = { kind: "tap", target: { kind: "point", x: 1, y: 2 } } as never

    const result = await Effect.runPromise(Effect.either(
      executeDirectRunnerActionStep({ sessionId: "s1", record, step, deps }),
    ))

    expect(result._tag).toBe("Left")
  })
})
