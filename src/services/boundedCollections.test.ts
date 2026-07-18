import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { defaultCollectionDrillPageSize } from "../domain/bounded"
import { ArtifactNotFoundError, EnvironmentError, UserInputError } from "../domain/errors"
import type { ArtifactRecord } from "../domain/output"
import { countLines } from "../domain/output"
import {
  bindBoundedCollection,
  bindDetailBearingErrorForWire,
  bindDetailsForWire,
  bindEscapingErrorForWire,
  bindErrorDetailsForWire,
  isDetailBearingProbeError,
  type BoundedCollectionArtifactWriter,
} from "./boundedCollections"

const makeArtifact = (key: string): ArtifactRecord => ({
  key,
  label: key,
  kind: "json",
  summary: "overflow",
  absolutePath: `/tmp/probe/${key}.json`,
  relativePath: null,
  external: false,
  createdAt: "2026-04-14T00:00:00.000Z",
})

describe("bindBoundedCollection", () => {
  test("inlines everything and never calls the artifact writer when the collection already fits the limit", async () => {
    let writeCalls = 0
    const writer: BoundedCollectionArtifactWriter = {
      writeDerivedOutput: () => {
        writeCalls += 1
        return Effect.die("writeDerivedOutput should not be called when nothing overflows")
      },
    }

    const result = await Effect.runPromise(
      bindBoundedCollection(writer, {
        sessionId: "session-1",
        collectionLabel: "widgets",
        items: ["a", "b", "c"],
        shownLimit: 10,
      }),
    )

    expect(result).toEqual({ total: 3, shown: ["a", "b", "c"], omitted: 0, drill: null })
    expect(writeCalls).toBe(0)
  })

  test("persists the full collection atomically and returns a typed drill handle when it overflows", async () => {
    let persistedContent: string | null = null
    const writer: BoundedCollectionArtifactWriter = {
      writeDerivedOutput: (args) => {
        persistedContent = args.content
        return Effect.succeed(makeArtifact("widgets-overflow"))
      },
    }

    const items = Array.from({ length: 10_000 }, (_, index) => `widget-${index}`)
    const result = await Effect.runPromise(
      bindBoundedCollection(writer, {
        sessionId: "session-1",
        collectionLabel: "widgets",
        items,
        shownLimit: 5,
      }),
    )

    expect(result.total).toBe(10_000)
    expect(result.shown).toEqual(items.slice(0, 5))
    expect(result.omitted).toBe(9_995)
    expect(result.drill).toEqual({
      contractVersion: 1,
      sessionId: "session-1",
      artifactKey: "widgets-overflow",
      query: { kind: "collection", offset: 0, limit: defaultCollectionDrillPageSize },
    })

    // AC4: the full detail was persisted (every item, not just the shown
    // preview) before the summary above ever claimed the handle.
    expect(persistedContent).not.toBeNull()
    const persisted = JSON.parse(persistedContent as unknown as string) as Array<string>
    expect(persisted).toHaveLength(10_000)
    expect(persisted).toEqual(items)
  })

  test("propagates the artifact writer's typed failure instead of silently clipping the overflow", async () => {
    const writer: BoundedCollectionArtifactWriter = {
      writeDerivedOutput: () =>
        Effect.fail(
          new EnvironmentError({
            code: "artifact-write-failed",
            reason: "disk full",
            nextStep: "Free disk space and retry.",
            details: [],
          }),
        ),
    }

    const items = Array.from({ length: 50 }, (_, index) => index)
    const exit = await Effect.runPromiseExit(
      bindBoundedCollection(writer, {
        sessionId: "session-1",
        collectionLabel: "widgets",
        items,
        shownLimit: 5,
      }),
    )

    expect(exit._tag).toBe("Failure")

    if (exit._tag === "Failure") {
      const failure = exit.cause._tag === "Fail" ? exit.cause.error : null
      expect(failure).toBeInstanceOf(EnvironmentError)
      expect((failure as EnvironmentError).code).toBe("artifact-write-failed")
    }
  })
})

// PRB-094 review finding: DiagnosticReport.details/KnownWall.details
// (domain/diagnostics.ts) stayed unbounded -- no high-diagnosis fixture was
// built to prove a diagnostic backed by a huge `details` array (e.g. a
// stale-session recovery report from a long-running host, or a `known
// walls` entry with many detail lines) stays within the generic budget once
// bound. This mirrors `bindBoundedCollection`'s own 10k-item test above,
// against `bindDetailsForWire`'s wrapping of it for keyed
// `{ key, details }` reports.
describe("bindDetailsForWire", () => {
  const maxInlineBytes = 4 * 1024
  const maxInlineLines = 100

  test("passes a small details array through unbounded, with no artifact write", async () => {
    let writeCalls = 0
    const writer: BoundedCollectionArtifactWriter = {
      writeDerivedOutput: () => {
        writeCalls += 1
        return Effect.die("writeDerivedOutput should not be called when details already fit the limit")
      },
    }

    const result = await Effect.runPromise(
      bindDetailsForWire(writer, {
        sessionId: "workspace-diagnostics",
        shownLimit: 10,
        report: { key: "host.xcode", status: "ready" as const, summary: "Xcode is ready.", details: ["line one", "line two"] },
      }),
    )

    expect(result.details).toEqual({ total: 2, shown: ["line one", "line two"], omitted: 0, drill: null })
    expect(result.key).toBe("host.xcode")
    expect(result.status).toBe("ready")
    expect(writeCalls).toBe(0)
  })

  test("AC6: a high-diagnosis fixture (10k detail lines) stays within the generic 4 KiB / 100 line budget", async () => {
    let persistedContent: string | null = null
    const writer: BoundedCollectionArtifactWriter = {
      writeDerivedOutput: (args) => {
        persistedContent = args.content
        return Effect.succeed(makeArtifact("diagnostic-session.recovery-details-overflow"))
      },
    }

    const details = Array.from(
      { length: 10_000 },
      (_, index) => `session-${index} (closed): recovered stale session artifact during daemon startup.`,
    )

    const bound = await Effect.runPromise(
      bindDetailsForWire(writer, {
        sessionId: "workspace-diagnostics",
        shownLimit: 10,
        report: {
          key: "session.recovery",
          status: "degraded" as const,
          summary: "Found 10000 stale persisted session artifact(s) from previous daemon lifecycles.",
          details,
        },
      }),
    )

    // The bound diagnostic itself, serialized exactly as it would be inside
    // `WorkspaceStatus.diagnostics`, stays within budget with 10k detail
    // lines behind it.
    const serialized = JSON.stringify(bound)
    const bytes = Buffer.byteLength(serialized, "utf8")
    const lines = countLines(serialized)

    expect(bytes).toBeLessThanOrEqual(maxInlineBytes)
    expect(lines).toBeLessThanOrEqual(maxInlineLines)

    expect(bound.details.total).toBe(10_000)
    expect(bound.details.shown).toEqual(details.slice(0, 10))
    expect(bound.details.omitted).toBe(9_990)
    expect(bound.details.drill).not.toBeNull()
    expect(bound.details.drill?.sessionId).toBe("workspace-diagnostics")

    // AC4: the full detail set was persisted atomically before the bounded
    // summary above could claim the handle.
    expect(persistedContent).not.toBeNull()
    const persisted = JSON.parse(persistedContent as unknown as string) as Array<string>
    expect(persisted).toHaveLength(10_000)
    expect(persisted).toEqual(details)
  })
})

// PRB-094 AC8 review finding: "errors bound excerpts and link the complete
// diagnostic artifact" was entirely unimplemented -- no code bounded a
// command/error's excerpt or linked a complete diagnostic artifact for an
// over-large error. `bindErrorDetailsForWire` is the fix: the error-shaped
// analogue of `bindBoundedCollection`, wired into `ProbeKernel.ts`'s
// `handleRpcRequest` (see `boundEscapingErrorDetails`) so any escaping
// error's `details` gets the same bound-or-link treatment normal results
// already get.
describe("bindErrorDetailsForWire", () => {
  test("passes small details through unchanged, with no artifact write", async () => {
    let writeCalls = 0
    const writer: BoundedCollectionArtifactWriter = {
      writeDerivedOutput: () => {
        writeCalls += 1
        return Effect.die("writeDerivedOutput should not be called when details already fit the limit")
      },
    }

    const result = await Effect.runPromise(
      bindErrorDetailsForWire(writer, {
        sessionId: "session-1",
        errorCode: "session-runner-ping",
        details: ["line one", "line two"],
        shownLimit: 20,
      }),
    )

    expect(result).toEqual({ details: ["line one", "line two"], diagnosticArtifactKey: null })
    expect(writeCalls).toBe(0)
  })

  test("bounds the excerpt and links the complete diagnostic artifact once details overflow", async () => {
    let persistedContent: string | null = null
    const writer: BoundedCollectionArtifactWriter = {
      writeDerivedOutput: (args) => {
        persistedContent = args.content
        return Effect.succeed(makeArtifact("error-session-runner-ping-details-overflow"))
      },
    }

    const details = Array.from({ length: 500 }, (_, index) => `stderr line ${index}: something went wrong`)

    const result = await Effect.runPromise(
      bindErrorDetailsForWire(writer, {
        sessionId: "session-1",
        errorCode: "session-runner-ping",
        details,
        shownLimit: 20,
      }),
    )

    expect(result.details).toEqual(details.slice(0, 20))
    expect(result.diagnosticArtifactKey).toBe("error-session-runner-ping-details-overflow")

    // AC4/AC7: the complete detail list was persisted atomically -- no
    // silent clip, the excerpt's caller can still recover everything.
    expect(persistedContent).not.toBeNull()
    const persisted = JSON.parse(persistedContent as unknown as string) as Array<string>
    expect(persisted).toHaveLength(500)
    expect(persisted).toEqual(details)
  })

  test("propagates the artifact writer's typed failure instead of silently clipping", async () => {
    const writer: BoundedCollectionArtifactWriter = {
      writeDerivedOutput: () =>
        Effect.fail(
          new EnvironmentError({
            code: "artifact-write-failed",
            reason: "disk full",
            nextStep: "Free disk space and retry.",
            details: [],
          }),
        ),
    }

    const details = Array.from({ length: 50 }, (_, index) => `line ${index}`)
    const exit = await Effect.runPromiseExit(
      bindErrorDetailsForWire(writer, {
        sessionId: "session-1",
        errorCode: "session-runner-ping",
        details,
        shownLimit: 20,
      }),
    )

    expect(exit._tag).toBe("Failure")

    if (exit._tag === "Failure") {
      const failure = exit.cause._tag === "Fail" ? exit.cause.error : null
      expect(failure).toBeInstanceOf(EnvironmentError)
      expect((failure as EnvironmentError).code).toBe("artifact-write-failed")
    }
  })
})

// PRB-094 AC8 review finding (major): `bindErrorDetailsForWire` above was
// only ever reached through `ProbeKernel.ts`'s `handleRpcRequest` catch
// step, so any escaping error that never transits the RPC socket --
// `getWorkspaceStatus`'s own failure path, and `doctor
// accessibility|commerce`/`validate accessibility|commerce`'s in-process
// `AccessibilityService`/`CommerceService` calls -- inlined the full,
// unbounded excerpt with no `diagnosticArtifactKey`. `isDetailBearingProbeError`/
// `bindDetailBearingErrorForWire`/`bindEscapingErrorForWire` are the
// sessionId-parameterized, boundary-agnostic fix: the exact reconstruction
// `ProbeKernel.ts` used to keep private to its own closure, now reusable
// from any boundary.
describe("isDetailBearingProbeError", () => {
  test("recognizes every detail-bearing tag and rejects everything else", () => {
    expect(isDetailBearingProbeError({ _tag: "UserInputError" })).toBe(true)
    expect(isDetailBearingProbeError({ _tag: "EnvironmentError" })).toBe(true)
    expect(isDetailBearingProbeError({ _tag: "DeviceInterruptionError" })).toBe(true)
    expect(isDetailBearingProbeError({ _tag: "UnsupportedCapabilityError" })).toBe(true)
    expect(isDetailBearingProbeError({ _tag: "ArtifactNotFoundError" })).toBe(false)
    expect(isDetailBearingProbeError({ _tag: "SessionNotFoundError" })).toBe(false)
  })
})

describe("bindDetailBearingErrorForWire", () => {
  test("passes a small details array through unchanged, with no artifact write", async () => {
    let writeCalls = 0
    const writer: BoundedCollectionArtifactWriter = {
      writeDerivedOutput: () => {
        writeCalls += 1
        return Effect.die("writeDerivedOutput should not be called when details already fit the limit")
      },
    }

    const error = new EnvironmentError({
      code: "session-runner-ping",
      reason: "The session runner stopped responding to health checks.",
      nextStep: "Reopen the session.",
      details: ["connection refused"],
    })

    const exit = await Effect.runPromiseExit(
      bindDetailBearingErrorForWire(writer, { sessionId: "session-1", shownLimit: 20, error }),
    )

    expect(exit._tag).toBe("Failure")
    const failure = exit._tag === "Failure" && exit.cause._tag === "Fail" ? exit.cause.error : null
    expect(failure).toBe(error)
    expect(writeCalls).toBe(0)
  })

  test("bounds the excerpt and links the complete diagnostic artifact once details overflow", async () => {
    let persistedContent: string | null = null
    const writer: BoundedCollectionArtifactWriter = {
      writeDerivedOutput: (args) => {
        persistedContent = args.content
        return Effect.succeed(makeArtifact("error-session-runner-ping-details-overflow"))
      },
    }

    const details = Array.from({ length: 500 }, (_, index) => `runner ping attempt ${index} failed: connection refused`)
    const error = new EnvironmentError({
      code: "session-runner-ping",
      reason: "The session runner stopped responding to health checks.",
      nextStep: "Reopen the session.",
      details,
    })

    const exit = await Effect.runPromiseExit(
      bindDetailBearingErrorForWire(writer, { sessionId: "session-1", shownLimit: 20, error }),
    )

    expect(exit._tag).toBe("Failure")
    const failure = exit._tag === "Failure" && exit.cause._tag === "Fail" ? (exit.cause.error as EnvironmentError) : null
    expect(failure).not.toBeNull()
    expect(failure?.details).toEqual(details.slice(0, 20))
    expect(failure?.diagnosticArtifactKey).toBe("error-session-runner-ping-details-overflow")
    expect(failure?.code).toBe("session-runner-ping")

    const persisted = JSON.parse(persistedContent as unknown as string) as Array<string>
    expect(persisted).toHaveLength(500)
    expect(persisted).toEqual(details)
  })

  // PRB-094 AC7 review finding (minor): when persisting the overflow itself
  // fails, the old fallback silently sliced to `shownLimit` with
  // `diagnosticArtifactKey: null` -- a caller saw a truncated error with no
  // link and no signal that anything was dropped. The fix keeps the
  // original error (never masks it with an unrelated persist failure) but
  // makes the drop observable: the last inlined line names how many lines
  // were dropped and why.
  test("AC7: a persist failure degrades to an excerpt that names the drop instead of silently clipping", async () => {
    const writer: BoundedCollectionArtifactWriter = {
      writeDerivedOutput: () =>
        Effect.fail(
          new EnvironmentError({
            code: "artifact-write-failed",
            reason: "disk full",
            nextStep: "Free disk space and retry.",
            details: [],
          }),
        ),
    }

    const details = Array.from({ length: 500 }, (_, index) => `runner ping attempt ${index} failed: connection refused`)
    const error = new EnvironmentError({
      code: "session-runner-ping",
      reason: "The session runner stopped responding to health checks.",
      nextStep: "Reopen the session.",
      details,
    })

    const exit = await Effect.runPromiseExit(
      bindDetailBearingErrorForWire(writer, { sessionId: "session-1", shownLimit: 20, error }),
    )

    expect(exit._tag).toBe("Failure")
    const failure = exit._tag === "Failure" && exit.cause._tag === "Fail" ? (exit.cause.error as EnvironmentError) : null
    expect(failure).not.toBeNull()
    // Never masked by the unrelated persist failure -- the original error's
    // code/reason survive.
    expect(failure?.code).toBe("session-runner-ping")
    expect(failure?.diagnosticArtifactKey ?? null).toBeNull()
    // The excerpt itself stays at the shown limit...
    expect(failure?.details).toHaveLength(20)
    // ...but the last line is not a silently-dropped 20th original detail
    // line -- it explicitly names how many lines were omitted and why.
    expect(failure?.details.slice(0, 19)).toEqual(details.slice(0, 19))
    expect(failure?.details[19]).toContain("481 more detail line(s) omitted")
    expect(failure?.details[19]).toContain("disk full")
  })
})

describe("bindEscapingErrorForWire", () => {
  test("passes a non-detail-bearing error through unchanged, with no artifact write", async () => {
    let writeCalls = 0
    const writer: BoundedCollectionArtifactWriter = {
      writeDerivedOutput: () => {
        writeCalls += 1
        return Effect.die("writeDerivedOutput should not be called for a non-detail-bearing error")
      },
    }

    const error = new ArtifactNotFoundError({
      sessionId: "session-1",
      artifactKey: "missing-artifact",
      nextStep: "Check the artifact key and retry.",
    })

    const exit = await Effect.runPromiseExit(
      bindEscapingErrorForWire(writer, { sessionId: "session-1", shownLimit: 20 }, error),
    )

    expect(exit._tag).toBe("Failure")
    const failure = exit._tag === "Failure" && exit.cause._tag === "Fail" ? exit.cause.error : null
    expect(failure).toBe(error)
    expect(writeCalls).toBe(0)
  })

  test("bounds a detail-bearing error's overflow the same way bindDetailBearingErrorForWire does", async () => {
    const writer: BoundedCollectionArtifactWriter = {
      writeDerivedOutput: (args) => Effect.succeed(makeArtifact(args.label)),
    }

    const details = Array.from({ length: 100 }, (_, index) => `bad input ${index}`)
    const error = new UserInputError({
      code: "invalid-plan",
      reason: "The commerce plan failed validation.",
      nextStep: "Fix the reported plan entries and retry.",
      details,
    })

    const exit = await Effect.runPromiseExit(
      bindEscapingErrorForWire(writer, { sessionId: "session-1", shownLimit: 20 }, error),
    )

    expect(exit._tag).toBe("Failure")
    const failure = exit._tag === "Failure" && exit.cause._tag === "Fail" ? (exit.cause.error as UserInputError) : null
    expect(failure).not.toBeNull()
    expect(failure?.details).toEqual(details.slice(0, 20))
    expect(failure?.diagnosticArtifactKey).not.toBeNull()
  })
})
