import { Effect } from "effect"
import type { ActiveSessionRecord } from "../SessionRegistry"
import type { FlowExecutorDeps } from "./flowExecutorDeps"

/**
 * PRB-073 AC-4: shared fixtures for the flow executor test files. Deliberately
 * does NOT import `SessionRegistryLive`, `ArtifactStore`, or any Effect
 * `Layer` — every executor test in `src/services/flow/*.test.ts` runs these
 * plain objects through `Effect.runPromise` directly, so a single fixture
 * proves the executors are testable without constructing the complete
 * SessionRegistry layer.
 *
 * `health`/`recording`/`snapshotState`/`controller` are cast rather than
 * hand-filled against the full `SessionHealth` schema: none of the
 * extracted executors ever run `Schema.decode` on this fixture (that only
 * happens in `SessionRegistryLive` itself), so the cast is inert for what
 * these tests exercise — only the fields an executor actually reads are
 * populated for real.
 */
export const makeFakeSimulatorRecord = (overrides?: {
  readonly capabilities?: ReadonlyArray<"uiAction" | "uiActionBatch">
  readonly artifactRoot?: string
}): ActiveSessionRecord => {
  const capabilities = overrides?.capabilities ?? ["uiAction", "uiActionBatch"]

  return {
    kind: "simulator",
    health: {
      sessionId: "session-under-test",
      target: { platform: "simulator", bundleId: "com.example.app", deviceId: "udid-1", deviceName: "iPhone" },
      artifactRoot: overrides?.artifactRoot ?? "/tmp/probe-flow-executor-fixture",
      runner: { kind: "simulator-runner", capabilities },
      artifacts: [],
    } as unknown as ActiveSessionRecord["health"],
    baseWarnings: [],
    debuggerBridge: null,
    snapshotState: {
      latest: null,
      nextSnapshotIndex: 1,
      nextElementRefIndex: 1,
    },
    recording: {
      steps: [],
    },
    controller: {} as unknown as ActiveSessionRecord["controller"],
    sendRunnerCommand: () => Promise.reject(new Error("not expected to be called directly in an executor test — mock FlowExecutorDeps.sendRunnerCommand instead")),
    closeResources: () => Promise.resolve(),
    isRunnerRunning: () => true,
    waitForExit: Promise.resolve({ code: null, signal: null }),
  } as unknown as ActiveSessionRecord
}

/** A `FlowExecutorDeps` where every member either no-ops or throws if called — tests override only what they exercise. */
export const makeUnusedFlowExecutorDeps = (): FlowExecutorDeps => ({
  sendRunnerCommand: () => Effect.die("sendRunnerCommand should not be called in this test"),
  captureSnapshotArtifactInternal: () => Effect.die("captureSnapshotArtifactInternal should not be called in this test"),
  captureScreenshotArtifact: () => Effect.die("captureScreenshotArtifact should not be called in this test"),
  captureVideoArtifact: () => Effect.die("captureVideoArtifact should not be called in this test"),
  markLog: () => Effect.die("markLog should not be called in this test"),
  updateHealthCheck: () => {},
  persistHealth: () => Effect.void,
  persistRecordHealth: () => Effect.void,
  refreshSessionArtifacts: () => Effect.void,
  persistActionFailure: () => Effect.void,
  syncDaemonMetadata: Effect.void,
  executeSessionAction: () => Effect.die("executeSessionAction should not be called in this test"),
})
