import { readFile } from "node:fs/promises"
import { Context, Effect, Layer } from "effect"
import {
  buildAccessibilityDoctorReport,
  buildAccessibilityValidationReport,
  evaluateAccessibilitySnapshot,
  type AccessibilityDoctorCheck,
  type AccessibilityDoctorReport,
  type AccessibilityScope,
  type AccessibilityValidationReport,
} from "../domain/accessibility"
import {
  ArtifactNotFoundError,
  ChildProcessError,
  DaemonNotRunningError,
  EnvironmentError,
  ProtocolMismatchError,
  SessionConflictError,
  SessionNotFoundError,
  UnsupportedCapabilityError,
  UserInputError,
  formatProbeError,
  isProbeError,
} from "../domain/errors"
import { isLiveRunnerTransport, type SessionHealth } from "../domain/session"
import { decodeStoredSnapshotArtifact, type StoredSnapshotArtifact } from "../domain/snapshot"
import { ArtifactStore } from "./ArtifactStore"
import { DaemonClient } from "./DaemonClient"

const formatThrownError = (error: unknown): string =>
  isProbeError(error)
    ? formatProbeError(error)
    : error instanceof Error
      ? error.message
      : String(error)

const makeCheck = (args: {
  readonly key: string
  readonly verdict: AccessibilityDoctorCheck["verdict"]
  readonly summary: string
  readonly details?: ReadonlyArray<string>
}): AccessibilityDoctorCheck => ({
  key: args.key,
  verdict: args.verdict,
  summary: args.summary,
  details: [...(args.details ?? [])],
})

const readStoredSnapshotArtifact = (absolutePath: string) =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(absolutePath, "utf8"),
      catch: (error) =>
        new EnvironmentError({
          code: "accessibility-snapshot-read",
          reason: error instanceof Error ? error.message : String(error),
          nextStep: "Inspect the snapshot artifact path and retry accessibility validation.",
          details: [],
        }),
    })

    return yield* Effect.try({
      try: () => decodeStoredSnapshotArtifact(JSON.parse(raw) as unknown),
      catch: (error) =>
        new EnvironmentError({
          code: "accessibility-snapshot-parse",
          reason: error instanceof Error ? error.message : String(error),
          nextStep: "Inspect the snapshot artifact JSON and align the host snapshot decoder before retrying accessibility validation.",
          details: [],
        }),
    })
  })

const buildLiveRunnerCheck = (session: SessionHealth): AccessibilityDoctorCheck => {
  if (!isLiveRunnerTransport(session.transport)) {
    return makeCheck({
      key: "session.live-runner",
      verdict: "blocked",
      summary: "This session does not currently expose a live runner-backed accessibility surface.",
      details: [session.transport.note],
    })
  }

  if (session.coordination.runnerActionsBlocked || session.resources.runner !== "ready") {
    return makeCheck({
      key: "session.live-runner",
      verdict: "blocked",
      summary: "Runner-backed accessibility actions are currently blocked for this session.",
      details: [session.coordination.reason ?? "The session runner is not in a ready state."],
    })
  }

  return makeCheck({
    key: "session.live-runner",
    verdict: "verified",
    summary: "This session exposes a live runner-backed accessibility surface.",
    details: [
      `${session.target.deviceName} (${session.target.platform})`,
      `transport: ${session.transport.commandIngress} / ${session.transport.eventEgress}`,
    ],
  })
}

const buildSnapshotIdentityCheck = (snapshot: StoredSnapshotArtifact): AccessibilityDoctorCheck => {
  const weakIdentityCount = snapshot.metrics.weakIdentityNodeCount
  const remappedCount = snapshot.metrics.remappedRefCount

  if (weakIdentityCount === 0 && remappedCount === 0) {
    return makeCheck({
      key: "snapshot.identity-stability",
      verdict: "verified",
      summary: "The current accessibility snapshot has strong stable identity coverage for interactive validation.",
      details: [`interactive nodes: ${snapshot.metrics.interactiveNodeCount}`],
    })
  }

  return makeCheck({
    key: "snapshot.identity-stability",
    verdict: "configured",
    summary: "The current accessibility snapshot is usable, but some nodes still rely on weak identity matching.",
    details: [
      `weak identity nodes: ${weakIdentityCount}`,
      `weak remaps: ${remappedCount}`,
      ...snapshot.warnings.slice(0, 2),
    ],
  })
}

const buildInteractiveSurfaceCheck = (snapshot: StoredSnapshotArtifact): AccessibilityDoctorCheck =>
  snapshot.metrics.interactiveNodeCount > 0
    ? makeCheck({
        key: "snapshot.interactive-surface",
        verdict: "verified",
        summary: "The current accessibility snapshot exposes interactive elements for validation.",
        details: [`interactive nodes: ${snapshot.metrics.interactiveNodeCount}`],
      })
    : makeCheck({
        key: "snapshot.interactive-surface",
        verdict: "unknown",
        summary: "The current accessibility snapshot did not expose any interactive elements.",
        details: ["Open the target screen first, then rerun accessibility validation if you expected tappable controls."],
      })

export type AccessibilityServiceError =
  | ArtifactNotFoundError
  | ChildProcessError
  | DaemonNotRunningError
  | EnvironmentError
  | ProtocolMismatchError
  | SessionConflictError
  | SessionNotFoundError
  | UnsupportedCapabilityError
  | UserInputError

export class AccessibilityService extends Context.Tag("@probe/AccessibilityService")<
  AccessibilityService,
  {
    readonly doctor: (params: {
      readonly sessionId: string
    }) => Effect.Effect<AccessibilityDoctorReport, AccessibilityServiceError>
    readonly validate: (params: {
      readonly sessionId: string
      readonly scope?: AccessibilityScope | null
    }) => Effect.Effect<AccessibilityValidationReport, AccessibilityServiceError>
  }
>() {}

export const AccessibilityServiceLive = Layer.effect(
  AccessibilityService,
  Effect.gen(function* () {
    const artifactStore = yield* ArtifactStore
    const daemonClient = yield* DaemonClient

    return AccessibilityService.of({
      doctor: ({ sessionId }) =>
        Effect.gen(function* () {
          const session = yield* daemonClient.getSessionHealth({ sessionId })
          const warnings = [...session.warnings]
          const checks: Array<AccessibilityDoctorCheck> = [buildLiveRunnerCheck(session)]

          let snapshotArtifact: AccessibilityDoctorReport["snapshotArtifact"] = null
          let screenshotArtifact: AccessibilityDoctorReport["screenshotArtifact"] = null
          let parsedSnapshot: StoredSnapshotArtifact | null = null

          const snapshotAttempt = yield* Effect.either(daemonClient.captureSnapshot({
            sessionId,
            outputMode: "artifact",
          }))

          if (snapshotAttempt._tag === "Left") {
            checks.push(makeCheck({
              key: "session.snapshot-capture",
              verdict: "blocked",
              summary: "Probe could not capture a live accessibility snapshot for this session.",
              details: [formatThrownError(snapshotAttempt.left)],
            }))
          } else {
            snapshotArtifact = snapshotAttempt.right.artifact
            checks.push(makeCheck({
              key: "session.snapshot-capture",
              verdict: "verified",
              summary: "Probe captured a live accessibility snapshot for this session.",
              details: [snapshotAttempt.right.artifact.absolutePath],
            }))

            const parsedAttempt = yield* Effect.either(readStoredSnapshotArtifact(snapshotAttempt.right.artifact.absolutePath))

            if (parsedAttempt._tag === "Left") {
              checks.push(makeCheck({
                key: "snapshot.decode",
                verdict: "blocked",
                summary: "Probe captured the snapshot artifact, but could not decode it back into the host-side accessibility model.",
                details: [formatThrownError(parsedAttempt.left)],
              }))
            } else {
              parsedSnapshot = parsedAttempt.right
              checks.push(buildSnapshotIdentityCheck(parsedAttempt.right))
              checks.push(buildInteractiveSurfaceCheck(parsedAttempt.right))
            }
          }

          const screenshotAttempt = yield* Effect.either(daemonClient.captureScreenshot({
            sessionId,
            label: "accessibility-doctor",
            outputMode: "artifact",
          }))

          if (screenshotAttempt._tag === "Left") {
            checks.push(makeCheck({
              key: "session.screenshot-capture",
              verdict: "blocked",
              summary: "Probe could not capture a screenshot for this session.",
              details: [formatThrownError(screenshotAttempt.left)],
            }))
          } else {
            screenshotArtifact = screenshotAttempt.right.artifact
            checks.push(makeCheck({
              key: "session.screenshot-capture",
              verdict: "verified",
              summary: "Probe captured a screenshot artifact for accessibility evidence collection.",
              details: [screenshotAttempt.right.artifact.absolutePath],
            }))
          }

          if (parsedSnapshot !== null) {
            warnings.push(...parsedSnapshot.warnings)
          }

          const report = buildAccessibilityDoctorReport({
            sessionId,
            checks,
            warnings,
            snapshotArtifact,
            screenshotArtifact,
          })

          return {
            ...report,
            summary: `${report.summary} Overall verdict: ${report.verdict}.`,
          }
        }),

      validate: ({ sessionId, scope }) =>
        Effect.gen(function* () {
          const normalizedScope = scope ?? "current-screen"
          const snapshotResult = yield* daemonClient.captureSnapshot({
            sessionId,
            outputMode: "artifact",
          })
          const snapshot = yield* readStoredSnapshotArtifact(snapshotResult.artifact.absolutePath)
          const screenshotResult = yield* daemonClient.captureScreenshot({
            sessionId,
            label: "accessibility-validate",
            outputMode: "artifact",
          })
          const analysis = evaluateAccessibilitySnapshot({
            snapshot,
            scope: normalizedScope,
          })
          const warnings = [...snapshot.warnings, ...analysis.warnings]

          const reportWithoutArtifact = buildAccessibilityValidationReport({
            sessionId,
            scope: normalizedScope,
            analyzedElementCount: analysis.analyzedElementCount,
            issues: analysis.issues,
            warnings,
            evidence: {
              snapshotId: snapshot.snapshotId,
              snapshotArtifact: snapshotResult.artifact,
              screenshotArtifact: screenshotResult.artifact,
              reportArtifact: null,
            },
          })

          const reportArtifact = yield* artifactStore.writeDerivedOutput({
            sessionId,
            label: "accessibility-report",
            format: "json",
            content: `${JSON.stringify(reportWithoutArtifact, null, 2)}\n`,
            summary: `Accessibility validation report (${normalizedScope})`,
          })

          const finalReport = buildAccessibilityValidationReport({
            sessionId,
            scope: normalizedScope,
            analyzedElementCount: analysis.analyzedElementCount,
            issues: analysis.issues,
            warnings,
            evidence: {
              snapshotId: snapshot.snapshotId,
              snapshotArtifact: snapshotResult.artifact,
              screenshotArtifact: screenshotResult.artifact,
              reportArtifact,
            },
          })

          return {
            ...finalReport,
            summary: `${finalReport.summary} Overall verdict: ${finalReport.verdict}.`,
          }
        }),
    })
  }),
)
