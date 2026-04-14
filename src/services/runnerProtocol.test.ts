import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  decodeRunnerBootstrapManifest,
  decodeRunnerCommandFrame,
  decodeRunnerReadyFrame,
  decodeRunnerResponseFrame,
  encodeRunnerCommandFrame,
  RUNNER_HTTP_COMMAND_INGRESS,
  RUNNER_TRANSPORT_CONTRACT,
} from "./runnerProtocol"

const loadFixture = <T>(...segments: Array<string>): T =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "test-fixtures", ...segments), "utf8")) as T

const makeSimulatorReadyFrame = (): Record<string, unknown> => ({
  kind: "ready",
  attachLatencyMs: 21,
  bootstrapPath: "/tmp/probe-runner-bootstrap/SIM-1.json",
  bootstrapSource: "simulator-bootstrap-manifest",
  controlDirectoryPath: "/tmp/probe-runtime/session-1",
  currentDirectoryPath: "/",
  egressTransport: "stdout-jsonl-mixed-log",
  homeDirectoryPath: "/Users/test/Library/Developer/CoreSimulator/Devices/SIM-1/data",
  ingressTransport: RUNNER_HTTP_COMMAND_INGRESS,
  initialStatusLabel: "Ready",
  processIdentifier: 551,
  recordedAt: "2026-04-14T00:00:00.000Z",
  runnerPort: 41041,
  runnerTransportContract: RUNNER_TRANSPORT_CONTRACT,
  sessionIdentifier: "session-1",
  simulatorUdid: "SIM-1",
})

describe("runner protocol", () => {
  test("decodes the bootstrap manifest Probe writes for simulator sessions", () => {
    const manifest = decodeRunnerBootstrapManifest(loadFixture("runner", "bootstrap-manifest.json"))

    expect(manifest.contractVersion).toBe(RUNNER_TRANSPORT_CONTRACT)
    expect(manifest.ingressTransport).toBe(RUNNER_HTTP_COMMAND_INGRESS)
    expect(manifest.egressTransport).toBe("stdout-jsonl-mixed-log")
    expect(manifest.targetBundleId).toBe("dev.probe.fixture")
  })

  test("fails with a focused error when a bootstrap manifest loses target bundle identity", () => {
    const broken = structuredClone(loadFixture<Record<string, unknown>>("runner", "bootstrap-manifest.json"))
    delete broken.targetBundleId

    expect(() => decodeRunnerBootstrapManifest(broken)).toThrow(/Invalid runner bootstrap manifest:.*targetBundleId/)
  })

  test("decodes the simulator-ready extension Probe uses for HTTP control", () => {
    const ready = decodeRunnerReadyFrame(makeSimulatorReadyFrame())

    expect(ready.kind).toBe("ready")
    expect(ready.runnerTransportContract).toBe(RUNNER_TRANSPORT_CONTRACT)
    expect(ready.bootstrapSource).toBe("simulator-bootstrap-manifest")
    expect(ready.ingressTransport).toBe(RUNNER_HTTP_COMMAND_INGRESS)
    expect(ready.egressTransport).toBe("stdout-jsonl-mixed-log")
    expect(ready.runnerPort).toBe(41041)
  })

  test("decodes the snapshot response shape Probe consumes from local runner output", () => {
    const response = decodeRunnerResponseFrame(loadFixture("runner", "response-snapshot.json"))

    expect(response.action).toBe("snapshot")
    expect(response.snapshotPayloadPath).toContain("snapshot-002.json")
    expect(response.snapshotNodeCount).toBe(94)
    expect(response.payload).toBe("snapshot-captured")
  })

  test("rejects legacy simulator ready frames that still claim file-mailbox ingress", () => {
    const legacyReadyFrame = {
      ...makeSimulatorReadyFrame(),
      ingressTransport: "file-mailbox",
    }

    expect(() => decodeRunnerReadyFrame(legacyReadyFrame)).toThrow(/Invalid runner ready frame:.*ingressTransport/)
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
    const broken = structuredClone(makeSimulatorReadyFrame())
    delete broken.sessionIdentifier

    expect(() => decodeRunnerReadyFrame(broken)).toThrow(/Invalid runner ready frame:.*sessionIdentifier/)
  })

  test("decodes the device-ready extension Probe uses for HTTP control", () => {
    const ready = decodeRunnerReadyFrame({
      kind: "ready",
      attachLatencyMs: 12,
      bootstrapPath: "env:PROBE_BOOTSTRAP_JSON",
      bootstrapSource: "device-bootstrap-manifest",
      controlDirectoryPath: "/private/var/mobile/Containers/Data/Application/example/tmp/probe-runtime-session-1",
      currentDirectoryPath: "/",
      egressTransport: "stdout-jsonl-mixed-log",
      homeDirectoryPath: "/private/var/mobile/Containers/Data/Application/example",
      ingressTransport: RUNNER_HTTP_COMMAND_INGRESS,
      initialStatusLabel: "",
      processIdentifier: 4402,
      recordedAt: "2026-04-11T00:00:00.000Z",
      runnerPort: 43123,
      runnerTransportContract: RUNNER_TRANSPORT_CONTRACT,
      sessionIdentifier: "session-1",
      simulatorUdid: "device-1",
    })

    expect(ready.bootstrapSource).toBe("device-bootstrap-manifest")
    expect(ready.ingressTransport).toBe(RUNNER_HTTP_COMMAND_INGRESS)
    expect(ready.runnerPort).toBe(43123)
  })

})
