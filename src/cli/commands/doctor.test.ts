import { describe, expect, test } from "bun:test"
import { Effect, Either } from "effect"
import { EnvironmentError } from "../../domain/errors"
import { AccessibilityService } from "../../services/AccessibilityService"
import { ArtifactStore } from "../../services/ArtifactStore"
import { CommerceService } from "../../services/CommerceService"
import { DaemonClient } from "../../services/DaemonClient"
import { ProbeKernel, workspaceDiagnosticsSessionId } from "../../services/ProbeKernel"
import { runDoctorCommand } from "./doctor"

// `runDoctorCommand` is one Effect.gen switching over every `doctor`
// subcommand, so TypeScript's inferred requirement type `R` covers every
// branch's dependencies regardless of which subcommand a given test
// exercises at runtime -- these never-used stand-ins satisfy the type,
// mirroring cli/commands/user-input.test.ts's `neverUsedX` pattern.
const unexpectedDaemonCall = () => {
  throw new Error("doctor accessibility|commerce test unexpectedly reached the daemon client")
}
const neverUsedDaemonClient = DaemonClient.of({
  ping: unexpectedDaemonCall,
  listSessions: unexpectedDaemonCall,
  openSession: unexpectedDaemonCall,
  runAction: unexpectedDaemonCall,
  runFlow: unexpectedDaemonCall,
  replaySession: unexpectedDaemonCall,
  exportRecording: unexpectedDaemonCall,
  getSessionHealth: unexpectedDaemonCall,
  getSessionResultSummary: unexpectedDaemonCall,
  getSessionResultAttachments: unexpectedDaemonCall,
  getSessionLogs: unexpectedDaemonCall,
  markSessionLog: unexpectedDaemonCall,
  captureSessionLogs: unexpectedDaemonCall,
  getSessionLogsDoctor: unexpectedDaemonCall,
  getSessionSnapshot: unexpectedDaemonCall,
  getSessionScreenshot: unexpectedDaemonCall,
  getSessionVideo: unexpectedDaemonCall,
  closeSession: unexpectedDaemonCall,
  recordPerf: unexpectedDaemonCall,
  recordPerfAroundFlow: unexpectedDaemonCall,
  summarizePerfBySignpost: unexpectedDaemonCall,
  exportPerfSchema: unexpectedDaemonCall,
  analyzePerfTrace: unexpectedDaemonCall,
  drillArtifact: unexpectedDaemonCall,
  captureDiagnosticBundle: unexpectedDaemonCall,
} as any)
const neverUsedProbeKernel = ProbeKernel.of({} as any)
const neverUsedAccessibilityService = AccessibilityService.of({} as any)
const neverUsedCommerceService = CommerceService.of({} as any)

// PRB-094 AC8 review finding (major): `doctor accessibility`/`doctor
// commerce` invoke `AccessibilityService`/`CommerceService` directly,
// in-process -- neither transits the daemon RPC socket, so neither passed
// through `ProbeKernel.ts`'s `handleRpcRequest` catch step that bounds an
// escaping error's `details` and links the complete diagnostic artifact.
// These exercise both subcommands' error paths end to end through the real
// CLI entry point to prove `boundDoctorError` (doctor.ts) closes that gap.
const makeArtifactWriter = () => {
  const persisted = new Map<string, string>()
  const sessionIdsUsed: Array<string> = []

  const artifactStore = ArtifactStore.of({
    writeDerivedOutput: ({ sessionId, label, content, summary }: {
      readonly sessionId: string
      readonly label: string
      readonly format: "json" | "text"
      readonly content: string
      readonly summary: string
    }) => {
      const key = `derived-${label}`
      persisted.set(key, content)
      sessionIdsUsed.push(sessionId)
      return Effect.succeed({
        key,
        label,
        kind: "json" as const,
        summary,
        absolutePath: `/tmp/probe/${sessionId}/${key}.json`,
        relativePath: null,
        external: false as const,
        createdAt: "2026-04-14T12:00:00.000Z",
      })
    },
  } as any)

  return { artifactStore, persisted, sessionIdsUsed }
}

describe("doctor accessibility error bounding (PRB-094 AC8 review fix)", () => {
  test("a 500-line EnvironmentError from AccessibilityService.doctor is bounded and links a diagnostic artifact", async () => {
    const { artifactStore, persisted } = makeArtifactWriter()
    const details = Array.from({ length: 500 }, (_, index) => `accessibility check ${index} failed: element not found`)

    const accessibility = AccessibilityService.of({
      doctor: () =>
        Effect.fail(
          new EnvironmentError({
            code: "accessibility-doctor-failed",
            reason: "Could not evaluate accessibility for the session.",
            nextStep: "Reopen the session and retry.",
            details,
          }),
        ),
    } as any)

    const outcome = await Effect.runPromise(
      Effect.either(
        runDoctorCommand(["accessibility", "--session-id", "session-1"]).pipe(
          Effect.provideService(AccessibilityService, accessibility),
          Effect.provideService(ArtifactStore, artifactStore),
          Effect.provideService(CommerceService, neverUsedCommerceService),
          Effect.provideService(DaemonClient, neverUsedDaemonClient),
          Effect.provideService(ProbeKernel, neverUsedProbeKernel),
        ),
      ),
    )

    expect(Either.isLeft(outcome)).toBe(true)

    if (!Either.isLeft(outcome)) {
      throw new Error("expected doctor accessibility to fail")
    }

    const error = outcome.left as EnvironmentError

    expect(error.code).toBe("accessibility-doctor-failed")
    expect(error.details.length).toBeLessThan(500)
    expect(error.details).toEqual(details.slice(0, error.details.length))
    expect(error.diagnosticArtifactKey).not.toBeNull()

    const persistedContent = persisted.get(error.diagnosticArtifactKey as string)
    expect(persistedContent).toBeDefined()
    expect(JSON.parse(persistedContent as string)).toEqual(details)
  })

  test("a small details array escapes doctor accessibility unchanged", async () => {
    const { artifactStore } = makeArtifactWriter()

    const accessibility = AccessibilityService.of({
      doctor: () =>
        Effect.fail(
          new EnvironmentError({
            code: "accessibility-doctor-failed",
            reason: "Could not evaluate accessibility for the session.",
            nextStep: "Reopen the session and retry.",
            details: ["element not found"],
          }),
        ),
    } as any)

    const outcome = await Effect.runPromise(
      Effect.either(
        runDoctorCommand(["accessibility", "--session-id", "session-1"]).pipe(
          Effect.provideService(AccessibilityService, accessibility),
          Effect.provideService(ArtifactStore, artifactStore),
          Effect.provideService(CommerceService, neverUsedCommerceService),
          Effect.provideService(DaemonClient, neverUsedDaemonClient),
          Effect.provideService(ProbeKernel, neverUsedProbeKernel),
        ),
      ),
    )

    expect(Either.isLeft(outcome)).toBe(true)

    if (Either.isLeft(outcome)) {
      const error = outcome.left as EnvironmentError
      expect(error.details).toEqual(["element not found"])
      expect(error.diagnosticArtifactKey ?? null).toBeNull()
    }
  })
})

describe("doctor commerce error bounding (PRB-094 AC8 review fix)", () => {
  test("a 500-line EnvironmentError from CommerceService.doctor is bounded and scoped under the workspace-diagnostics sentinel", async () => {
    const { artifactStore, persisted, sessionIdsUsed } = makeArtifactWriter()
    const details = Array.from({ length: 500 }, (_, index) => `commerce check ${index} failed: product not found`)

    const commerce = CommerceService.of({
      doctor: () =>
        Effect.fail(
          new EnvironmentError({
            code: "commerce-doctor-failed",
            reason: "Could not evaluate the commerce configuration.",
            nextStep: "Verify the bundle id and retry.",
            details,
          }),
        ),
    } as any)

    const outcome = await Effect.runPromise(
      Effect.either(
        runDoctorCommand(["commerce", "--bundle-id", "com.example.app"]).pipe(
          Effect.provideService(CommerceService, commerce),
          Effect.provideService(ArtifactStore, artifactStore),
          Effect.provideService(AccessibilityService, neverUsedAccessibilityService),
          Effect.provideService(DaemonClient, neverUsedDaemonClient),
          Effect.provideService(ProbeKernel, neverUsedProbeKernel),
        ),
      ),
    )

    expect(Either.isLeft(outcome)).toBe(true)

    if (!Either.isLeft(outcome)) {
      throw new Error("expected doctor commerce to fail")
    }

    const error = outcome.left as EnvironmentError

    expect(error.details.length).toBeLessThan(500)
    expect(error.diagnosticArtifactKey).not.toBeNull()

    // `doctor commerce` has no sessionId (bundle-scoped, not session-scoped)
    // -- it falls back to the same well-known sentinel `getWorkspaceStatus`
    // uses instead of inventing a second one.
    const persistedContent = persisted.get(error.diagnosticArtifactKey as string)
    expect(persistedContent).toBeDefined()
    expect(JSON.parse(persistedContent as string)).toEqual(details)
    expect(sessionIdsUsed).toEqual([workspaceDiagnosticsSessionId])
  })
})
