import { describe, expect, test } from "bun:test"
import { runDetachedRpcWorkScenario } from "./detachedRpcWork"

describe("detached rpc work scenario", () => {
  // PRB-087 pinned this scenario red against the fire-and-forget dispatch in
  // src/rpc/server.ts (Effect.runPromise(...).then(...) outside serveRpc's own
  // scope). PRB-088 (src/rpc/server.ts:323-331,392-398) forks and tracks each
  // accepted connection's request fiber so serveRpc's own interruption now
  // reaches it. Flip: red -> green. Kept as a live regression check rather
  // than deleted, per PRB-088 fixing the defect this scenario was built to
  // catch.
  test("observes src/rpc/server.ts's request handling as scoped to the daemon fiber (green)", async () => {
    const finding = await runDetachedRpcWorkScenario()

    expect(finding.category).toBe("detached-rpc-work")
    expect(finding.verdict).toBe("green")
    expect(finding.evidence.length).toBeGreaterThan(0)
    expect(finding.evidence.some((line) => line.includes("src/rpc/server.ts:329"))).toBe(true)
    expect(finding.metrics.settledImmediatelyAfterInterrupt).toBe(0)
    expect(finding.metrics.settledAfterWait).toBe(0)
  }, 10_000)
})
