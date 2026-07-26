import { Effect } from "effect"
import type { RecordedSessionAction, RetryPolicy, RetryReasonCode, SessionActionResult } from "../domain/action"
import { ChildProcessError, EnvironmentError, SessionNotFoundError, UnsupportedCapabilityError, UserInputError } from "../domain/errors"
import type { EvidenceReport } from "../domain/evidence"
import type { SessionConnectionDetails, SessionHealth } from "../domain/session"
import type { StoredSnapshotArtifact } from "../domain/snapshot"
import type { LldbBridgeHandle } from "./LldbBridge"
import type { RunnerAction } from "./runnerProtocol"
import type { SessionController } from "./SessionController"
import type { RunnerCommandResult } from "./SimulatorHarness"

/**
 * PRB-102: shared pure session-action utilities and the `ActiveSessionRecord`
 * type family, extracted out of `SessionRegistry.ts`.
 *
 * Before this module, `SessionRegistry.ts` and `src/services/flow/*` imported
 * from each other in both directions: `SessionRegistry.ts` imported the
 * `flow/*` executors to implement `runFlow`, while several `flow/*` executors
 * imported pure helpers (`dedupeStrings`, `attemptWithRetry`,
 * `isRunnerBackedRecord`, ...) and the `ActiveSessionRecord` type family
 * directly back out of `SessionRegistry.ts`. That is a real circular module
 * dependency, not just a stylistic smell — it made the executors impossible
 * to unit-test or reason about without pulling in `SessionRegistry.ts`'s
 * entire module graph.
 *
 * This module has zero dependency on `SessionRegistry.ts` or anything under
 * `./flow/`: only `./SessionController`, `./SimulatorHarness`,
 * `./runnerProtocol`, `./LldbBridge`, and `../domain/*`. `SessionRegistry.ts`
 * and every `flow/*` executor import from here instead of from each other.
 */

// PRB-073 (originally): this warning's contract is shared by both
// SessionRegistry.ts's own replay/warning builders and the flow executors'
// selector-drift diagnostics — see selectorDriftContractWarning's call sites
// in both places.
export const selectorDriftContractWarning = "Selector drift recovery only helps while the semantic fallback stays unique on the runner; duplicate weak targets still need stronger accessibility identifiers or labels."

export const dedupeStrings = (values: ReadonlyArray<string>): Array<string> => [...new Set(values)]

const isHittabilityFailure = (reason: string): boolean => /\bhittable\b|\boffscreen\b/i.test(reason)

export const withOffscreenNextStep = (base: string, reason: string): string =>
  isHittabilityFailure(reason)
    ? `${base} The runner already tried bounded auto-scroll until hittable; if this still fails, capture a snapshot to confirm the identifier exists and is not covered/disabled, or use an explicit scroll step on a scrollView/list.`
    : base

export const defaultReadOnlyRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: 250,
  refreshSnapshotBetweenAttempts: true,
  retryOn: ["not-found", "not-hittable", "runner-timeout", "transient-transport", "assertion-failed"],
}

export const defaultMutationRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: 250,
  refreshSnapshotBetweenAttempts: true,
  retryOn: ["not-found", "not-hittable"],
}

export type SessionActionError =
  | SessionNotFoundError
  | UserInputError
  | UnsupportedCapabilityError
  | EnvironmentError
  | ChildProcessError

export interface RetryAttemptMetadata {
  readonly retryCount: number
  readonly retryReasons: Array<string>
}

export type ExtendedSessionActionResult = SessionActionResult & {
  // Timing fields are first-class on SessionActionResult now; keep this
  // alias for call sites that already import ExtendedSessionActionResult.
}

export type ActionExecutionOutcome =
  | {
      readonly ok: true
      readonly result: ExtendedSessionActionResult
    }
  | {
      readonly ok: false
      readonly error: SessionActionError
      readonly retry: RetryAttemptMetadata
      // PRB-093: every outcome reports its evidence, failure included -- a
      // best-effort failure snapshot is real capture work and must not be
      // silently discarded just because the mutation itself failed. See
      // evidence.ts's module doc: failure evidence never replaces or masks
      // the original failure, it only rides alongside it.
      readonly evidence: EvidenceReport
    }

export const emptyRetryAttemptMetadata = (): RetryAttemptMetadata => ({
  retryCount: 0,
  retryReasons: [],
})

const classifyRetryableFailure = (error: SessionActionError): { readonly code: RetryReasonCode; readonly reason: string } | null => {
  if (error instanceof EnvironmentError) {
    switch (error.code) {
      case "session-action-target-not-found":
        return { code: "not-found", reason: error.reason }
      case "session-assert-failed":
        return { code: "assertion-failed", reason: error.reason }
      case "session-action-failed":
        return {
          code: isHittabilityFailure(error.reason) ? "not-hittable" : "transient-transport",
          reason: error.reason,
        }
      case "session-snapshot-failed":
      case "session-snapshot-payload-missing":
      case "session-snapshot-read":
      case "session-snapshot-parse":
      case "session-snapshot-write":
      case "session-screenshot-failed":
      case "session-screenshot-payload-missing":
      case "session-screenshot-artifact-write":
        return {
          code: /timeout/i.test(error.reason) ? "runner-timeout" : "transient-transport",
          reason: error.reason,
        }
      default:
        if (error.code.startsWith("session-runner-")) {
          return {
            code: /timeout/i.test(error.reason) ? "runner-timeout" : "transient-transport",
            reason: error.reason,
          }
        }

        return null
    }
  }

  if (error instanceof ChildProcessError) {
    return {
      code: /timeout/i.test(error.reason) ? "runner-timeout" : "transient-transport",
      reason: error.reason,
    }
  }

  return null
}

export const attemptWithRetry = <T, E extends SessionActionError>(args: {
  readonly policy: RetryPolicy
  readonly run: () => Effect.Effect<T, E>
}) =>
  Effect.gen(function* () {
    const retryReasons: Array<string> = []
    let attempt = 0

    while (true) {
      attempt += 1
      const result = (yield* Effect.either(args.run())) as { _tag: "Right"; right: T } | { _tag: "Left"; left: E }

      if (result._tag === "Right") {
        return {
          ok: true as const,
          value: result.right,
          retry: {
            retryCount: attempt - 1,
            retryReasons,
          },
        }
      }

      const retryable = classifyRetryableFailure(result.left)
      const shouldRetry = retryable !== null
        && args.policy.retryOn.includes(retryable.code)
        && attempt < args.policy.maxAttempts

      if (!shouldRetry) {
        return {
          ok: false as const,
          error: result.left,
          retry: {
            retryCount: attempt - 1,
            retryReasons,
          },
        }
      }

      retryReasons.push(`${retryable.code}: ${retryable.reason}`)

      if (args.policy.backoffMs > 0) {
        yield* Effect.sleep(args.policy.backoffMs)
      }
    }
  })

// PRB-073: hoisted alongside the retry/outcome helpers above -- pure, no
// layer-scoped dependency.
export const buildActionResultMetadata = (
  retry: RetryAttemptMetadata,
  verdict: SessionActionResult["verdict"] = null,
  waitedMs: number | null = null,
  polledCount: number | null = null,
) => ({
  retryCount: retry.retryCount,
  retryReasons: retry.retryReasons,
  verdict,
  waitedMs,
  polledCount,
})

// PRB-073: exported so the flow executors (src/services/flow/*) can type
// their evidence-capture deps without re-declaring the mode union.
export type VideoArtifactMode = "mp4" | "mov" | "frame-sequence"

export const describeVideoArtifactLabel = (mode: VideoArtifactMode, options?: { readonly includeArtifact?: boolean }): string => {
  const suffix = options?.includeArtifact === false ? "" : " artifact"

  switch (mode) {
    case "mp4":
      return `MP4 video${suffix}`
    case "mov":
      return `QuickTime video${suffix}`
    case "frame-sequence":
      return `frame-sequence video${suffix}`
  }
}

export const sanitizeFileComponent = (value: string | null | undefined, fallback: string): string => {
  const sanitized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return sanitized.length > 0 ? sanitized : fallback
}

export const timestampForFile = (): string => new Date().toISOString().replace(/[:.]/g, "-")

export interface BaseActiveSessionRecord {
  kind: "simulator" | "device"
  health: SessionHealth
  baseWarnings: ReadonlyArray<string>
  debuggerBridge: LldbBridgeHandle | null
  snapshotState: {
    latest: StoredSnapshotArtifact | null
    nextSnapshotIndex: number
    nextElementRefIndex: number
  }
  recording: {
    steps: Array<RecordedSessionAction>
  }
  // PRB-083: the controller is the sole writer of `health` (reassigned as a
  // whole object, never mutated in place) and the sole allocator of runner
  // command sequence numbers. Every other field above stays a plain mutable
  // property because nothing outside the controller's serialized execution
  // ever writes it concurrently; see SessionController.ts for the invariant
  // this buys.
  readonly controller: SessionController
}

export interface SimulatorActiveSessionRecord extends BaseActiveSessionRecord {
  kind: "simulator"
  readonly sendRunnerCommand: (
    sequence: number,
    action: RunnerAction,
    payload?: string,
  ) => Promise<RunnerCommandResult>
  /** PRB-089: this runner process's epoch, for indeterminate-outcome diagnostics. */
  readonly runnerEpoch: string
  readonly closeResources: () => Promise<void>
  readonly isRunnerRunning: () => boolean
  readonly waitForExit: Promise<{ readonly code: number | null; readonly signal: string | null }>
}

export interface RealDeviceActiveSessionRecord extends BaseActiveSessionRecord {
  kind: "device"
  integrationPoints: ReadonlyArray<string>
  readonly sendRunnerCommand: ((
    sequence: number,
    action: RunnerAction,
    payload?: string,
  ) => Promise<RunnerCommandResult>) | null
  /** PRB-089: this runner process's epoch, for indeterminate-outcome diagnostics. Null until a live runner has opened. */
  readonly runnerEpoch: string | null
  readonly refreshConnection: () => Promise<SessionConnectionDetails>
  readonly closeResources: () => Promise<void>
  readonly isRunnerRunning: () => boolean
  readonly waitForExit: Promise<{ readonly code: number | null; readonly signal: string | null }> | null
}

export type ActiveSessionRecord = SimulatorActiveSessionRecord | RealDeviceActiveSessionRecord
export type RunnerBackedActiveSessionRecord = SimulatorActiveSessionRecord | (RealDeviceActiveSessionRecord & {
  readonly sendRunnerCommand: NonNullable<RealDeviceActiveSessionRecord["sendRunnerCommand"]>
  readonly waitForExit: NonNullable<RealDeviceActiveSessionRecord["waitForExit"]>
})

export const isSimulatorRecord = (record: ActiveSessionRecord): record is SimulatorActiveSessionRecord =>
  record.kind === "simulator"

export const isRunnerBackedRecord = (record: ActiveSessionRecord): record is RunnerBackedActiveSessionRecord =>
  isSimulatorRecord(record) || record.sendRunnerCommand !== null
