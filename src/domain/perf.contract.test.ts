import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  analyzeMetalSystemTraceTable,
  analyzeSystemTraceTables,
  analyzeTimeProfilerTable,
  parsePerfTableExport,
} from "./perf"

const loadFixture = (name: string) =>
  readFileSync(join(import.meta.dir, "..", "test-fixtures", "perf", name), "utf8")

describe("perf export contract fixtures", () => {
  test("parses the real time-profiler columns Probe currently consumes", () => {
    const table = parsePerfTableExport(loadFixture("time-profiler.time-sample.xml"))
    const analysis = analyzeTimeProfilerTable(table)

    expect(table.schema).toBe("time-sample")
    expect(table.mnemonics).toEqual(expect.arrayContaining([
      "time",
      "thread",
      "core-index",
      "thread-state",
      "cp-user-callstack",
      "sample-type",
    ]))
    expect(table.rows).toHaveLength(5)
    expect(table.rows[0]?.thread?.raw).toBe("45472")
    expect(table.rows[0]?.thread?.display).toContain("ProbeFixture")
    expect(table.rows[0]?.["cp-user-callstack"]?.display).toContain("14 frames")
    expect(analysis.summary.headline).toContain("Collected 5 CPU samples")
    expect(analysis.diagnoses.some((diagnosis) => diagnosis.code === "time-profiler-mostly-blocked")).toBe(true)
  })

  test("fails closed when real system-trace excerpts contain no target-attributed rows", () => {
    const threadStateTable = parsePerfTableExport(loadFixture("system-trace.thread-state.no-target.xml"))
    const cpuStateTable = parsePerfTableExport(loadFixture("system-trace.cpu-state.no-target.xml"))
    const analysis = analyzeSystemTraceTables({
      threadStateTable,
      cpuStateTable,
      targetPid: 45472,
    })

    expect(threadStateTable.mnemonics).toEqual(expect.arrayContaining(["thread", "state", "process", "cputime", "waittime"]))
    expect(cpuStateTable.mnemonics).toEqual(expect.arrayContaining(["cpu", "state", "process", "thread"]))
    expect(analysis.summary.headline).toBe("No target-attributed System Trace rows were exported for pid 45472.")
    expect(analysis.diagnoses.some((diagnosis) => diagnosis.code === "system-trace-no-target-thread-rows")).toBe(true)
  })

  test("parses the fuller metal schema while keeping assertions on Probe-consumed fields", () => {
    const table = parsePerfTableExport(loadFixture("metal-system-trace.metal-gpu-intervals.xml"))
    const analysis = analyzeMetalSystemTraceTable(table)

    expect(table.schema).toBe("metal-gpu-intervals")
    expect(table.mnemonics).toEqual(expect.arrayContaining([
      "channel-name",
      "frame-number",
      "start-latency",
      "event-depth",
      "event-label",
      "process",
      "gpu",
      "channel-subtitle",
      "iosurface-accesses",
      "bytes",
      "cmdbuffer-id",
      "encoder-id",
      "gpu-submission-id",
    ]))
    expect(table.rows[0]?.process?.display).toBe("WindowServer (181)")
    expect(table.rows[0]?.["start-latency"]?.raw).toBe("1117250")
    expect(table.rows[1]?.["channel-name"]?.display).toBe("Compute")
    expect(analysis.summary.headline).toContain("Observed 2 Metal GPU intervals")
    expect(analysis.diagnoses.some((diagnosis) => diagnosis.code === "metal-per-shader-wall")).toBe(true)
  })

  test("throws a focused contract error when a consumed metal column disappears", () => {
    const driftedFixture = loadFixture("metal-system-trace.metal-gpu-intervals.xml").replace(
      '<col><mnemonic>start-latency</mnemonic><name>CPU to GPU Latency</name><engineering-type>duration</engineering-type></col>',
      "",
    )

    expect(() => analyzeMetalSystemTraceTable(parsePerfTableExport(driftedFixture))).toThrow(
      /xctrace schema metal-gpu-intervals is missing required columns: start-latency/,
    )
  })
})
