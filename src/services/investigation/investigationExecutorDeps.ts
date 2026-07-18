import type { Effect } from "effect"
import type {
  ArtifactNotFoundError,
  ChildProcessError,
  DaemonNotRunningError,
  EnvironmentError,
  ProtocolMismatchError,
  SessionConflictError,
  SessionNotFoundError,
  UnsupportedCapabilityError,
  UserInputError,
} from "../../domain/errors"
import type { InvestigationCaptureSpec } from "../../domain/investigation"
import type { PerfEvidenceReport } from "../../domain/perf-evidence"
import type { SessionFlowContract } from "../../domain/flow-v2"

/**
 * PRB-099: the explicit port bag `InvestigationController`'s stage executor
 * takes instead of closing over `DaemonClient`/`ArtifactStore` directly --
 * same role as `FlowExecutorDeps` (services/flow/flowExecutorDeps.ts) for
 * flow execution. Production wiring (investigationExecutorDepsLive.ts)
 * adapts real `DaemonClient` RPC calls plus a local read of the exported
 * trace XML (`domain/perf.ts#parsePerfTableExport`) into
 * `captureRepetition`'s one `PerfEvidenceReport` per repetition; contract
 * tests (InvestigationController.test.ts) pass small fakes and never touch
 * a daemon, simulator, or device -- exactly the "recorded/fake capture
 * lanes" the glyph notes call for.
 */
export type InvestigationRpcError =
  | DaemonNotRunningError
  | EnvironmentError
  | ProtocolMismatchError
  | UserInputError
  | UnsupportedCapabilityError
  | ChildProcessError
  | SessionConflictError
  | SessionNotFoundError
  | ArtifactNotFoundError

export interface InvestigationExecutorDeps {
  readonly nowIso: () => string
  readonly newInvestigationId: () => string

  /** Preflight: session reachable, resolves the session's live target description used in provenance. */
  readonly checkSessionReady: (sessionId: string) => Effect.Effect<{ readonly state: string }, InvestigationRpcError>

  /**
   * "At most one recorder exists per session" (AC): rejects with
   * `SessionConflictError` if another investigation already owns capture
   * for this session. Production wiring checks other persisted
   * investigation states for the same `sessionId` with status "running"
   * and a stage at or past "capture".
   */
  readonly reserveRecorder: (args: {
    readonly sessionId: string
    readonly investigationId: string
  }) => Effect.Effect<void, SessionConflictError>

  readonly releaseRecorder: (args: {
    readonly sessionId: string
    readonly investigationId: string
  }) => Effect.Effect<void>

  readonly runFlow: (args: {
    readonly sessionId: string
    readonly flow: SessionFlowContract
  }) => Effect.Effect<{ readonly verdict: string; readonly summary: string }, InvestigationRpcError>

  /**
   * Records one repetition of the measured flow under the declared capture
   * spec and returns the correlated `PerfEvidenceReport` (PRB-098's
   * `buildEvidenceReport`) plus the artifact key the raw trace was
   * registered under. Built-in templates fuse capture+flow via the
   * existing `perf.around` RPC (proven concurrent capture); a custom
   * template records via `perf.record` running concurrently with
   * `session.run` in the same host process -- see the production adapter's
   * header comment for why this is the deliberately looser of the two
   * lanes.
   */
  readonly captureRepetition: (args: {
    readonly sessionId: string
    readonly investigationId: string
    readonly repetitionIndex: number
    readonly capture: InvestigationCaptureSpec
    readonly measuredFlow: SessionFlowContract
    readonly recipeHash: string
  }) => Effect.Effect<
    { readonly evidenceReport: PerfEvidenceReport; readonly traceArtifactKey: string },
    InvestigationRpcError
  >

  readonly sleep: (ms: number) => Effect.Effect<void>
}
