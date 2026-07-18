import { describe, expect, test } from "bun:test"
import { runOutputPolicyBoundsScenario } from "./outputPolicyBounds"

describe("output-policy bounds scenario (PRB-094)", () => {
  test("a 10k-item collection bound through the production bind step stays within the generic budget", async () => {
    const finding = await runOutputPolicyBoundsScenario()

    expect(finding.category).toBe("output-policy-overflow")
    expect(finding.verdict).toBe("green")
    expect(finding.metrics.itemCount).toBe(10_000)
    expect(finding.metrics.persistedItemCount).toBe(10_000)
    expect(finding.metrics.bytes as number).toBeLessThanOrEqual(finding.metrics.maxInlineBytes as number)
    expect(finding.metrics.lines as number).toBeLessThanOrEqual(finding.metrics.maxInlineLines as number)
    expect(finding.evidence.some((line) => line.includes("src/domain/bounded.ts"))).toBe(true)
  }, 20_000)
})
