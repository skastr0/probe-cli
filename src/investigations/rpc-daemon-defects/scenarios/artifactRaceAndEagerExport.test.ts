import { describe, expect, test } from "bun:test"
import { runArtifactRaceAndEagerExportScenario } from "./artifactRaceAndEagerExport"

// PRB-097: flips both findings from red (the PRB-087 baseline, an unlocked
// read-modify-write) to green -- the mirror now reproduces the current,
// already-fixed (PRB-090) locked ArtifactStore algorithm, with evidence.
// The scenario itself, and its "not-run" harness-failure fallback, are kept
// intact: this is a re-verification against the fixed algorithm, not a
// deletion of the regression check.
describe("artifact race and eager export scenario", () => {
  test("reproduces zero data loss against the current locked registerArtifact algorithm on both findings", async () => {
    const [artifactRace, eagerExport] = await runArtifactRaceAndEagerExportScenario()

    expect(artifactRace.category).toBe("artifact-race")
    expect(artifactRace.verdict).toBe("green")
    expect(artifactRace.metrics.trialCount).toBe(16)
    expect(artifactRace.metrics.lostTrials).toBe(0)
    expect(artifactRace.evidence.some((line) => line.includes("src/services/ArtifactStore.ts:721"))).toBe(true)

    expect(eagerExport.category).toBe("eager-export")
    expect(eagerExport.verdict).toBe("green")
    expect(eagerExport.metrics.eagerLossTrials).toBe(0)
    expect(eagerExport.evidence.some((line) => line.includes("src/services/ArtifactStore.ts"))).toBe(true)
  }, 20_000)
})
