import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  isBatchSequencePlannedStep,
  isFastSinglePlannedStep,
  planFlowExecution,
} from "../domain/flow-planner"
import type { SessionFlowContract } from "../domain/flow-v2"
import { runnerCapabilityRegistryEntry } from "./runnerCapabilities"
import type { RunnerCapability } from "./runnerProtocol"

// PRB-071: single source of truth for "every JSON example under docs/examples/
// flows" — both the CI-facing schema/domain-validation test
// (flowExampleInventory.test.ts) and the hardware-facing product-validation
// script (scripts/validate-product-flow.ts) import from here so the file list
// and the pending-capability table can never drift between the two contexts.
//
// New example roots (PRB-099 investigation examples, PRB-100 generated-agent
// examples) get appended here as they land — this array of roots is the one
// hardcoded thing; the files inside each root are always glob-discovered,
// never enumerated by name, so a new file is picked up automatically.
export const FLOW_EXAMPLE_ROOTS: ReadonlyArray<string> = [
  join(import.meta.dir, "..", "..", "docs", "examples", "flows"),
]

// Examples that are known to require a runner capability the production
// Swift runner does not implement yet (see RUNNER_CAPABILITY_REGISTRY /
// ios/ProbeRunner/AttachControlSpikeUITests.swift handleLifecycleCommand).
// Each entry keeps the example in the repo as an accepted, schema-valid
// contract while making the gap explicit and skipped — in both the schema
// test and product validation — rather than silently treated as fully
// verified. Delete the entry the moment the registry flips
// implementedInSwift to true for that capability.
//
// PRB-092: empty — "sequence-batch-v2.json" (uiActionBatch) was the one
// entry here; RUNNER_CAPABILITY_REGISTRY now marks uiActionBatch
// implementedInSwift: true (boundary-tested — see that registry entry's
// evidence string), so the example is no longer pending and runs as a real
// pass in both the schema test and scripts/validate-product-flow.ts.
export const KNOWN_PENDING_CAPABILITY_EXAMPLES: Readonly<Record<string, RunnerCapability>> = {}

export interface DiscoveredFlowExample {
  readonly fileName: string
  readonly absolutePath: string
  readonly raw: unknown
}

export const discoverFlowExampleFiles = (): ReadonlyArray<DiscoveredFlowExample> =>
  FLOW_EXAMPLE_ROOTS.flatMap((root) =>
    readdirSync(root)
      .filter((fileName) => fileName.endsWith(".json"))
      .sort()
      .map((fileName): DiscoveredFlowExample => {
        const absolutePath = join(root, fileName)
        return {
          fileName,
          absolutePath,
          raw: JSON.parse(readFileSync(absolutePath, "utf8")) as unknown,
        }
      }),
  )

// Pure (no fs, no runtime side effects): resolves every runner capability a
// decoded flow's execution plan would need, by walking the same planner the
// daemon uses to execute flows (src/domain/flow-planner.ts). A duration-only
// fast "wait" never touches the runner, so it never contributes a capability.
export const requiredRunnerCapabilities = (flow: SessionFlowContract): ReadonlyArray<RunnerCapability> => {
  const capabilities = new Set<RunnerCapability>()

  for (const plannedStep of planFlowExecution(flow).steps) {
    if (isBatchSequencePlannedStep(plannedStep)) {
      capabilities.add("uiActionBatch")
      continue
    }

    if (isFastSinglePlannedStep(plannedStep) && plannedStep.step.kind !== "wait") {
      capabilities.add("uiAction")
    }
  }

  return [...capabilities]
}

/** The subset of an example's required capabilities that the production runner does not implement yet. */
export const pendingRunnerCapabilities = (flow: SessionFlowContract): ReadonlyArray<RunnerCapability> =>
  requiredRunnerCapabilities(flow).filter(
    (capability) => !runnerCapabilityRegistryEntry(capability).implementedInSwift,
  )
