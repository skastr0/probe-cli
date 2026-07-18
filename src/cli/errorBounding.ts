import { Effect } from "effect"
import { ArtifactStore } from "../services/ArtifactStore"
import { bindEscapingErrorForWire, errorDetailsShownLimit } from "../services/boundedCollections"

/**
 * PRB-094 AC8 review fix: the one place `doctor accessibility|commerce` and
 * `validate accessibility|commerce` (cli/commands/doctor.ts, validate.ts)
 * bound an escaping `AccessibilityService`/`CommerceService` error the same
 * way `ProbeKernel.ts`'s `handleRpcRequest` bounds an escaping RPC-boundary
 * error -- neither of those CLI-direct in-process calls ever transits the
 * daemon RPC socket, so neither previously got the bound-or-link treatment.
 * Shared here instead of duplicated per command module: both call sites
 * needed the exact same "resolve `ArtifactStore` from context, then
 * dispatch through `bindEscapingErrorForWire`" shape, differing only in
 * which `sessionId` scopes the persisted overflow artifact.
 */
export const boundCliEscapingError = <E extends { readonly _tag: string }>(sessionId: string, error: E) =>
  Effect.gen(function* () {
    const artifactStore = yield* ArtifactStore
    return yield* bindEscapingErrorForWire(artifactStore, { sessionId, shownLimit: errorDetailsShownLimit }, error)
  })
