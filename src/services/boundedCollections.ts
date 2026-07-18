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

/**
 * PRB-094: the workspace-status analogue of `bindFlowResultForWire`
 * (ProbeKernel.ts) -- `DiagnosticReport`/`KnownWall` (domain/diagnostics.ts)
 * are keyed reports with one potentially-unbounded `details: Array<string>`
 * field each (a long-running host's stale-session recovery notes, in
 * particular, grows with however many stale sessions it finds). Unlike
 * session health/flow results, `getWorkspaceStatus` has no single session to
 * scope an overflow artifact to -- it reports on the whole workspace, not
 * one session -- so this binds against the fixed `sessionId` the caller
 * passes in (see `workspaceDiagnosticsSessionId`, ProbeKernel.ts), reusing
 * the same atomic-persist-then-drill contract and the same session-directory
 * prune lifecycle (`ArtifactStore.pruneExpiredSessions`) every other bound
 * collection already relies on.
 */
export const bindDetailsForWire = <T extends { readonly key: string; readonly details: ReadonlyArray<string> }>(
  artifactStore: BoundedCollectionArtifactWriter,
  args: {
    readonly sessionId: string
    readonly shownLimit: number
    readonly report: T
  },
): Effect.Effect<Omit<T, "details"> & { readonly details: BoundedCollection<string> }, EnvironmentError> =>
  Effect.gen(function* () {
    const details = yield* bindBoundedCollection(artifactStore, {
      sessionId: args.sessionId,
      collectionLabel: `diagnostic-${args.report.key}-details`,
      items: args.report.details,
      shownLimit: args.shownLimit,
    })

    return { ...args.report, details }
  })

/**
 * PRB-094 AC8: "errors bound excerpts and link the complete diagnostic
 * artifact" -- the error-shaped analogue of `bindBoundedCollection`. A typed
 * error's `details: Array<string>` (`UserInputError`/`EnvironmentError`/
 * `DeviceInterruptionError`/`UnsupportedCapabilityError`/
 * `UnsupportedFlowContractError`, domain/errors.ts) is unbounded at the type
 * level the same way `DiagnosticReport.details` was -- this is the one place
 * that actually enforces a bound before an error escapes to the RPC/CLI
 * boundary (see `ProbeKernel.ts`'s `handleRpcRequest`, which wraps its whole
 * response in a `catchAll` that calls this for any escaping error whose
 * `details` is too big to inline).
 *
 * Below the limit, `details`/`diagnosticArtifactKey` come back unchanged
 * (`null`) -- nothing was truncated, nothing to link, exactly mirroring
 * `bindBoundedCollection`'s "nothing omitted -> no artifact write, drill
 * null" behavior. Over the limit, the *complete* detail list is persisted
 * atomically (AC4) before the excerpt is ever returned (AC7: never a silent
 * clip -- a caller that only sees the truncated `details` can still resolve
 * `diagnosticArtifactKey` for everything that didn't fit).
 */
export const bindErrorDetailsForWire = (
  artifactStore: BoundedCollectionArtifactWriter,
  args: {
    readonly sessionId: string
    readonly errorCode: string
    readonly details: ReadonlyArray<string>
    readonly shownLimit: number
  },
): Effect.Effect<
  { readonly details: ReadonlyArray<string>; readonly diagnosticArtifactKey: string | null },
  EnvironmentError
> =>
  Effect.gen(function* () {
    const bound = yield* bindBoundedCollection(artifactStore, {
      sessionId: args.sessionId,
      collectionLabel: `error-${args.errorCode}-details`,
      items: args.details,
      shownLimit: args.shownLimit,
    })

    return {
      details: bound.shown,
      diagnosticArtifactKey: bound.drill?.artifactKey ?? null,
    }
  })
