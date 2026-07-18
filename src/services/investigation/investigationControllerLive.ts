import { Effect, Layer } from "effect"
import { InvestigationController, InvestigationControllerLayer } from "../InvestigationController"
import { InvestigationStore } from "../InvestigationStore"
import { DaemonClient } from "../DaemonClient"
import { makeInvestigationExecutorDepsLive } from "./investigationExecutorDepsLive"

/**
 * Production `InvestigationController` layer: resolves the real
 * `DaemonClient`/`InvestigationStore` from context, builds the production
 * `InvestigationExecutorDeps` from them, then hands both to
 * `InvestigationControllerLayer` (services/InvestigationController.ts). Kept
 * as its own tiny file (rather than inlined into `InvestigationController.ts`
 * or `investigationExecutorDepsLive.ts`) so both of those stay free of a
 * circular import between the controller and its production deps.
 */
export const InvestigationControllerLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const daemonClient = yield* DaemonClient
    const store = yield* InvestigationStore
    const deps = makeInvestigationExecutorDepsLive(daemonClient, store)
    return InvestigationControllerLayer(deps)
  }),
)
