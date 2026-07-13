import { describe, expect, test } from "bun:test"
import { runDetachedRpcWorkScenario } from "./detachedRpcWork"

describe("detached rpc work scenario", () => {
  test("reproduces src/rpc/server.ts's fire-and-forget request handling as red", async () => {
    const finding = await runDetachedRpcWorkScenario()

    expect(finding.category).toBe("detached-rpc-work")
    expect(finding.verdict).toBe("red")
    expect(finding.evidence.length).toBeGreaterThan(0)
    expect(finding.evidence.some((line) => line.includes("src/rpc/server.ts:148"))).toBe(true)
    expect(finding.metrics.settledImmediatelyAfterInterrupt).toBe(0)
    expect(finding.metrics.settledAfterWait).toBe(1)
  }, 10_000)
})
