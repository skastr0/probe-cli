import { describe, expect, test } from "bun:test"
import { runAmbiguousMutationDeliveryScenario } from "./ambiguousMutationDelivery"

describe("ambiguous mutation delivery scenario", () => {
  test("reproduces an undetected sequence gap as red", async () => {
    const finding = await runAmbiguousMutationDeliveryScenario()

    expect(finding.category).toBe("ambiguous-mutation-delivery")
    expect(finding.verdict).toBe("red")
    expect(finding.metrics.sequenceGapDetected).toBe(1)
    expect(finding.metrics.requestSucceeded).toBe(1)
    expect(finding.metrics.observedEventCount).toBe(2)
    expect(finding.evidence.some((line) => line.includes("src/rpc/protocol.ts:679"))).toBe(true)
  }, 10_000)
})
