import { describe, expect, test } from "bun:test"
import { runArtifactRaceAndEagerExportScenario } from "./artifactRaceAndEagerExport"

describe("artifact race and eager export scenario", () => {
  test("reproduces concurrent registerArtifact data loss as red on both findings", async () => {
    const [artifactRace, eagerExport] = await runArtifactRaceAndEagerExportScenario()

    expect(artifactRace.category).toBe("artifact-race")
    expect(artifactRace.verdict).toBe("red")
    expect(artifactRace.metrics.trialCount).toBe(16)
    expect(artifactRace.metrics.lostTrials).toBeGreaterThan(0)
    expect(artifactRace.evidence.some((line) => line.includes("src/services/ArtifactStore.ts:509-517"))).toBe(true)

    expect(eagerExport.category).toBe("eager-export")
    expect(eagerExport.verdict).toBe("red")
    expect(eagerExport.metrics.eagerLossTrials).toBeGreaterThan(0)
    expect(eagerExport.evidence.some((line) => line.includes("src/services/SessionRegistry.ts"))).toBe(true)
  }, 20_000)
})
