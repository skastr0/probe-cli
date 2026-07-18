import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { FlowV2Step } from "../../domain/flow-v2"
import { executeVerifiedActionStep, toSessionAction } from "./verifiedActionExecutor"
import type { FlowExecutorDeps } from "./flowExecutorDeps"
import { makeUnusedFlowExecutorDeps } from "./flowExecutorTestSupport"

// PRB-073 AC-4: imports only the executor, domain types, and the shared
// fixtures above — no SessionRegistryLive, no ArtifactStore, no Layer.

describe("toSessionAction", () => {
  test("converts a flow session-action step into its SessionAction", () => {
    const step: FlowV2Step = { kind: "tap", target: { kind: "point", x: 1, y: 2 } } as never
    const action = toSessionAction(step)
    expect(action.kind).toBe("tap")
  })

  test("throws for a non-session-action step, e.g. snapshot", () => {
    const step: FlowV2Step = { kind: "snapshot" } as never
    expect(() => toSessionAction(step)).toThrow(/Expected a flow session-action step/)
  })
})

describe("executeVerifiedActionStep", () => {
  test("delegates to deps.executeSessionAction with recordAction: false and the converted action", async () => {
    const received: { args: { readonly sessionId: string; readonly action: unknown; readonly recordAction: boolean } | null } = { args: null }
    const deps: FlowExecutorDeps = {
      ...makeUnusedFlowExecutorDeps(),
      executeSessionAction: (args) => {
        received.args = args
        return Effect.succeed({
          ok: true as const,
          result: {
            summary: "verified tap",
            action: "tap",
            matchedRef: null,
            resolvedBy: "point" as const,
            statusLabel: "ok",
            latestSnapshotId: "snap-1",
            artifact: null,
            recordingLength: 0,
            handledMs: 10,
            retryCount: 0,
            retryReasons: [],
            verdict: null,
            waitedMs: null,
            polledCount: null,
            evidence: {
              requested: { success: "end", failure: "snapshot" },
              captures: [],
              evidenceMs: 0,
            },
          },
        })
      },
    }
    const step: FlowV2Step = { kind: "tap", target: { kind: "point", x: 1, y: 2 } } as never

    const outcome = await Effect.runPromise(
      executeVerifiedActionStep({ sessionId: "s1", step, deps }),
    )

    expect(received.args?.sessionId).toBe("s1")
    expect(received.args?.recordAction).toBe(false)
    expect(outcome.ok).toBe(true)
  })
})
