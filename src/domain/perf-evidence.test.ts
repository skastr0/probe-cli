import { describe, expect, test } from "bun:test"
import { parsePerfTableExport, type ParsedPerfTable } from "./perf"
import {
  buildEvidenceReport,
  buildPhaseWindows,
  buildThermalChannel,
  compareEvidenceReports,
  type PerfEvidenceChannelTables,
  type PerfEvidenceProvenance,
} from "./perf-evidence"

// Fixtures below follow the same inline-XML style as perf.test.ts /
// perf.hangs.test.ts -- real xctrace export shapes, hand-authored for
// determinism, not captured from a live recording. The
// device-thermal-state-intervals column set is exactly what
// knowledge/xctrace-instruments/thermal-state-findings.md §1 validated
// empirically against a real xctrace export on this host.

const cpuSamplesXml = `<?xml version="1.0"?>
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
    <row><sample-time id="1" fmt="00:00.100.000">100000000</sample-time><thread id="2" fmt="Main Thread 0x1 (ProbeFixture, pid: 111)"><tid id="3">1</tid></thread><core id="4" fmt="CPU 1">1</core><thread-state id="5" fmt="Running">Running</thread-state><kperf-bt id="6" fmt="PC:0x1, 4 frames">1</kperf-bt><time-sample-kind id="7" fmt="Stackshot">3</time-sample-kind></row>
    <row><sample-time id="8" fmt="00:00.200.000">200000000</sample-time><thread ref="2"/><core ref="4"/><thread-state ref="5"/><kperf-bt ref="6"/><time-sample-kind ref="7"/></row>
  </node>
</trace-query-result>`

const threadStateXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[2]'>
    <schema name="thread-state">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
      <col><mnemonic>state</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
      <col><mnemonic>cputime</mnemonic></col>
      <col><mnemonic>waittime</mnemonic></col>
    </schema>
    <row><start-time id="1" fmt="00:00.000.000">0</start-time><thread id="2" fmt="Main Thread 0x1 (ProbeFixture, pid: 111)"><tid id="3">1</tid></thread><thread-state id="4" fmt="Blocked">Blocked</thread-state><duration id="5" fmt="3.00 ms">3000000</duration><process id="6" fmt="ProbeFixture (111)"><pid id="7">111</pid></process><duration id="8" fmt="1.00 ms">1000000</duration><duration id="9" fmt="2.00 ms">2000000</duration></row>
    <row><start-time ref="1"/><thread ref="2"/><thread-state id="10" fmt="Running">Running</thread-state><duration id="11" fmt="1.00 ms">1000000</duration><process ref="6"/><duration id="12" fmt="1.00 ms">1000000</duration><duration id="13" fmt="0 ns">0</duration></row>
  </node>
</trace-query-result>`

const hangsXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[3]'>
    <schema name="potential-hangs">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>hang-type</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
    </schema>
    <row><start-time fmt="00:00.050.000">50000000</start-time><duration fmt="200.00 ms">200000000</duration><hang-type fmt="Main Run Loop Unresponsive">Main Run Loop Unresponsive</hang-type><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 111)"><tid>1</tid></thread><process fmt="ProbeFixture (111)"><pid>111</pid></process></row>
  </node>
</trace-query-result>`

const gpuIntervalsXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[4]'>
    <schema name="metal-gpu-intervals">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>channel-name</mnemonic></col>
      <col><mnemonic>frame-number</mnemonic></col>
      <col><mnemonic>start-latency</mnemonic></col>
      <col><mnemonic>state</mnemonic></col>
    </schema>
    <row><start-time id="1" fmt="00:00.010.000">10000000</start-time><duration id="2" fmt="8.00 ms">8000000</duration><gpu-channel-name id="3" fmt="Fragment">Fragment</gpu-channel-name><gpu-frame-number id="4" fmt="Frame 0">0</gpu-frame-number><duration id="5" fmt="1.00 ms">1000000</duration><gpu-state id="6" fmt="Active">Active</gpu-state></row>
    <row><start-time id="7" fmt="00:00.026.000">26000000</start-time><duration id="8" fmt="9.00 ms">9000000</duration><gpu-channel-name ref="3"/><gpu-frame-number id="9" fmt="Frame 1">1</gpu-frame-number><duration id="10" fmt="1.00 ms">1000000</duration><gpu-state ref="6"/></row>
  </node>
</trace-query-result>`

const signpostXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[5]'>
    <schema name="os-signpost-interval">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>name</mnemonic></col>
    </schema>
    <row><start-time fmt="00:00.000.000">0</start-time><duration fmt="50.00 ms">50000000</duration><name fmt="setup">setup</name></row>
    <row><start-time fmt="00:00.050.000">50000000</start-time><duration fmt="250.00 ms">250000000</duration><name fmt="workload">workload</name></row>
  </node>
</trace-query-result>`

const thermalXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[6]'>
    <schema name="device-thermal-state-intervals" documentation="Denotes the current thermal state of the device.">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>end</mnemonic></col>
      <col><mnemonic>thermal-state</mnemonic></col>
      <col><mnemonic>track-label</mnemonic></col>
      <col><mnemonic>is-induced</mnemonic></col>
      <col><mnemonic>narrative</mnemonic></col>
    </schema>
    <row><start-time id="1" fmt="00:00.000.000">0</start-time><duration id="2" fmt="300.00 ms">300000000</duration><start-time id="3" fmt="00:00.300.000">300000000</start-time><thermal-state id="4" fmt="Fair">Fair</thermal-state><string id="5" fmt="Current">Current</string><boolean id="6" fmt="No">0</boolean><narrative id="7" fmt="Fair thermal state">Fair thermal state</narrative></row>
  </node>
</trace-query-result>`

const thermalInducedXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[6]'>
    <schema name="device-thermal-state-intervals" documentation="Denotes the current thermal state of the device.">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>end</mnemonic></col>
      <col><mnemonic>thermal-state</mnemonic></col>
      <col><mnemonic>track-label</mnemonic></col>
      <col><mnemonic>is-induced</mnemonic></col>
      <col><mnemonic>narrative</mnemonic></col>
    </schema>
    <row><start-time id="1" fmt="00:00.000.000">0</start-time><duration id="2" fmt="300.00 ms">300000000</duration><start-time id="3" fmt="00:00.300.000">300000000</start-time><thermal-state id="4" fmt="Serious">Serious</thermal-state><string id="5" fmt="Current">Current</string><boolean id="6" fmt="Yes">1</boolean><narrative id="7" fmt="Serious thermal state (induced)">Serious thermal state (induced)</narrative></row>
  </node>
</trace-query-result>`

const thermalEmptyXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[6]'>
    <schema name="device-thermal-state-intervals" documentation="Denotes the current thermal state of the device.">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>end</mnemonic></col>
      <col><mnemonic>thermal-state</mnemonic></col>
      <col><mnemonic>track-label</mnemonic></col>
      <col><mnemonic>is-induced</mnemonic></col>
      <col><mnemonic>narrative</mnemonic></col>
    </schema>
  </node>
</trace-query-result>`

const baseProvenance: PerfEvidenceProvenance = {
  recipeHash: "recipe-abc123",
  appBuild: "1.0.0 (100)",
  processIdentity: { name: "ProbeFixture", pid: 111 },
  device: { name: "iPhone 17 Pro", udid: "DEVICE-UDID-1", osVersion: "26.0" },
  xcodeVersion: "Xcode 26.6 (17F113)",
  xctraceVersion: "xctrace version 16.0 (17F113)",
  templateDigest: "template-sha-1",
  generatedAt: "2026-07-18T00:00:00.000Z",
}

const fullChannelTables = (): PerfEvidenceChannelTables => ({
  cpuSamples: parsePerfTableExport(cpuSamplesXml),
  mainThreadState: parsePerfTableExport(threadStateXml),
  hangs: parsePerfTableExport(hangsXml),
  gpuIntervals: parsePerfTableExport(gpuIntervalsXml),
  signposts: parsePerfTableExport(signpostXml),
  thermalState: parsePerfTableExport(thermalXml),
})

describe("PRB-098 evidence report -- golden multi-channel", () => {
  test("every known channel is available, phases are signpost-anchored, findings are ranked", () => {
    const report = buildEvidenceReport({ provenance: baseProvenance, tables: fullChannelTables() })

    const channelNames: ReadonlyArray<string> = [...report.channels.map((channel) => channel.channel)].sort()
    const expectedChannelNames: ReadonlyArray<string> = [
      "cpu-samples",
      "gpu-intervals",
      "hangs",
      "main-thread-state",
      "signposts",
      "thermal-state",
    ].sort()
    expect(channelNames).toEqual(expectedChannelNames)
    for (const channel of report.channels) {
      expect(channel.status).toBe("available")
      expect(channel.rowCount).toBeGreaterThan(0)
    }

    expect(report.phases).toHaveLength(2)
    expect(report.phases.every((phase) => phase.anchor === "signpost" && phase.confidence === "high")).toBe(true)
    expect(report.phases[0]?.label).toBe("setup")
    expect(report.phases[1]?.label).toBe("workload")

    // Findings are ranked by confidence (high before medium before low).
    const ranks = report.findings.map((finding) => finding.confidence)
    const rankValue = { high: 0, medium: 1, low: 2 } as const
    for (let index = 1; index < ranks.length; index += 1) {
      expect(rankValue[ranks[index]!]).toBeGreaterThanOrEqual(rankValue[ranks[index - 1]!])
    }

    // The hang (50ms-250ms) overlaps the "workload" phase (50ms-300ms) -- an
    // inference, never a causal claim.
    const hangInference = report.findings.find((finding) => finding.id.startsWith("hang-phase-overlap"))
    expect(hangInference?.kind).toBe("inference")
    expect(hangInference?.summary).toContain("not a causal claim")
    expect(hangInference?.windowLabel).toBe("workload")

    // Thermal finding surfaces the observed state, source-pointed at the
    // thermal schema, and is not fabricated as "Nominal".
    const thermalFinding = report.findings.find((finding) => finding.id === "thermal-state-observed")
    expect(thermalFinding?.summary).toContain("Fair")
    expect(thermalFinding?.source.schema).toBe("device-thermal-state-intervals")
    expect(thermalFinding?.confidence).toBe("high")

    // Metric series exist for the numeric channels used in comparison.
    const metricKeys = report.metrics.map((series) => series.key).sort()
    expect(metricKeys).toEqual(
      ["gpu-interval-duration-ns", "hang-duration-ns", "main-thread-cpu-ns", "main-thread-wait-ns", "thermal-interval-duration-ns"].sort(),
    )
  })

  test("is deterministic modulo the caller-supplied generatedAt timestamp", () => {
    const reportA = buildEvidenceReport({ provenance: baseProvenance, tables: fullChannelTables() })
    const reportB = buildEvidenceReport({
      provenance: { ...baseProvenance, generatedAt: "2099-01-01T00:00:00.000Z" },
      tables: fullChannelTables(),
    })

    const normalize = (report: typeof reportA) => JSON.stringify({ ...report, provenance: { ...report.provenance, generatedAt: "" } })

    expect(normalize(reportA)).toBe(normalize(reportB))
  })
})

describe("PRB-098 evidence report -- missing/empty channels", () => {
  test("channels absent from the recording report unavailable with a reason, and phases fall back to host actions at low confidence", () => {
    const tables: PerfEvidenceChannelTables = {
      cpuSamples: parsePerfTableExport(cpuSamplesXml),
      mainThreadState: parsePerfTableExport(threadStateXml),
      // hangs, gpuIntervals, signposts, thermalState all omitted -- this is
      // the "missing" case, not the "empty table" case (see next test).
    }

    const report = buildEvidenceReport({
      provenance: baseProvenance,
      tables,
      hostActionIntervals: [{ label: "ui-tap-flow", startNs: 0, endNs: 100_000_000 }],
    })

    const availability = new Map(report.channels.map((channel) => [channel.channel, channel]))
    expect(availability.get("cpu-samples")?.status).toBe("available")
    expect(availability.get("main-thread-state")?.status).toBe("available")

    for (const channel of ["hangs", "gpu-intervals", "signposts", "thermal-state"] as const) {
      const entry = availability.get(channel)
      expect(entry?.status).toBe("unavailable")
      expect(entry?.reason).toBeTruthy()
      expect(entry?.rowCount).toBe(0)
    }

    // No signposts -> phases fall back to host action intervals, and the
    // fallback must be explicitly labeled lower-confidence, never silently
    // promoted to the same trust level as a signpost-anchored phase.
    expect(report.phases).toHaveLength(1)
    expect(report.phases[0]?.anchor).toBe("host-action-fallback")
    expect(report.phases[0]?.confidence).toBe("low")

    // Thermal channel being unavailable must never produce a "Nominal"
    // finding or any finding at all for that channel.
    expect(report.findings.some((finding) => finding.id === "thermal-state-observed")).toBe(false)
    expect(report.findings.some((finding) => finding.summary.toLowerCase().includes("nominal"))).toBe(false)
  })

  test("a present-but-zero-row thermal table is unavailable, not distinguished from a fully absent one", () => {
    const emptyThermal = buildThermalChannel(parsePerfTableExport(thermalEmptyXml))
    const missingThermal = buildThermalChannel(undefined)

    expect(emptyThermal.availability.status).toBe("unavailable")
    expect(missingThermal.availability.status).toBe("unavailable")
    expect(emptyThermal.intervals).toHaveLength(0)
    expect(missingThermal.intervals).toHaveLength(0)
    // Reasons differ (present-but-empty vs never-captured) so an operator
    // can tell the two "unavailable" causes apart, even though the AC
    // treats both as "unavailable, never nominal".
    expect(emptyThermal.availability.reason).not.toBe(missingThermal.availability.reason)
  })

  test("no phases at all when neither signposts nor host action intervals are supplied", () => {
    expect(buildPhaseWindows({})).toEqual([])
  })
})

describe("PRB-098 evidence report -- thermal channel is-induced passthrough (capability-wall substitute)", () => {
  // knowledge/xctrace-instruments/thermal-state-findings.md §3 establishes
  // there is no safe, CLI-scriptable way to induce a real thermal ramp on
  // this toolchain -- Xcode's Device Conditions simulation is GUI-only.
  // This is the deterministic substitute the superseding gate asks for:
  // Probe passes through Apple's own real/induced distinction verbatim
  // rather than fabricating or normalizing it away.
  test("a naturally observed reading is high confidence and not flagged induced", () => {
    const { availability, intervals } = buildThermalChannel(parsePerfTableExport(thermalXml))

    expect(availability.status).toBe("available")
    expect(intervals).toHaveLength(1)
    expect(intervals[0]?.thermalState).toBe("Fair")
    expect(intervals[0]?.isInduced).toBe(false)
  })

  test("an Instruments-simulated reading is passed through as induced and downgrades finding confidence", () => {
    const tables: PerfEvidenceChannelTables = { thermalState: parsePerfTableExport(thermalInducedXml) }
    const report = buildEvidenceReport({ provenance: baseProvenance, tables })

    const thermalFinding = report.findings.find((finding) => finding.id === "thermal-state-observed")
    expect(thermalFinding?.summary).toContain("Serious")
    expect(thermalFinding?.summary).toContain("induced")
    expect(thermalFinding?.confidence).toBe("low")
  })
})

describe("PRB-098 comparison -- provenance gating", () => {
  const buildReport = (tables: PerfEvidenceChannelTables, provenance: PerfEvidenceProvenance) =>
    buildEvidenceReport({ provenance, tables })

  test("mismatched provenance beyond app build is incomparable, with no metrics computed", () => {
    const baseline = buildReport(fullChannelTables(), baseProvenance)
    const candidate = buildReport(fullChannelTables(), {
      ...baseProvenance,
      appBuild: "1.0.1 (101)",
      device: { ...baseProvenance.device, udid: "DEVICE-UDID-2" },
    })

    const comparison = compareEvidenceReports(baseline, candidate)

    expect(comparison.comparable).toBe(false)
    expect(comparison.reason).toContain("device udid differs")
    expect(comparison.metrics).toHaveLength(0)
  })

  test("matching provenance except app build is comparable and reports raw samples, median, p95, and deltas", () => {
    const baseline = buildReport(fullChannelTables(), baseProvenance)
    const candidate = buildReport(fullChannelTables(), { ...baseProvenance, appBuild: "1.0.1 (101)" })

    const comparison = compareEvidenceReports(baseline, candidate)

    expect(comparison.comparable).toBe(true)
    expect(comparison.appBuildChanged).toBe(true)
    expect(comparison.provenanceDiff).toHaveLength(0)

    const gpuMetric = comparison.metrics.find((metric) => metric.key === "gpu-interval-duration-ns")
    expect(gpuMetric).toBeTruthy()
    expect(gpuMetric?.baselineSamples).toEqual([8000000, 9000000])
    expect(gpuMetric?.candidateSamples).toEqual([8000000, 9000000])
    expect(gpuMetric?.baselineMedian).toBe(8500000)
    expect(gpuMetric?.candidateP95).not.toBeNull()
    expect(gpuMetric?.absoluteDelta).toBe(0)
    expect(gpuMetric?.relativeDelta).toBe(0)
    expect(gpuMetric?.baselineCount).toBe(2)
    expect(gpuMetric?.candidateCount).toBe(2)
  })

  test("app build alone changing still lets comparable metrics show a real delta", () => {
    const baseline = buildReport({ hangs: parsePerfTableExport(hangsXml) }, baseProvenance)
    const fasterHangsXml = hangsXml.replace("200.00 ms\">200000000", "100.00 ms\">100000000")
    const candidate = buildReport(
      { hangs: parsePerfTableExport(fasterHangsXml) },
      { ...baseProvenance, appBuild: "1.0.1 (101)" },
    )

    const comparison = compareEvidenceReports(baseline, candidate)
    expect(comparison.comparable).toBe(true)

    const hangMetric = comparison.metrics.find((metric) => metric.key === "hang-duration-ns")
    expect(hangMetric?.baselineMedian).toBe(200000000)
    expect(hangMetric?.candidateMedian).toBe(100000000)
    expect(hangMetric?.absoluteDelta).toBe(-100000000)
    expect(hangMetric?.relativeDelta).toBeCloseTo(-0.5, 5)
  })
})

describe("PRB-098 evidence report -- FPS honesty is preserved through the correlation layer", () => {
  test("an unreliable-frame-grouping GPU export still yields a channel finding, withholding FPS not the observation", () => {
    // Two GPU rows sharing the same frame-number but with a wildly different
    // start, producing a frame span far beyond the unreliable-grouping
    // threshold in analyzeMetalSystemTraceTables (reused, not reimplemented).
    const unreliableGpuXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[4]'>
    <schema name="metal-gpu-intervals">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>channel-name</mnemonic></col>
      <col><mnemonic>frame-number</mnemonic></col>
      <col><mnemonic>start-latency</mnemonic></col>
      <col><mnemonic>state</mnemonic></col>
    </schema>
    <row><start-time id="1" fmt="00:00.000.000">0</start-time><duration id="2" fmt="1.00 ms">1000000</duration><gpu-channel-name id="3" fmt="Fragment">Fragment</gpu-channel-name><gpu-frame-number id="4" fmt="Frame 0">0</gpu-frame-number><duration id="5" fmt="0.10 ms">100000</duration><gpu-state id="6" fmt="Active">Active</gpu-state></row>
    <row><start-time id="7" fmt="00:00.700.000">700000000</start-time><duration id="8" fmt="1.00 ms">1000000</duration><gpu-channel-name ref="3"/><gpu-frame-number ref="4"/><duration id="9" fmt="0.10 ms">100000</duration><gpu-state ref="6"/></row>
  </node>
</trace-query-result>`

    const report = buildEvidenceReport({
      provenance: baseProvenance,
      tables: { gpuIntervals: parsePerfTableExport(unreliableGpuXml) },
    })

    const gpuFinding = report.findings.find((finding) => finding.id === "gpu-intervals-summary")
    expect(gpuFinding?.summary).toContain("FPS withheld")

    const gpuChannel = report.channels.find((channel) => channel.channel === "gpu-intervals")
    expect(gpuChannel?.status).toBe("available")
    expect(gpuChannel?.rowCount).toBe(2)
  })
})

describe("PRB-098 evidence report -- mismatched provenance does not silently degrade to comparable", () => {
  test("template digest mismatch alone is enough to block comparison", () => {
    const baseline: ParsedPerfTable = parsePerfTableExport(hangsXml)
    const report1 = buildEvidenceReport({ provenance: baseProvenance, tables: { hangs: baseline } })
    const report2 = buildEvidenceReport({
      provenance: { ...baseProvenance, templateDigest: "template-sha-DIFFERENT" },
      tables: { hangs: parsePerfTableExport(hangsXml) },
    })

    const comparison = compareEvidenceReports(report1, report2)
    expect(comparison.comparable).toBe(false)
    expect(comparison.reason).toContain("template digest differs")
  })
})
