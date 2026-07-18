#!/usr/bin/env bun

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runDeviceLane } from "./lanes/deviceLane"
import { runSimulatorLane } from "./lanes/simulatorLane"
import { captureProvenance } from "./provenance"
import { runAmbiguousMutationDeliveryScenario } from "./scenarios/ambiguousMutationDelivery"
import { runArtifactRaceAndEagerExportScenario } from "./scenarios/artifactRaceAndEagerExport"
import { runDetachedRpcWorkScenario } from "./scenarios/detachedRpcWork"
import { runOutputPolicyBoundsScenario } from "./scenarios/outputPolicyBounds"
import {
  deriveOverallVerdict,
  encodeInvestigationReport,
  INVESTIGATION_SCHEMA_VERSION,
  type DefectFinding,
  type InvestigationReport,
} from "./schema"

const reportDirectory = join(process.cwd(), "knowledge", "rpc-daemon-defects", "baselines")
const reportPath = join(reportDirectory, "v1.json")

const main = async () => {
  console.error("PRB-087 investigation: capturing provenance...")
  const provenance = captureProvenance()

  console.error("PRB-087 investigation: running detached-rpc-work scenario...")
  const detachedRpcWork = await runDetachedRpcWorkScenario()

  console.error("PRB-087 investigation: running ambiguous-mutation-delivery scenario...")
  const ambiguousMutationDelivery = await runAmbiguousMutationDeliveryScenario()

  console.error("PRB-087 investigation: running artifact-race / eager-export scenario...")
  const [artifactRace, eagerExport] = await runArtifactRaceAndEagerExportScenario()

  console.error("PRB-087 investigation: running output-policy bounds scenario (PRB-094)...")
  const outputPolicyBounds = await runOutputPolicyBoundsScenario()

  console.error("PRB-087 investigation: running simulator lane...")
  const simulatorLaneResult = await runSimulatorLane()

  console.error("PRB-087 investigation: running device lane...")
  const deviceLaneResult = await runDeviceLane()

  const findings: ReadonlyArray<DefectFinding> = [
    detachedRpcWork,
    ambiguousMutationDelivery,
    artifactRace,
    eagerExport,
    outputPolicyBounds,
  ]

  const report: InvestigationReport = {
    schemaVersion: INVESTIGATION_SCHEMA_VERSION,
    glyphId: "PRB-087",
    provenance,
    lanes: {
      simulator: simulatorLaneResult,
      device: deviceLaneResult,
    },
    findings,
    overallVerdict: deriveOverallVerdict(findings),
    notes: [
      "This baseline originally captured known-red defects (ambiguous mutation delivery, eager export, artifact races, detached RPC work) without fixing them; see PRB-087.",
      "PRB-097 update: the artifact-race and eager-export findings now reproduce green -- ArtifactStore.registerArtifact's read-modify-write moved behind a per-catalog-path lock plus an atomic temp-write-then-rename (PRB-090, landed on main before PRB-097's wave); the scenario's mirror was re-verified against that fixed algorithm rather than deleted. ambiguous-mutation-delivery and detached-rpc-work are unrelated to this fix and remain whatever this run measures them as.",
      "The artifact-race and eager-export scenarios exercise a faithful mirror of ArtifactStore.registerArtifact's (now lock-guarded, atomically-written) read-modify-write algorithm against a temp directory rather than the real ArtifactStoreLive service, because that service roots artifacts under `join(homedir(), \".probe\")` with no injection point and Bun's os.homedir() does not honor a HOME override at call time.",
      "The simulator lane boots and shuts down a real iOS Simulator via simctl but does not install/launch the Probe XCUITest runner app; a full app-session lane requires the ios/ Xcode build pipeline and is out of scope for this harness.",
      "PRB-094 addition: the output-policy-overflow finding measures the RPC-boundary bounded-collection contract (domain/bounded.ts, services/boundedCollections.ts) against a real 10k-item collection through the production bind step, not a mock -- see scenarios/outputPolicyBounds.ts.",
    ],
  }

  if (!existsSync(reportDirectory)) {
    mkdirSync(reportDirectory, { recursive: true })
  }

  writeFileSync(reportPath, `${JSON.stringify(encodeInvestigationReport(report), null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  console.error(`PRB-087 investigation: baseline written to ${reportPath} (overall verdict: ${report.overallVerdict}).`)
}

await main()
