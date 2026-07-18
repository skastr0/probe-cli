import { describe, expect, test } from "bun:test"
import { decodeSessionFlowContract, validateSessionFlowContract, type SessionFlowContract } from "../domain/flow-v2"
import {
  discoverFlowExampleFiles,
  KNOWN_PENDING_CAPABILITY_EXAMPLES,
  requiredRunnerCapabilities,
} from "./flowExampleInventory"
import { runnerCapabilityRegistryEntry } from "./runnerCapabilities"

// PRB-071: glob-discovers every JSON file under docs/examples/flows (and any
// future roots registered in flowExampleInventory.ts — AC-3), decodes and
// domain-validates each against the canonical probe.session-flow/v2 contract
// (AC-1, superseding gate 2), and runs in `bun test` as part of
// `bun run verify` so CI catches a broken addition automatically (AC-2,
// superseding gate 4). This is the schema/domain layer only — representative
// interaction examples are additionally exercised against a live ProbeFixture
// session in scripts/validate-product-flow.ts (superseding gate 3), which
// requires a simulator and cannot run here.
const examples = discoverFlowExampleFiles()

describe("flow example inventory", () => {
  test("glob discovery finds at least one probe.session-flow/v2 example under docs/examples/flows", () => {
    expect(examples.length).toBeGreaterThan(0)
  })

  for (const example of examples) {
    test(`${example.fileName} decodes as probe.session-flow/v2 and passes domain validation`, () => {
      const flow = decodeSessionFlowContract(example.raw)
      expect(validateSessionFlowContract(flow)).toBeNull()
    })
  }

  for (const example of examples) {
    const pendingCapability = KNOWN_PENDING_CAPABILITY_EXAMPLES[example.fileName]

    describe(`${example.fileName} runner capabilities`, () => {
      let decoded: SessionFlowContract | null = null

      try {
        decoded = decodeSessionFlowContract(example.raw)
      } catch {
        // The decode test above already fails loudly for this file; there is
        // nothing further to check about its (nonexistent) execution plan.
        decoded = null
      }

      if (decoded === null) {
        test.skip(`${example.fileName} did not decode; see the decode/validation test above`, () => {})
        return
      }

      const flow = decoded
      const required = requiredRunnerCapabilities(flow)

      if (required.length === 0) {
        test("requires no gated runner capability (host-single/verified execution only)", () => {
          expect(required).toEqual([])
        })
        return
      }

      for (const capability of required) {
        if (capability === pendingCapability) {
          test.skip(
            `requires ${capability}, which RUNNER_CAPABILITY_REGISTRY still marks implementedInSwift: false — `
              + "tracked as a known-pending recipe (see KNOWN_PENDING_CAPABILITY_EXAMPLES), not a broken example",
            () => {},
          )
          continue
        }

        test(`requires ${capability}, which the production runner implements`, () => {
          expect(runnerCapabilityRegistryEntry(capability).implementedInSwift).toBe(true)
        })
      }
    })
  }

  // Adding a new example that exercises a capability the runner does not
  // implement yet fails this suite (superseding gate 4) unless it is
  // deliberately named in KNOWN_PENDING_CAPABILITY_EXAMPLES with a citation —
  // that is what keeps a fresh stale-capability example from slipping through
  // `bun run verify` while still letting a documented, tracked gap ship
  // without lying about it.
  test("KNOWN_PENDING_CAPABILITY_EXAMPLES only names files that exist and genuinely still need the exemption", () => {
    for (const [fileName, capability] of Object.entries(KNOWN_PENDING_CAPABILITY_EXAMPLES)) {
      const example = examples.find((candidate) => candidate.fileName === fileName)
      expect(example).toBeDefined()

      const flow = decodeSessionFlowContract(example!.raw)
      expect(requiredRunnerCapabilities(flow)).toContain(capability)
      expect(runnerCapabilityRegistryEntry(capability).implementedInSwift).toBe(false)
    }
  })
})
