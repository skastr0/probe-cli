import { Effect } from "effect"
import {
  BOUNDED_COLLECTION_CONTRACT_VERSION,
  boundedCollectionAllShown,
  defaultCollectionDrillPageSize,
  sliceBoundedCollection,
  type BoundedCollection,
} from "../domain/bounded"
import type { EnvironmentError } from "../domain/errors"
import type { ArtifactRecord } from "../domain/output"

/**
 * PRB-094: the narrow port `bindBoundedCollection` needs from `ArtifactStore`
 * -- mirrors `FlowExecutorDeps`'s pattern (src/services/flow/flowExecutorDeps.ts)
 * of depending on the exact shape of the one method used rather than the
 * whole service, so this module (and its tests) never need to construct a
 * full `ArtifactStore` stand-in.
 */
export interface BoundedCollectionArtifactWriter {
  readonly writeDerivedOutput: (args: {
    readonly sessionId: string
    readonly label: string
    readonly format: "json" | "text"
    readonly content: string
    readonly summary: string
  }) => Effect.Effect<ArtifactRecord, EnvironmentError>
}

export interface BindBoundedCollectionArgs<A> {
  readonly sessionId: string
  /** Used to derive both the artifact label and the drill-summary wording. */
  readonly collectionLabel: string
  readonly items: ReadonlyArray<A>
  /** How many items to inline before the rest overflows to a persisted artifact. */
  readonly shownLimit: number
}

/**
 * The one summary/detail decision every unbounded-collection field at the
 * domain/RPC boundary asks: inline everything if it already fits under
 * `shownLimit`, otherwise atomically persist the *full* collection (AC4 --
 * before the summary is built, never after) and return a typed drill handle
 * alongside the bounded inline preview. If the persist itself fails, this
 * fails with the same typed `EnvironmentError` `writeDerivedOutput` already
 * raises -- overflow that cannot be durably addressed is a typed failure,
 * never a silent clip (AC7).
 */
export const bindBoundedCollection = <A>(
  artifactStore: BoundedCollectionArtifactWriter,
  args: BindBoundedCollectionArgs<A>,
): Effect.Effect<BoundedCollection<A>, EnvironmentError> =>
  Effect.gen(function* () {
    const { shown, omitted } = sliceBoundedCollection(args.items, args.shownLimit)

    if (omitted === 0) {
      return boundedCollectionAllShown(args.items)
    }

    const artifact = yield* artifactStore.writeDerivedOutput({
      sessionId: args.sessionId,
      label: `${args.collectionLabel}-overflow`,
      format: "json",
      content: `${JSON.stringify(args.items, null, 2)}\n`,
      summary: `${args.items.length} ${args.collectionLabel} item(s); ${omitted} omitted from the inline summary.`,
    })

    return {
      total: args.items.length,
      shown,
      omitted,
      drill: {
        contractVersion: BOUNDED_COLLECTION_CONTRACT_VERSION,
        sessionId: args.sessionId,
        artifactKey: artifact.key,
        query: {
          kind: "collection" as const,
          offset: 0,
          limit: defaultCollectionDrillPageSize,
        },
      },
    }
  })
