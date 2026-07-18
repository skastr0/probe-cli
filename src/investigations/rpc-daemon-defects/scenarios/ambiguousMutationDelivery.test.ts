import { describe, expect, test } from "bun:test"
import { runAmbiguousMutationDeliveryScenario } from "./ambiguousMutationDelivery"

describe("ambiguous mutation delivery scenario", () => {
  // PRB-089 owns this scenario (wave-1 handoff note) and flips it from red to
  // green: src/rpc/client.ts now tracks the last-seen progress-event
  // sequence per request and fails the request the moment a later event
  // skips ahead, instead of letting the gap pass through silently.
  test("detects the sequence gap and rejects the request as green", async () => {
    const finding = await runAmbiguousMutationDeliveryScenario()

    expect(finding.category).toBe("ambiguous-mutation-delivery")
    expect(finding.verdict).toBe("green")
    expect(finding.metrics.sequenceGapDetected).toBe(1)
    // The request no longer resolves successfully: the gap is now the
    // reason it fails, not a fact a successful caller never learns about.
    expect(finding.metrics.requestSucceeded).toBe(0)
    // Only the first (sequence 1) event ever reaches the caller's `onEvent`;
    // the gapped second event (sequence 5) is caught before it is forwarded.
    expect(finding.metrics.observedEventCount).toBe(1)
    expect(finding.evidence.some((line) => line.includes("src/rpc/protocol.ts:679"))).toBe(true)
    expect(finding.evidence.some((line) => line.includes("rpc-progress-sequence-gap"))).toBe(true)
    expect(finding.summary).toContain("rejected before a 3rd event")
  }, 10_000)
})
