import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  decodeRunnerBootstrapManifest,
  decodeRunnerCommandFrame,
  decodeRunnerReadyFrame,
  decodeRunnerResponseFrame,
  decodeRunnerStdinProbeResultFrame,
  encodeRunnerCommandFrame,
  RUNNER_TRANSPORT_CONTRACT,
} from "./runnerProtocol"

const loadFixture = <T>(...segments: Array<string>): T =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "test-fixtures", ...segments), "utf8")) as T

const transportBoundarySpike = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "knowledge", "xcuitest-runner", "transport-boundary-spike-results.json"), "utf8"),
) as {
  readonly ready: {
    readonly stdoutReadyEvent: unknown
  }
  readonly stdinProbe: unknown
}

describe("runner protocol", () => {
  test("decodes the bootstrap manifest Probe writes for simulator sessions", () => {
    const manifest = decodeRunnerBootstrapManifest(loadFixture("runner", "bootstrap-manifest.json"))

    expect(manifest.contractVersion).toBe(RUNNER_TRANSPORT_CONTRACT)
    expect(manifest.ingressTransport).toBe("file-mailbox")
    expect(manifest.egressTransport).toBe("stdout-jsonl-mixed-log")
  })

  test("decodes a real ready frame from the validated transport-boundary artifact", () => {
    const ready = decodeRunnerReadyFrame(transportBoundarySpike.ready.stdoutReadyEvent)

    expect(ready.kind).toBe("ready")
    expect(ready.runnerTransportContract).toBe(RUNNER_TRANSPORT_CONTRACT)
    expect(ready.bootstrapSource).toBe("simulator-bootstrap-manifest")
    expect(ready.ingressTransport).toBe("file-mailbox")
    expect(ready.egressTransport).toBe("stdout-jsonl-mixed-log")
  })

  test("decodes the snapshot response shape Probe consumes from local runner output", () => {
    const response = decodeRunnerResponseFrame(loadFixture("runner", "response-snapshot.json"))

    expect(response.action).toBe("snapshot")
    expect(response.snapshotPayloadPath).toContain("snapshot-002.json")
    expect(response.snapshotNodeCount).toBe(94)
    expect(response.payload).toBe("snapshot-captured")
  })

  test("decodes the stdin probe timeout Probe records for honest transport reporting", () => {
    const stdinProbe = decodeRunnerStdinProbeResultFrame(transportBoundarySpike.stdinProbe)

    expect(stdinProbe.kind).toBe("stdin-probe-result")
    expect(stdinProbe.status).toBe("timeout")
  })

  test("encodes command frames without leaving payload normalization implicit", () => {
    const encoded = encodeRunnerCommandFrame({
      sequence: 7,
      action: "uiAction",
      payload: '{"kind":"tap"}',
    })

    const decoded = decodeRunnerCommandFrame(JSON.parse(encoded))
    expect(decoded).toEqual({
      sequence: 7,
      action: "uiAction",
      payload: '{"kind":"tap"}',
    })
  })

  test("fails with a focused error when a ready frame loses session identity", () => {
    const broken = structuredClone(transportBoundarySpike.ready.stdoutReadyEvent) as Record<string, unknown>
    delete broken.sessionIdentifier

    expect(() => decodeRunnerReadyFrame(broken)).toThrow(/Invalid runner ready frame:.*sessionIdentifier/)
  })
})
