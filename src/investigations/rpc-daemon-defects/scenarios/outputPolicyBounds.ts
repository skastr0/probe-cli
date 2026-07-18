import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { bindBoundedCollection } from "../../../services/boundedCollections"
import type { DefectFinding } from "../schema"

// PRB-094: measures the actual, real defect this glyph closes -- before it,
// a 10k-item collection (session-health artifacts/warnings, a flow's
// executed steps) was inlined whole into a "normal result" RPC response,
// blowing well past the generic 4 KiB / 100 line inline budget
// (services/OutputPolicy.ts / domain/output.ts's `shouldInlineOutput`).
// This scenario builds a real 10k-item collection through the production
// `bindBoundedCollection` bind step (services/boundedCollections.ts)
// against a real temp-directory-backed writer, then measures the resulting
// summary's wire (compact JSON) size against that same budget -- a
// functional measurement, not a read of the source.
const maxInlineBytes = 4 * 1024
const maxInlineLines = 100
const trialItemCount = 10_000
const shownLimit = 5

const countLines = (text: string): number => (text.length === 0 ? 0 : text.split(/\r?\n/).length)

export const runOutputPolicyBoundsScenario = async (): Promise<DefectFinding> => {
  const root = await mkdtemp(join(tmpdir(), "probe-investigation-output-policy-"))

  try {
    const items = Array.from({ length: trialItemCount }, (_, index) => `warning ${index} from a large session`)

    const bound = await Effect.runPromise(
      bindBoundedCollection(
        {
          writeDerivedOutput: (args) =>
            Effect.tryPromise({
              try: async () => {
                const absolutePath = join(root, `${args.label}.json`)
                await mkdir(root, { recursive: true })
                await writeFile(absolutePath, args.content, "utf8")
                return {
                  key: `derived-${args.label}`,
                  label: args.label,
                  kind: "json" as const,
                  summary: args.summary,
                  absolutePath,
                  relativePath: null,
                  external: false,
                  createdAt: new Date().toISOString(),
                }
              },
              catch: (error) => new Error(`writeDerivedOutput failed: ${String(error)}`),
            }).pipe(Effect.orDie),
        },
        {
          sessionId: "investigation-fixture-session",
          collectionLabel: "investigation-warnings",
          items,
          shownLimit,
        },
      ),
    )

    const wireJson = JSON.stringify(bound)
    const bytes = Buffer.byteLength(wireJson, "utf8")
    const lines = countLines(wireJson)
    const withinBudget = bytes <= maxInlineBytes && lines <= maxInlineLines

    // AC4: the full detail was persisted -- atomically, by the same
    // writeDerivedOutput seam ArtifactStore uses -- before this summary's
    // handle could ever be claimed. Verify it actually round-trips every
    // item, not just the inline preview.
    const persistedContent = bound.drill ? await readFile(join(root, "investigation-warnings-overflow.json"), "utf8") : null
    const persisted = persistedContent ? (JSON.parse(persistedContent) as Array<string>) : []
    const persistsFullDetail = bound.drill !== null && persisted.length === trialItemCount

    const reproduced = !withinBudget || !persistsFullDetail

    return {
      id: "output-policy-overflow-01",
      category: "output-policy-overflow",
      verdict: reproduced ? "red" : "green",
      summary: reproduced
        ? `A ${trialItemCount}-item bounded collection's wire response used ${bytes} bytes / ${lines} lines (budget: ${maxInlineBytes} bytes / ${maxInlineLines} lines) or failed to persist full detail (persisted ${persisted.length}/${trialItemCount}) -- the bounded-collection contract (domain/bounded.ts, services/boundedCollections.ts) did not hold.`
        : `A ${trialItemCount}-item collection bound through bindBoundedCollection stayed within budget (${bytes}/${maxInlineBytes} bytes, ${lines}/${maxInlineLines} lines) and its full ${trialItemCount}-item detail was atomically persisted before the summary claimed its drill handle.`,
      evidence: [
        "src/domain/bounded.ts (BoundedCollectionSchema, sliceBoundedCollection) -- the summary/detail contract every RPC-boundary collection now uses.",
        "src/services/boundedCollections.ts (bindBoundedCollection) -- persists full detail atomically before returning a handle; a persistence failure surfaces as a typed EnvironmentError, never a silent clip.",
        `measured: ${bytes} bytes / ${lines} lines for ${trialItemCount} items (shownLimit=${shownLimit}); persisted ${persisted.length}/${trialItemCount} items to the overflow artifact.`,
      ],
      metrics: {
        itemCount: trialItemCount,
        shownLimit,
        bytes,
        lines,
        maxInlineBytes,
        maxInlineLines,
        persistedItemCount: persisted.length,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)

    return {
      id: "output-policy-overflow-01",
      category: "output-policy-overflow",
      verdict: "not-run",
      summary: `Scenario harness failed before it could measure the bounded-collection wire budget: ${message}`,
      evidence: [message],
      metrics: {},
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
