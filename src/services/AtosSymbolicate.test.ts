import { describe, expect, test } from "bun:test"
import { resolveAtosBinaryPath } from "./AtosSymbolicate"

describe("AtosSymbolicate", () => {
  test("resolveAtosBinaryPath prefers PROBE_PERF_BINARY then PROBE_ATOS_BINARY", () => {
    const prevPerf = process.env.PROBE_PERF_BINARY
    const prevAtos = process.env.PROBE_ATOS_BINARY
    try {
      delete process.env.PROBE_PERF_BINARY
      delete process.env.PROBE_ATOS_BINARY
      expect(resolveAtosBinaryPath()).toBeNull()

      process.env.PROBE_ATOS_BINARY = "/tmp/atos-bin"
      expect(resolveAtosBinaryPath()).toBe("/tmp/atos-bin")

      process.env.PROBE_PERF_BINARY = "/tmp/perf-bin"
      expect(resolveAtosBinaryPath()).toBe("/tmp/perf-bin")
    } finally {
      if (prevPerf === undefined) {
        delete process.env.PROBE_PERF_BINARY
      } else {
        process.env.PROBE_PERF_BINARY = prevPerf
      }
      if (prevAtos === undefined) {
        delete process.env.PROBE_ATOS_BINARY
      } else {
        process.env.PROBE_ATOS_BINARY = prevAtos
      }
    }
  })
})
