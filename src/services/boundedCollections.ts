import { Effect } from "effect"
import {
  BOUNDED_COLLECTION_CONTRACT_VERSION,
  boundedCollectionAllShown,
  defaultCollectionDrillPageSize,
  sliceBoundedCollection,
  type BoundedCollection,
} from "../domain/bounded"
import {
  DeviceInterruptionError,
  EnvironmentError,
  UnsupportedCapabilityError,
  UserInputError,
} from "../domain/errors"
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

// PRB-094 AC8: how many `details` lines a typed error crossing *any*
// boundary -- the RPC socket (`ProbeKernel.ts`'s `handleRpcRequest`) or an
// in-process CLI-direct call that never touches the daemon
// (`getWorkspaceStatus`, `doctor accessibility|commerce`, `validate
// accessibility|commerce`) -- inlines before the rest is persisted as a
// complete diagnostic artifact and linked via `diagnosticArtifactKey`. One
// shared constant so every call site bounds to the same excerpt size
// regardless of which boundary the error escaped through.
export const errorDetailsShownLimit = 20

/**
 * PRB-094 AC8: the typed errors that carry a `details: Array<string>` (and a
 * settable `diagnosticArtifactKey`) the same way `DiagnosticReport.details`
 * does -- the error-shaped analogue of "potentially unbounded collection".
 * `UnsupportedFlowContractError` also carries `details`/`diagnosticArtifactKey`
 * but has never escaped a boundary this binds (flow-contract mismatches are
 * caught and reported before they reach the RPC/CLI edge), so it is
 * deliberately not part of this union.
 */
export type DetailBearingProbeError =
  | UserInputError
  | EnvironmentError
  | DeviceInterruptionError
  | UnsupportedCapabilityError

export const isDetailBearingProbeError = (
  error: { readonly _tag: string },
): error is DetailBearingProbeError =>
  error._tag === "UserInputError"
  || error._tag === "EnvironmentError"
  || error._tag === "DeviceInterruptionError"
  || error._tag === "UnsupportedCapabilityError"

/**
 * PRB-094 AC8 review fix: the sessionId-parameterized reconstruction step
 * that used to live only inside `ProbeKernel.ts`'s `handleRpcRequest`
 * closure (as `boundDetailBearingError`, keyed off an `RpcRequest`) -- moved
 * here and generalized to take a `sessionId` directly so the same bound/link
 * behavior is reachable from any boundary a `DetailBearingProbeError` can
 * escape through, not just the RPC socket. Below `shownLimit` the error
 * comes back byte-for-byte unchanged (no persistence, mirroring
 * `bindBoundedCollection`'s "nothing omitted -> no artifact write").
 *
 * PRB-094 AC7 review fix: if persisting the complete `details` list itself
 * fails, this still degrades to an excerpt rather than compounding the
 * original failure with an unrelated "could not persist diagnostics" one --
 * but the excerpt is never a *silent* clip. The last inlined line is
 * replaced with an explicit marker naming how many lines were dropped and
 * why, so a caller reading only the bounded `details` still sees that the
 * excerpt is incomplete instead of mistaking it for the whole story.
 */
export const bindDetailBearingErrorForWire = (
  artifactStore: BoundedCollectionArtifactWriter,
  args: {
    readonly sessionId: string
    readonly shownLimit: number
    readonly error: DetailBearingProbeError
  },
): Effect.Effect<never, DetailBearingProbeError> =>
  Effect.gen(function* () {
    const { error, sessionId, shownLimit } = args

    if (error.details.length <= shownLimit) {
      return yield* Effect.fail(error)
    }

    const bound = yield* bindErrorDetailsForWire(artifactStore, {
      sessionId,
      errorCode: error.code,
      details: error.details,
      shownLimit,
    }).pipe(
      Effect.catchAll((persistError) => {
        const keep = Math.max(shownLimit - 1, 0)
        const shown = error.details.slice(0, keep)
        const droppedCount = error.details.length - shown.length

        return Effect.succeed({
          details: [
            ...shown,
            `${droppedCount} more detail line(s) omitted; persisting the complete diagnostic artifact also failed: ${persistError.reason}.`,
          ],
          diagnosticArtifactKey: null as string | null,
        })
      }),
    )

    switch (error._tag) {
      case "UserInputError":
        return yield* Effect.fail(new UserInputError({
          code: error.code,
          reason: error.reason,
          nextStep: error.nextStep,
          details: bound.details,
          diagnosticArtifactKey: bound.diagnosticArtifactKey,
        }))
      case "EnvironmentError":
        return yield* Effect.fail(new EnvironmentError({
          code: error.code,
          reason: error.reason,
          nextStep: error.nextStep,
          details: bound.details,
          diagnosticArtifactKey: bound.diagnosticArtifactKey,
        }))
      case "DeviceInterruptionError":
        return yield* Effect.fail(new DeviceInterruptionError({
          code: error.code,
          signal: error.signal,
          reason: error.reason,
          nextStep: error.nextStep,
          details: bound.details,
          diagnosticArtifactKey: bound.diagnosticArtifactKey,
        }))
      case "UnsupportedCapabilityError":
        return yield* Effect.fail(new UnsupportedCapabilityError({
          code: error.code,
          capability: error.capability,
          reason: error.reason,
          nextStep: error.nextStep,
          details: bound.details,
          diagnosticArtifactKey: bound.diagnosticArtifactKey,
          wall: error.wall,
        }))
    }
  })

/**
 * PRB-094 AC8 review fix: the one dispatcher every boundary's escaping-error
 * catch step calls -- detail-bearing errors get bound/linked via
 * `bindDetailBearingErrorForWire` above; every other typed error (session
 * lookups, protocol mismatches, child-process failures, ...) passes through
 * unchanged, exactly mirroring `ProbeKernel.ts`'s pre-PRB-094-fix
 * `boundEscapingErrorDetails` dispatch but reusable from CLI-direct call
 * sites (`doctor accessibility|commerce`, `validate accessibility|commerce`,
 * `getWorkspaceStatus`) that never transit the RPC socket.
 */
export const bindEscapingErrorForWire = <E extends { readonly _tag: string }>(
  artifactStore: BoundedCollectionArtifactWriter,
  args: {
    readonly sessionId: string
    readonly shownLimit: number
  },
  error: E,
): Effect.Effect<never, E> =>
  isDetailBearingProbeError(error)
    ? (bindDetailBearingErrorForWire(artifactStore, { ...args, error }) as unknown as Effect.Effect<never, E>)
    : Effect.fail(error)
