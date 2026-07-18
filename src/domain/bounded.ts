import { Schema } from "effect"
import { DrillQuery } from "./output"
import type { CollectionDrillQuery } from "./output"

/**
 * PRB-094: the one canonical summary/detail contract for every
 * potentially-unbounded collection returned at the domain/RPC boundary
 * (session health's `artifacts`/`warnings`, a flow run's `executedSteps`,
 * and any future collection that can grow without bound). Before this glyph
 * each RPC response embedded its full collection inline -- fine for a
 * handful of items, but a 10k-step flow or a long-lived session with
 * thousands of registered artifacts could blow well past the generic
 * 4 KiB / 100 line inline budget (`OutputPolicy`/`shouldInlineOutput`,
 * output.ts) with no way to stay inside it short of silently truncating.
 *
 * `BoundedCollection<A>` replaces the raw `Array<A>` field at those
 * boundaries: it always reports the true `total`, always inlines the first
 * `shown` items (small enough to stay in budget by construction), and --
 * only when items were actually left out -- carries a typed `drill` handle
 * pointing at the full collection, which was atomically persisted (via
 * `ArtifactStore.writeDerivedOutput`, the same atomic writer PRB-090
 * hardened) *before* the summary is ever allowed to claim that handle. A
 * caller that receives `drill: null` has, by construction, already seen
 * every item -- `omitted` is `0` and `shown.length === total`.
 *
 * The handle is deliberately just enough for `artifact.drill` to resolve it
 * without reconstruction: which session, which artifact, a typed query
 * (the new `"collection"` `DrillQuery` variant below, an offset/limit
 * cursor that is deterministic across repeated reads because the backing
 * artifact is written once and never mutated), and the contract version so
 * a future incompatible reshaping of this handle can be detected instead of
 * silently misread.
 */
export const BOUNDED_COLLECTION_CONTRACT_VERSION = 1 as const

export const BoundedCollectionDrillHandle = Schema.Struct({
  contractVersion: Schema.Literal(BOUNDED_COLLECTION_CONTRACT_VERSION),
  sessionId: Schema.String,
  artifactKey: Schema.String,
  query: DrillQuery,
})
export type BoundedCollectionDrillHandle = typeof BoundedCollectionDrillHandle.Type

/** Schema factory: `BoundedCollectionSchema(ItemSchema)` for any item schema. */
export const BoundedCollectionSchema = <A, I, R>(item: Schema.Schema<A, I, R>) =>
  Schema.Struct({
    total: Schema.Number,
    shown: Schema.Array(item),
    omitted: Schema.Number,
    drill: Schema.Union(BoundedCollectionDrillHandle, Schema.Null),
  })

export interface BoundedCollection<A> {
  readonly total: number
  readonly shown: ReadonlyArray<A>
  readonly omitted: number
  readonly drill: BoundedCollectionDrillHandle | null
}

/** The page size a fresh drill handle's `query` points at by default. */
export const defaultCollectionDrillPageSize = 200

/**
 * Pure slice decision: how many items go inline vs. how many are left for
 * the drill handle to cover. Never throws, never clips silently -- the
 * caller (see `services/boundedCollections.ts`) is the one that turns a
 * non-zero `omitted` into a persisted artifact + handle, or a typed failure
 * if that persistence itself fails.
 */
export const sliceBoundedCollection = <A>(
  items: ReadonlyArray<A>,
  shownLimit: number,
): { readonly shown: ReadonlyArray<A>; readonly omitted: number } => {
  const bounded = Math.max(Math.trunc(shownLimit), 0)
  const shown = items.slice(0, bounded)
  return { shown, omitted: Math.max(items.length - shown.length, 0) }
}

/** Wraps an already-small collection as fully shown -- no persistence, no handle. */
export const boundedCollectionAllShown = <A>(items: ReadonlyArray<A>): BoundedCollection<A> => ({
  total: items.length,
  shown: items,
  omitted: 0,
  drill: null,
})

/** Deterministic in-memory page resolution for a `CollectionDrillQuery` against a full array. */
export const resolveCollectionDrillPage = <A>(
  items: ReadonlyArray<A>,
  query: CollectionDrillQuery,
): { readonly total: number; readonly offset: number; readonly items: ReadonlyArray<A> } => {
  const offset = Math.max(Math.trunc(query.offset), 0)
  const limit = Math.max(Math.trunc(query.limit), 0)
  return {
    total: items.length,
    offset,
    items: items.slice(offset, offset + limit),
  }
}
