import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { defaultCollectionDrillPageSize } from "../domain/bounded"
import { EnvironmentError } from "../domain/errors"
import type { ArtifactRecord } from "../domain/output"
import { bindBoundedCollection, type BoundedCollectionArtifactWriter } from "./boundedCollections"

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
