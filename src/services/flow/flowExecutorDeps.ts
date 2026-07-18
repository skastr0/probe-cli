import type { Effect } from "effect"
import type { SessionAction } from "../../domain/action"
import type { ChildProcessError, EnvironmentError, SessionNotFoundError, UnsupportedCapabilityError, UserInputError } from "../../domain/errors"
import type { ArtifactRecord } from "../../domain/output"
import type { SessionHealth } from "../../domain/session"
import type { StoredSnapshotArtifact } from "../../domain/snapshot"
import type { RunnerAction } from "../runnerProtocol"
import type { RunnerCommandResult } from "../SimulatorHarness"
import type {
  ActionExecutionOutcome,
  ActiveSessionRecord,
  RunnerBackedActiveSessionRecord,
  VideoArtifactMode,
} from "../sessionShared"

/**
 * PRB-073: the explicit port bag `runFlow`'s executors take instead of
 * closing over `SessionRegistryLive`'s layer-scoped services directly. Every
 * member here mirrors an existing `SessionRegistryLive` helper 1:1 (same
 * signature, same behavior) — this interface does not change what runs, only
 * how an executor reaches it. Production wiring passes the real
 * `SessionRegistryLive` closures (see `buildFlowExecutorDeps` in
 * SessionRegistry.ts); executor unit tests pass small stand-ins and never
 * construct `SessionRegistryLive`.
 */
export interface FlowExecutorDeps {
  readonly sendRunnerCommand: (
    sessionId: string,
    record: RunnerBackedActiveSessionRecord,
    action: RunnerAction,
    payload?: string,
  ) => Effect.Effect<RunnerCommandResult, EnvironmentError>

  readonly captureSnapshotArtifactInternal: (
    sessionId: string,
    record: ActiveSessionRecord,
  ) => Effect.Effect<
    { readonly artifact: StoredSnapshotArtifact; readonly artifactRecord: ArtifactRecord; readonly handledMs: number },
    UnsupportedCapabilityError | EnvironmentError | ChildProcessError
  >

  readonly captureScreenshotArtifact: (args: {
    readonly sessionId: string
    readonly record: ActiveSessionRecord
    readonly fileStem: string
    readonly artifactKey: string
    readonly artifactLabel: string
    readonly summary: string
  }) => Effect.Effect<
    { readonly artifact: ArtifactRecord; readonly statusLabel: string | null; readonly handledMs: number | null },
    UnsupportedCapabilityError | EnvironmentError | ChildProcessError
  >

  readonly captureVideoArtifact: (args: {
    readonly sessionId: string
    readonly record: ActiveSessionRecord
    readonly durationMs: number
    readonly fileStem: string
    readonly artifactKey: string
    readonly artifactLabel: string
  }) => Effect.Effect<
    { readonly artifact: ArtifactRecord; readonly statusLabel: string | null; readonly mode: VideoArtifactMode; readonly handledMs: number | null },
    UnsupportedCapabilityError | EnvironmentError | ChildProcessError
  >

  readonly markLog: (args: {
    readonly sessionId: string
    readonly label: string
  }) => Effect.Effect<{ readonly summary: string }, SessionNotFoundError | UserInputError | EnvironmentError>

  readonly updateHealthCheck: (record: ActiveSessionRecord, command: string, ok: boolean) => void
  readonly persistHealth: (sessionId: string, health: SessionHealth) => Effect.Effect<void, EnvironmentError>
  readonly persistRecordHealth: (sessionId: string, record: ActiveSessionRecord) => Effect.Effect<void, EnvironmentError>
  readonly refreshSessionArtifacts: (sessionId: string, record: ActiveSessionRecord) => Effect.Effect<void, EnvironmentError>
  readonly persistActionFailure: (
    sessionId: string,
    record: ActiveSessionRecord,
    kind: SessionAction["kind"],
  ) => Effect.Effect<void, EnvironmentError>
  readonly syncDaemonMetadata: Effect.Effect<void>

  readonly executeSessionAction: (args: {
    readonly sessionId: string
    readonly action: SessionAction
    readonly recordAction: boolean
  }) => Effect.Effect<ActionExecutionOutcome, SessionNotFoundError | UserInputError | UnsupportedCapabilityError | EnvironmentError>
}
