import { describe, expect, test } from "bun:test"
import { Effect, Either } from "effect"
import { EnvironmentError } from "../../domain/errors"
import { AccessibilityService } from "../../services/AccessibilityService"
import { ArtifactStore } from "../../services/ArtifactStore"
import { CommerceService } from "../../services/CommerceService"
import { runValidateCommand } from "./validate"

// PRB-094 AC8 review finding (major): `validate accessibility`/`validate
// commerce` invoke `AccessibilityService`/`CommerceService` directly,
// in-process -- neither transits the daemon RPC socket, so neither passed
// through `ProbeKernel.ts`'s `handleRpcRequest` catch step that bounds an
// escaping error's `details` and links the complete diagnostic artifact.
// These exercise both subcommands' error paths end to end through the real
// CLI entry point to prove `boundValidateError` (validate.ts) closes that
// gap. Both subcommands always carry a real `sessionId`, unlike `doctor
// commerce`, so the persisted artifact is scoped to it directly.
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

const neverUsedAccessibilityService = AccessibilityService.of({} as any)
const neverUsedCommerceService = CommerceService.of({} as any)

describe("validate accessibility error bounding (PRB-094 AC8 review fix)", () => {
  test("a 500-line EnvironmentError from AccessibilityService.validate is bounded and links a diagnostic artifact scoped to the session", async () => {
    const { artifactStore, persisted, sessionIdsUsed } = makeArtifactWriter()
    const details = Array.from({ length: 500 }, (_, index) => `accessibility issue ${index}: element not reachable`)

    const accessibility = AccessibilityService.of({
      validate: () =>
        Effect.fail(
          new EnvironmentError({
            code: "accessibility-validate-failed",
            reason: "Could not validate accessibility for the session.",
            nextStep: "Reopen the session and retry.",
            details,
          }),
        ),
    } as any)

    const outcome = await Effect.runPromise(
      Effect.either(
        runValidateCommand(["accessibility", "--session-id", "session-1"]).pipe(
          Effect.provideService(AccessibilityService, accessibility),
          Effect.provideService(ArtifactStore, artifactStore),
          Effect.provideService(CommerceService, neverUsedCommerceService),
        ),
      ),
    )

    expect(Either.isLeft(outcome)).toBe(true)

    if (!Either.isLeft(outcome)) {
      throw new Error("expected validate accessibility to fail")
    }

    const error = outcome.left as EnvironmentError

    expect(error.code).toBe("accessibility-validate-failed")
    expect(error.details.length).toBeLessThan(500)
    expect(error.details).toEqual(details.slice(0, error.details.length))
    expect(error.diagnosticArtifactKey).not.toBeNull()
    expect(sessionIdsUsed).toEqual(["session-1"])

    const persistedContent = persisted.get(error.diagnosticArtifactKey as string)
    expect(persistedContent).toBeDefined()
    expect(JSON.parse(persistedContent as string)).toEqual(details)
  })

  test("a small details array escapes validate accessibility unchanged", async () => {
    const { artifactStore } = makeArtifactWriter()

    const accessibility = AccessibilityService.of({
      validate: () =>
        Effect.fail(
          new EnvironmentError({
            code: "accessibility-validate-failed",
            reason: "Could not validate accessibility for the session.",
            nextStep: "Reopen the session and retry.",
            details: ["element not reachable"],
          }),
        ),
    } as any)

    const outcome = await Effect.runPromise(
      Effect.either(
        runValidateCommand(["accessibility", "--session-id", "session-1"]).pipe(
          Effect.provideService(AccessibilityService, accessibility),
          Effect.provideService(ArtifactStore, artifactStore),
          Effect.provideService(CommerceService, neverUsedCommerceService),
        ),
      ),
    )

    expect(Either.isLeft(outcome)).toBe(true)

    if (Either.isLeft(outcome)) {
      const error = outcome.left as EnvironmentError
      expect(error.details).toEqual(["element not reachable"])
      expect(error.diagnosticArtifactKey ?? null).toBeNull()
    }
  })
})

describe("validate commerce error bounding (PRB-094 AC8 review fix)", () => {
  test("a 500-line EnvironmentError from CommerceService.validate is bounded and links a diagnostic artifact scoped to the session", async () => {
    const { artifactStore, persisted, sessionIdsUsed } = makeArtifactWriter()
    const details = Array.from({ length: 500 }, (_, index) => `commerce step ${index} failed: product not found`)

    const commerce = CommerceService.of({
      validate: () =>
        Effect.fail(
          new EnvironmentError({
            code: "commerce-validate-failed",
            reason: "Could not validate the commerce plan.",
            nextStep: "Verify the plan and retry.",
            details,
          }),
        ),
    } as any)

    const outcome = await Effect.runPromise(
      Effect.either(
        // "sandbox" mode needs no commerce plan file, so this reaches
        // `commerce.validate` directly instead of failing earlier on a
        // missing --plan read.
        runValidateCommand(["commerce", "--session-id", "session-1", "--mode", "sandbox"]).pipe(
          Effect.provideService(CommerceService, commerce),
          Effect.provideService(ArtifactStore, artifactStore),
          Effect.provideService(AccessibilityService, neverUsedAccessibilityService),
        ),
      ),
    )

    expect(Either.isLeft(outcome)).toBe(true)

    if (!Either.isLeft(outcome)) {
      throw new Error("expected validate commerce to fail")
    }

    const error = outcome.left as EnvironmentError

    expect(error.code).toBe("commerce-validate-failed")
    expect(error.details.length).toBeLessThan(500)
    expect(error.details).toEqual(details.slice(0, error.details.length))
    expect(error.diagnosticArtifactKey).not.toBeNull()
    expect(sessionIdsUsed).toEqual(["session-1"])

    const persistedContent = persisted.get(error.diagnosticArtifactKey as string)
    expect(persistedContent).toBeDefined()
    expect(JSON.parse(persistedContent as string)).toEqual(details)
  })
})
