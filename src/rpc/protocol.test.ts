import { describe, expect, test } from "bun:test"
import { ProtocolMismatchError } from "../domain/errors"
import {
  decodeRpcFrame,
  decodeRpcFrameLine,
  decodeRpcRequest,
  decodeRpcRequestLine,
  encodeRpcLine,
  PROBE_PROTOCOL_VERSION,
} from "./protocol"

describe("rpc protocol", () => {
  test("decodes a session list request", () => {
    const request = decodeRpcRequest({
      kind: "request",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-list",
      method: "session.list",
      params: {},
    })

    expect(request.method).toBe("session.list")
  })

  test("decodes a session show request", () => {
    const request = decodeRpcRequest({
      kind: "request",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-show",
      method: "session.show",
      params: {
        sessionId: "session-1",
      },
    })

    expect(request.method).toBe("session.show")
  })

  test("decodes a session open request", () => {
    const request = decodeRpcRequest({
      kind: "request",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-1",
      method: "session.open",
      params: {
        target: "simulator",
        bundleId: "dev.probe.fixture",
        sessionMode: "attach-to-running",
        simulatorUdid: null,
        deviceId: null,
      },
    })

    expect(request.method).toBe("session.open")
  })

  test("decodes a session logs request", () => {
    const request = decodeRpcRequest({
      kind: "request",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-logs",
      method: "session.logs",
      params: {
        sessionId: "session-1",
        source: "runner",
        lineCount: 40,
        match: null,
        outputMode: "auto",
        captureSeconds: 2,
        predicate: null,
        process: null,
        subsystem: null,
        category: null,
      },
    })

    expect(request.method).toBe("session.logs")
  })

  test("decodes a session logs mark request", () => {
    const request = decodeRpcRequest({
      kind: "request",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-logs-mark",
      method: "session.logs.mark",
      params: {
        sessionId: "session-1",
        label: "before-submit",
      },
    })

    expect(request.method).toBe("session.logs.mark")
  })

  test("decodes a session logs capture request", () => {
    const request = decodeRpcRequest({
      kind: "request",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-logs-capture",
      method: "session.logs.capture",
      params: {
        sessionId: "session-1",
        captureSeconds: 3,
      },
    })

    expect(request.method).toBe("session.logs.capture")
  })

  test("decodes a session logs doctor request", () => {
    const request = decodeRpcRequest({
      kind: "request",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-logs-doctor",
      method: "session.logs.doctor",
      params: {
        sessionId: "session-1",
      },
    })

    expect(request.method).toBe("session.logs.doctor")
  })

  test("decodes a session diagnostic capture request", () => {
    const request = decodeRpcRequest({
      kind: "request",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-diagnostic-capture",
      method: "session.diagnostic.capture",
      params: {
        sessionId: "session-1",
        target: "device",
        kind: "sysdiagnose",
      },
    })

    expect(request.method).toBe("session.diagnostic.capture")
  })

  test("decodes a session snapshot request", () => {
    const request = decodeRpcRequest({
      kind: "request",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-snapshot",
      method: "session.snapshot",
      params: {
        sessionId: "session-1",
        outputMode: "auto",
      },
    })

    expect(request.method).toBe("session.snapshot")
  })

  test("decodes a session action request", () => {
    const request = decodeRpcRequest({
      kind: "request",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-action",
      method: "session.action",
      params: {
        sessionId: "session-1",
        action: {
          kind: "tap",
          target: {
            kind: "semantic",
            identifier: "fixture.form.applyButton",
            label: null,
            value: null,
            placeholder: null,
            type: "button",
            section: null,
            interactive: true,
          },
        },
      },
    })

    expect(request.method).toBe("session.action")
  })

  test("decodes a session run request", () => {
    const request = decodeRpcRequest({
      kind: "request",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-run",
      method: "session.run",
      params: {
        sessionId: "session-1",
        flow: {
          contract: "probe.session-flow/v1",
          steps: [
            {
              kind: "sleep",
              durationMs: 100,
            },
          ],
        },
      },
    })

    expect(request.method).toBe("session.run")
  })

  test("decodes a session video request", () => {
    const request = decodeRpcRequest({
      kind: "request",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-video",
      method: "session.video",
      params: {
        sessionId: "session-1",
        duration: "30s",
      },
    })

    expect(request.method).toBe("session.video")
  })

  test("decodes a perf record request", () => {
    const request = decodeRpcRequest({
      kind: "request",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-perf",
      method: "perf.record",
      params: {
        sessionId: "session-1",
        template: "time-profiler",
        timeLimit: "3s",
      },
    })

    expect(request.method).toBe("perf.record")
  })

  test("decodes a perf around request", () => {
    const request = decodeRpcRequest({
      kind: "request",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-perf-around",
      method: "perf.around",
      params: {
        sessionId: "session-1",
        template: "logging",
        flow: {
          contract: "probe.session-flow/v1",
          steps: [
            {
              kind: "sleep",
              durationMs: 250,
            },
          ],
        },
      },
    })

    expect(request.method).toBe("perf.around")
  })

  test("decodes a perf summarize request", () => {
    const request = decodeRpcRequest({
      kind: "request",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-perf-summarize",
      method: "perf.summarize",
      params: {
        sessionId: "session-1",
        artifactKey: "logging-trace",
        groupBy: "signpost",
      },
    })

    expect(request.method).toBe("perf.summarize")
  })

  test("decodes an xcresult artifact drill request", () => {
    const request = decodeRpcRequest({
      kind: "request",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-drill",
      method: "artifact.drill",
      params: {
        sessionId: "session-1",
        artifactKey: "result-bundle",
        outputMode: "inline",
        query: {
          kind: "xcresult",
          view: "attachments",
          attachmentId: "att-123",
        },
      },
    })

    expect(request.method).toBe("artifact.drill")
  })

  test("decodes a session result summary request", () => {
    const request = decodeRpcRequest({
      kind: "request",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-result-summary",
      method: "session.result.summary",
      params: {
        sessionId: "session-1",
      },
    })

    expect(request.method).toBe("session.result.summary")
  })

  test("decodes a session result attachments request", () => {
    const request = decodeRpcRequest({
      kind: "request",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-result-attachments",
      method: "session.result.attachments",
      params: {
        sessionId: "session-1",
      },
    })

    expect(request.method).toBe("session.result.attachments")
  })

  test("encodes and decodes a progress frame", () => {
    const line = encodeRpcLine({
      kind: "event",
      protocolVersion: PROBE_PROTOCOL_VERSION,
      requestId: "req-1",
      stage: "session.open",
      message: "Opening session",
    })

    const decoded = decodeRpcFrame(JSON.parse(line.trim()))
    expect(decoded.kind).toBe("event")
    expect(decoded.protocolVersion).toBe(PROBE_PROTOCOL_VERSION)
  })

  test("detects request protocol mismatches before schema validation", () => {
    const decoded = decodeRpcRequestLine(
      JSON.stringify({
        kind: "request",
        protocolVersion: "probe-rpc/v2",
        requestId: "req-mismatch",
        method: "session.open",
        params: {
          target: "simulator",
          bundleId: "dev.probe.fixture",
          sessionMode: "build-and-install",
          simulatorUdid: null,
          deviceId: null,
        },
      }),
    )

    expect(decoded.kind).toBe("protocol-mismatch")

    if (decoded.kind === "protocol-mismatch") {
      expect(decoded.requestId).toBe("req-mismatch")
      expect(decoded.method).toBe("session.open")
      expect(decoded.receivedVersion).toBe("probe-rpc/v2")
    }
  })

  test("throws a typed protocol mismatch for response frames", () => {
    expect(() =>
      decodeRpcFrameLine(
        JSON.stringify({
          kind: "failure",
          protocolVersion: "probe-rpc/v2",
          requestId: "req-1",
          method: "daemon.ping",
          failure: {
            code: "protocol-mismatch",
            category: "protocol",
            reason: "mismatch",
            nextStep: "upgrade",
            details: [],
            capability: null,
            expectedVersion: PROBE_PROTOCOL_VERSION,
            receivedVersion: "probe-rpc/v2",
            command: null,
            exitCode: null,
            sessionId: null,
            artifactKey: null,
            wall: false,
          },
        }),
      )).toThrow(ProtocolMismatchError)
  })
})
