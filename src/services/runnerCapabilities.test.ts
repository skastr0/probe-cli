import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  advertisedRunnerCapabilities,
  formatAdvertisedCapabilities,
  requireRunnerCapability,
  resolveAdvertisedCapabilities,
  RUNNER_CAPABILITY_REGISTRY,
  runnerCapabilityRegistryEntry,
} from "./runnerCapabilities"

interface FakeRunnerBackedRecord {
  readonly kind: "runner-backed"
  readonly capabilities: ReadonlyArray<"uiAction" | "uiActionBatch">
}

interface FakeNotBackedRecord {
  readonly kind: "not-backed"
}

type FakeRecord = FakeRunnerBackedRecord | FakeNotBackedRecord

const isFakeRunnerBacked = (record: FakeRecord): record is FakeRunnerBackedRecord => record.kind === "runner-backed"

const gateArgs = (record: FakeRecord, capability: "uiAction" | "uiActionBatch") => ({
  record,
  isRunnerBacked: isFakeRunnerBacked,
  advertised: (backed: FakeRunnerBackedRecord) => backed.capabilities,
  capability,
  capabilityTag: "session.run.fast",
  usageDescription: "fast single-step flow execution",
  notRunnerBacked: {
    code: "session-action-real-device-runner",
    reason: "This session does not currently expose a live runner transport for fast flow actions.",
    nextStep: "Inspect session health/artifacts, or reopen the session once the runner transport is live.",
  },
  missingCapabilityNextStep: "Open a session against a runner that reports uiAction capability, or switch the flow step back to verified execution.",
})

describe("RUNNER_CAPABILITY_REGISTRY", () => {
  test("has exactly one entry per capability, matching production Swift truth", () => {
    const capabilities = RUNNER_CAPABILITY_REGISTRY.map((entry) => entry.capability)
    expect(new Set(capabilities).size).toBe(capabilities.length)

    // PRB-072/PRB-092: both uiAction and uiActionBatch are implemented
    // (handleLifecycleCommand has case "uiAction" and case "uiActionBatch")
    // and boundary-tested against a live Simulator session — see
    // RUNNER_CAPABILITY_REGISTRY's evidence strings.
    expect(runnerCapabilityRegistryEntry("uiAction").implementedInSwift).toBe(true)
    expect(runnerCapabilityRegistryEntry("uiActionBatch").implementedInSwift).toBe(true)
  })

  test("throws for a capability with no registry entry, instead of silently allowing it", () => {
    expect(() => runnerCapabilityRegistryEntry("not-a-real-capability" as never)).toThrow(
      /No RUNNER_CAPABILITY_REGISTRY entry/,
    )
  })
})

describe("resolveAdvertisedCapabilities / advertisedRunnerCapabilities", () => {
  test("never upgrades a missing capabilities field to an assumed default", () => {
    expect(resolveAdvertisedCapabilities({})).toEqual([])
    expect(resolveAdvertisedCapabilities({ capabilities: undefined })).toEqual([])
  })

  test("passes through an explicitly advertised capability list", () => {
    expect(resolveAdvertisedCapabilities({ capabilities: ["uiAction"] })).toEqual(["uiAction"])
  })

  test("treats a non-live runner as advertising nothing", () => {
    expect(advertisedRunnerCapabilities({ kind: "real-device-preflight" } as never)).toEqual([])
  })
})

describe("formatAdvertisedCapabilities", () => {
  test("renders an empty set as none", () => {
    expect(formatAdvertisedCapabilities([])).toBe("none")
  })

  test("joins a populated set", () => {
    expect(formatAdvertisedCapabilities(["uiAction", "uiActionBatch"])).toBe("uiAction, uiActionBatch")
  })
})

describe("requireRunnerCapability", () => {
  test("happy path: succeeds and returns the narrowed runner-backed record", async () => {
    const record: FakeRecord = { kind: "runner-backed", capabilities: ["uiAction"] }

    const result = await Effect.runPromise(requireRunnerCapability(gateArgs(record, "uiAction")))

    expect(result).toBe(record)
  })

  test("non-live-runner: fails closed with the not-runner-backed error, naming no capability list", async () => {
    const record: FakeRecord = { kind: "not-backed" }

    const error = await Effect.runPromise(
      Effect.flip(requireRunnerCapability(gateArgs(record, "uiAction"))),
    )

    expect(error.code).toBe("session-action-real-device-runner")
    expect(error.capability).toBe("session.run.fast")
    expect(error.reason).toContain("does not currently expose a live runner transport")
    expect(error.details).toEqual([])
  })

  test("missing capability: fails closed naming the required capability and the runner's actual set", async () => {
    const record: FakeRecord = { kind: "runner-backed", capabilities: ["uiAction"] }

    const error = await Effect.runPromise(
      Effect.flip(requireRunnerCapability(gateArgs(record, "uiActionBatch"))),
    )

    expect(error.code).toBe("session-runner-capability-ui-action-batch")
    expect(error.capability).toBe("session.run.fast")
    expect(error.reason).toBe(
      "The connected runner does not advertise uiActionBatch support required for fast single-step flow execution.",
    )
    expect(error.details).toEqual([
      "required capability: uiActionBatch",
      "runner capabilities: uiAction",
    ])
    expect(error.nextStep).toBe(
      "Open a session against a runner that reports uiAction capability, or switch the flow step back to verified execution.",
    )
  })

  test("missing capability against a runner that advertises nothing describes the set as none", async () => {
    const record: FakeRecord = { kind: "runner-backed", capabilities: [] }

    const error = await Effect.runPromise(
      Effect.flip(requireRunnerCapability(gateArgs(record, "uiAction"))),
    )

    expect(error.details).toEqual([
      "required capability: uiAction",
      "runner capabilities: none",
    ])
  })
})
