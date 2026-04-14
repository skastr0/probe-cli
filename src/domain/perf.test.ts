import { describe, expect, test } from "bun:test"
import {
  analyzeSignpostIntervalTable,
  defaultPerfTimeLimitForTemplate,
  analyzeMetalSystemTraceTable,
  analyzeSystemTraceTables,
  analyzeTimeProfilerTable,
  parsePerfTableExport,
  summarizeSignpostIntervalsTable,
} from "./perf"

const timeProfilerXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[1]'>
    <schema name="time-sample">
      <col><mnemonic>time</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
      <col><mnemonic>core-index</mnemonic></col>
      <col><mnemonic>thread-state</mnemonic></col>
      <col><mnemonic>cp-user-callstack</mnemonic></col>
      <col><mnemonic>sample-type</mnemonic></col>
    </schema>
    <row><sample-time id="1" fmt="00:00.100.000">100000000</sample-time><thread id="2" fmt="Main Thread 0x1 (ProbeFixture, pid: 111)"><tid id="3">1</tid></thread><sentinel/><thread-state id="4" fmt="Blocked">Blocked</thread-state><kperf-bt id="5" fmt="PC:0x1, 4 frames">1</kperf-bt><time-sample-kind id="6" fmt="Stackshot">3</time-sample-kind></row>
    <row><sample-time ref="1"/><thread ref="2"/><core id="7" fmt="CPU 3">3</core><thread-state ref="4"/><kperf-bt ref="5"/><time-sample-kind ref="6"/></row>
  </node>
</trace-query-result>`

const systemThreadXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[1]'>
    <schema name="thread-state">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
      <col><mnemonic>state</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
      <col><mnemonic>core</mnemonic></col>
      <col><mnemonic>cputime</mnemonic></col>
      <col><mnemonic>waittime</mnemonic></col>
      <col><mnemonic>priority</mnemonic></col>
      <col><mnemonic>note</mnemonic></col>
      <col><mnemonic>summary</mnemonic></col>
    </schema>
    <row><start-time id="1" fmt="00:00.000.000">0</start-time><thread id="2" fmt="Main Thread 0x1 (ProbeFixture, pid: 111)"><tid id="3">1</tid></thread><thread-state id="4" fmt="Blocked">Blocked</thread-state><duration id="5" fmt="3.00 µs">3000</duration><process id="6" fmt="ProbeFixture (111)"><pid id="7">111</pid></process><sentinel/><duration id="8" fmt="100 ns">100</duration><duration id="9" fmt="2.50 µs">2500</duration><sched-priority id="10" fmt="31">31</sched-priority><sentinel/><sentinel/></row>
    <row><start-time ref="1"/><thread ref="2"/><thread-state id="11" fmt="Running">Running</thread-state><duration id="12" fmt="1.00 µs">1000</duration><process ref="6"/><sentinel/><duration id="13" fmt="800 ns">800</duration><duration id="14" fmt="0 ns">0</duration><sched-priority ref="10"/><sentinel/><sentinel/></row>
    <row><start-time ref="1"/><thread id="15" fmt="Main Thread 0x2 (OtherApp, pid: 222)"><tid id="16">2</tid></thread><thread-state ref="11"/><duration id="17" fmt="5.00 µs">5000</duration><process id="18" fmt="OtherApp (222)"><pid id="19">222</pid></process><sentinel/><duration id="20" fmt="5000 ns">5000</duration><duration id="21" fmt="0 ns">0</duration><sched-priority ref="10"/><sentinel/><sentinel/></row>
  </node>
</trace-query-result>`

const systemCpuXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[2]'>
    <schema name="cpu-state">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>cpu</mnemonic></col>
      <col><mnemonic>state</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
      <col><mnemonic>priority</mnemonic></col>
    </schema>
    <row><start-time id="1" fmt="00:00.000.000">0</start-time><core id="2" fmt="CPU 3">3</core><core-state id="3" fmt="Running">Running</core-state><duration id="4" fmt="1.00 µs">1000</duration><process id="5" fmt="ProbeFixture (111)"><pid id="6">111</pid></process><thread id="7" fmt="Main Thread 0x1 (ProbeFixture, pid: 111)"><tid id="8">1</tid></thread><sched-priority id="9" fmt="31">31</sched-priority></row>
    <row><start-time ref="1"/><core id="10" fmt="CPU 5">5</core><core-state id="11" fmt="Idle">Idle</core-state><duration id="12" fmt="1.00 µs">1000</duration><process id="13" fmt="OtherApp (222)"><pid id="14">222</pid></process><thread id="15" fmt="Main Thread 0x2 (OtherApp, pid: 222)"><tid id="16">2</tid></thread><sched-priority ref="9"/></row>
  </node>
</trace-query-result>`

const systemThreadOnlyXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[1]'>
    <schema name="thread-state">
      <col><mnemonic>thread</mnemonic></col>
      <col><mnemonic>state</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
      <col><mnemonic>cputime</mnemonic></col>
      <col><mnemonic>waittime</mnemonic></col>
    </schema>
    <row><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 123)"><tid>1</tid></thread><thread-state fmt="Running">Running</thread-state><process fmt="ProbeFixture (123)"><pid>123</pid></process><thread-cpu-time fmt="1.00 ms">1000000</thread-cpu-time><thread-wait-time fmt="0.50 ms">500000</thread-wait-time></row>
  </node>
</trace-query-result>`

const buildLargeSystemCpuXml = (rowCount: number) => {
  if (rowCount < 2) {
    throw new Error("rowCount must be at least 2")
  }

  const repeatedBackgroundRows = Array.from({ length: rowCount - 2 }, () =>
    "<row><start-time ref=\"10\"/><core ref=\"11\"/><core-state ref=\"12\"/><duration ref=\"13\"/><process ref=\"14\"/><thread ref=\"16\"/><sched-priority ref=\"18\"/></row>",
  ).join("")

  return `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[2]'>
    <schema name="cpu-state">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>cpu</mnemonic></col>
      <col><mnemonic>state</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
      <col><mnemonic>priority</mnemonic></col>
    </schema>
    <row><start-time id="1" fmt="00:00.000.000">0</start-time><core id="2" fmt="CPU 3">3</core><core-state id="3" fmt="Running">Running</core-state><duration id="4" fmt="1.00 µs">1000</duration><process id="5" fmt="ProbeFixture (111)"><pid id="6">111</pid></process><thread id="7" fmt="Main Thread 0x1 (ProbeFixture, pid: 111)"><tid id="8">1</tid></thread><sched-priority id="9" fmt="31">31</sched-priority></row>
    <row><start-time id="10" fmt="00:00.001.000">1000</start-time><core id="11" fmt="CPU 5">5</core><core-state id="12" fmt="Idle">Idle</core-state><duration id="13" fmt="1.00 µs">1000</duration><process id="14" fmt="OtherApp (222)"><pid id="15">222</pid></process><thread id="16" fmt="Main Thread 0x2 (OtherApp, pid: 222)"><tid id="17">2</tid></thread><sched-priority id="18" fmt="31">31</sched-priority></row>${repeatedBackgroundRows}
  </node>
</trace-query-result>`
}

const metalXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[3]'>
    <schema name="metal-gpu-intervals">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>channel-name</mnemonic></col>
      <col><mnemonic>frame-number</mnemonic></col>
      <col><mnemonic>start-latency</mnemonic></col>
      <col><mnemonic>state</mnemonic></col>
    </schema>
    <row><start-time id="1" fmt="00:00.410.750">410750625</start-time><duration id="2" fmt="20.00 ms">20000000</duration><gpu-channel-name id="3" fmt="Fragment">Fragment</gpu-channel-name><gpu-frame-number id="4" fmt="Frame 0">0</gpu-frame-number><duration id="5" fmt="17.00 ms">17000000</duration><gpu-state id="6" fmt="Active">Active</gpu-state></row>
  </node>
</trace-query-result>`

const signpostXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[1]'>
    <schema name="os-signpost-interval">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>name</mnemonic></col>
    </schema>
    <row><start-time fmt="00:00.000.000">0</start-time><duration fmt="10.00 ms">10000000</duration><name fmt="loadData">loadData</name></row>
    <row><start-time fmt="00:00.020.000">20000000</start-time><duration fmt="20.00 ms">20000000</duration><name fmt="loadData">loadData</name></row>
    <row><start-time fmt="00:00.050.000">50000000</start-time><duration fmt="5.00 ms">5000000</duration><name fmt="renderFrame">renderFrame</name></row>
  </node>
</trace-query-result>`

describe("perf export parsing", () => {
  test("resolves refs and sentinels from xctrace export rows", () => {
    const table = parsePerfTableExport(timeProfilerXml)

    expect(table.schema).toBe("time-sample")
    expect(table.rows).toHaveLength(2)
    expect(table.rows[0]?.thread?.display).toContain("ProbeFixture")
    expect(table.rows[0]?.thread?.raw).toBe("1")
    expect(table.rows[1]?.time?.raw).toBe("100000000")
    expect(table.rows[1]?.["thread-state"]?.display).toBe("Blocked")
    expect(table.rows[1]?.["core-index"]?.raw).toBe("3")
  })
})

describe("perf analysis", () => {
  test("uses the longer default time limit for metal traces", () => {
    expect(defaultPerfTimeLimitForTemplate("metal-system-trace")).toBe("60s")
  })

  test("uses the default short time limit for logging traces", () => {
    expect(defaultPerfTimeLimitForTemplate("logging")).toBe("3s")
  })

  test("time profiler analysis flags blocked-heavy traces and preserves walls", () => {
    const result = analyzeTimeProfilerTable(parsePerfTableExport(timeProfilerXml))

    expect(result.summary.headline).toContain("Collected 2 CPU samples")
    expect(result.diagnoses.some((diagnosis) => diagnosis.code === "time-profiler-mostly-blocked")).toBe(true)
    expect(result.diagnoses.some((diagnosis) => diagnosis.wall)).toBe(true)
  })

  test("system trace analysis filters rows to the target pid", () => {
    const threadTable = parsePerfTableExport(systemThreadXml)
    const cpuTable = parsePerfTableExport(systemCpuXml)
    const result = analyzeSystemTraceTables({
      threadStateTable: threadTable,
      cpuStateTable: cpuTable,
      targetPid: 111,
    })

    expect(threadTable.rows[0]?.process?.raw).toBe("111")
    expect(result.summary.headline).toContain("2 target thread intervals")
    expect(result.summary.metrics.find((metric) => metric.label === "Target CPU intervals")?.value).toBe("1")
    expect(result.diagnoses.some((diagnosis) => diagnosis.code === "system-trace-wait-heavy")).toBe(true)
    expect(result.diagnoses.some((diagnosis) => diagnosis.wall)).toBe(true)
  })

  test("system trace analysis handles a missing cpu-state table", () => {
    const result = analyzeSystemTraceTables({
      threadStateTable: parsePerfTableExport(systemThreadOnlyXml),
      targetPid: 123,
    })

    expect(result.summary.headline).toContain("1 target thread intervals")
    expect(result.summary.metrics.find((metric) => metric.label === "Target CPU intervals")?.value).toBe("0")
    expect(result.summary.metrics.find((metric) => metric.label === "Busy cores")?.value).toBe("none")
  })

  test("system trace analysis explains large device-wide cpu-state exports", () => {
    const result = analyzeSystemTraceTables({
      threadStateTable: parsePerfTableExport(systemThreadXml),
      cpuStateTable: parsePerfTableExport(buildLargeSystemCpuXml(20_001)),
      targetPid: 111,
    })

    const diagnosis = result.diagnoses.find((entry) => entry.code === "system-trace-large-cpu-state")

    expect(diagnosis).toBeTruthy()
    expect(diagnosis?.details[0]).toContain("20001 cpu-state rows were exported")
    expect(diagnosis?.details[1]).toContain("full export must be budgeted for the entire device")
  })

  test("metal analysis flags frame-budget overruns", () => {
    const result = analyzeMetalSystemTraceTable(parsePerfTableExport(metalXml))

    expect(result.summary.headline).toContain("Observed 1 Metal GPU intervals")
    expect(result.summary.metrics.find((metric) => metric.label === "Estimated FPS")?.value).toBe("50.0 fps")
    expect(result.diagnoses.some((diagnosis) => diagnosis.code === "metal-frame-budget-duration")).toBe(true)
    expect(result.diagnoses.some((diagnosis) => diagnosis.code === "metal-frame-budget-latency")).toBe(true)
    expect(result.diagnoses.some((diagnosis) => diagnosis.code === "metal-gpu-counters-required")).toBe(true)
  })

  test("summarizes signpost intervals by interval name", () => {
    const groups = summarizeSignpostIntervalsTable(parsePerfTableExport(signpostXml))

    expect(groups).toEqual([
      {
        intervalName: "loadData",
        count: 2,
        minDurationNs: 10_000_000,
        maxDurationNs: 20_000_000,
        avgDurationNs: 15_000_000,
        wallTimeNs: 30_000_000,
      },
      {
        intervalName: "renderFrame",
        count: 1,
        minDurationNs: 5_000_000,
        maxDurationNs: 5_000_000,
        avgDurationNs: 5_000_000,
        wallTimeNs: 5_000_000,
      },
    ])

    const analysis = analyzeSignpostIntervalTable(parsePerfTableExport(signpostXml))
    expect(analysis.summary.headline).toContain("Observed 3 signpost intervals")
    expect(analysis.summary.metrics.find((metric) => metric.label === "Top interval")?.value).toContain("loadData")
  })
})
