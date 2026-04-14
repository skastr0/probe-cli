import { describe, expect, test } from "bun:test"
import { analyzeMetalSystemTraceTables, parsePerfTableExport } from "./perf"

interface GpuIntervalRow {
  readonly start: number
  readonly duration: number
  readonly channelName: string
  readonly frameNumber: string
  readonly startLatency: number
  readonly state: string
}

interface EncoderRow {
  readonly start: number
  readonly duration: number
  readonly frameNumber: string
  readonly commandBufferLabel: string
  readonly commandBufferLabelIndexed: string
  readonly encoderLabel: string
  readonly encoderLabelIndexed: string
  readonly eventType: string
  readonly commandBufferId: string
  readonly encoderId: string
}

const metricValue = (
  result: ReturnType<typeof analyzeMetalSystemTraceTables>,
  label: string,
) => result.summary.metrics.find((metric) => metric.label === label)?.value

const diagnosisByCode = (
  result: ReturnType<typeof analyzeMetalSystemTraceTables>,
  code: string,
) => result.diagnoses.find((diagnosis) => diagnosis.code === code)

const buildGpuIntervalsXml = (rows: ReadonlyArray<GpuIntervalRow>) => `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[1]'>
    <schema name="metal-gpu-intervals">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>channel-name</mnemonic></col>
      <col><mnemonic>frame-number</mnemonic></col>
      <col><mnemonic>start-latency</mnemonic></col>
      <col><mnemonic>state</mnemonic></col>
    </schema>
${rows
  .map(
    (row) => `    <row><start-time fmt="${row.start}">${row.start}</start-time><duration fmt="${(row.duration / 1_000_000).toFixed(2)} ms">${row.duration}</duration><gpu-channel-name fmt="${row.channelName}">${row.channelName}</gpu-channel-name><gpu-frame-number fmt="Frame ${row.frameNumber}">${row.frameNumber}</gpu-frame-number><start-latency fmt="${(row.startLatency / 1_000_000).toFixed(2)} ms">${row.startLatency}</start-latency><gpu-state fmt="${row.state}">${row.state}</gpu-state></row>`,
  )
  .join("\n")}
  </node>
</trace-query-result>`

const buildEncoderListXml = (rows: ReadonlyArray<EncoderRow>) => `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[3]'>
    <schema name="metal-application-encoders-list">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
      <col><mnemonic>gpu</mnemonic></col>
      <col><mnemonic>frame-number</mnemonic></col>
      <col><mnemonic>cmdbuffer-label</mnemonic></col>
      <col><mnemonic>cmdbuffer-label-indexed</mnemonic></col>
      <col><mnemonic>encoder-label</mnemonic></col>
      <col><mnemonic>encoder-label-indexed</mnemonic></col>
      <col><mnemonic>event-type</mnemonic></col>
      <col><mnemonic>cmdbuffer-id</mnemonic></col>
      <col><mnemonic>encoder-id</mnemonic></col>
    </schema>
${rows
  .map(
    (row) => `    <row><start-time fmt="${row.start}">${row.start}</start-time><duration fmt="${(row.duration / 1_000_000).toFixed(2)} ms">${row.duration}</duration><thread fmt="Main Thread 0x1 (Ripple, pid: 5462)"><tid>1</tid></thread><process fmt="Ripple (5462)"><pid>5462</pid></process><gpu-device fmt="Apple GPU">Apple GPU</gpu-device><gpu-frame-number fmt="Frame ${row.frameNumber}">${row.frameNumber}</gpu-frame-number><cmdbuffer-label fmt="${row.commandBufferLabel}">${row.commandBufferLabel}</cmdbuffer-label><cmdbuffer-label-indexed fmt="${row.commandBufferLabelIndexed}">${row.commandBufferLabelIndexed}</cmdbuffer-label-indexed><encoder-label fmt="${row.encoderLabel}">${row.encoderLabel}</encoder-label><encoder-label-indexed fmt="${row.encoderLabelIndexed}">${row.encoderLabelIndexed}</encoder-label-indexed><event-type fmt="${row.eventType}">${row.eventType}</event-type><cmdbuffer-id fmt="${row.commandBufferId}">${row.commandBufferId}</cmdbuffer-id><encoder-id fmt="${row.encoderId}">${row.encoderId}</encoder-id></row>`,
  )
  .join("\n")}
  </node>
</trace-query-result>`

const rippleLikeGpuRows: ReadonlyArray<GpuIntervalRow> = [
  { start: 0, duration: 12_000_000, channelName: "Vertex", frameNumber: "1", startLatency: 2_000_000, state: "Active" },
  { start: 2_600_000_000, duration: 10_000_000, channelName: "Fragment", frameNumber: "1", startLatency: 1_000_000, state: "Active" },
  { start: 5_000_000_000, duration: 18_000_000, channelName: "Fragment", frameNumber: "2", startLatency: 2_500_000, state: "Active" },
  { start: 5_370_000_000, duration: 4_000_000, channelName: "Post", frameNumber: "2", startLatency: 1_500_000, state: "Active" },
  { start: 8_000_000_000, duration: 15_000_000, channelName: "Fragment", frameNumber: "3", startLatency: 2_000_000, state: "Active" },
  { start: 8_820_000_000, duration: 8_000_000, channelName: "Compositor", frameNumber: "3", startLatency: 1_000_000, state: "Active" },
  { start: 9_100_000_000, duration: 9_000_000, channelName: "Vertex", frameNumber: "4", startLatency: 1_000_000, state: "Active" },
  { start: 9_120_000_000, duration: 11_000_000, channelName: "Fragment", frameNumber: "5", startLatency: 1_000_000, state: "Active" },
  { start: 9_140_000_000, duration: 14_000_000, channelName: "Tile", frameNumber: "6", startLatency: 3_000_000, state: "Active" },
  { start: 9_150_000_000, duration: 6_000_000, channelName: "Blit", frameNumber: "6", startLatency: 1_000_000, state: "Active" },
]

const rippleLikeEncoderRows: ReadonlyArray<EncoderRow> = [
  {
    start: 0,
    duration: 8_000_000,
    frameNumber: "1",
    commandBufferLabel: "Ripple Buffer 1",
    commandBufferLabelIndexed: "Ripple Buffer 1 [1]",
    encoderLabel: "Render Command 0",
    encoderLabelIndexed: "Render Command 0 [1]",
    eventType: "Render",
    commandBufferId: "200",
    encoderId: "20",
  },
  {
    start: 5_000_000_000,
    duration: 11_000_000,
    frameNumber: "2",
    commandBufferLabel: "Ripple Buffer 2",
    commandBufferLabelIndexed: "Ripple Buffer 2 [1]",
    encoderLabel: "Render Command 0",
    encoderLabelIndexed: "Render Command 0 [2]",
    eventType: "Render",
    commandBufferId: "201",
    encoderId: "21",
  },
  {
    start: 8_000_000_000,
    duration: 3_000_000,
    frameNumber: "3",
    commandBufferLabel: "Ripple Buffer 3",
    commandBufferLabelIndexed: "Ripple Buffer 3 [1]",
    encoderLabel: "UI Composite",
    encoderLabelIndexed: "UI Composite [1]",
    eventType: "Blit",
    commandBufferId: "202",
    encoderId: "22",
  },
]

const wellBehavedGpuRows: ReadonlyArray<GpuIntervalRow> = [
  { start: 0, duration: 12_000_000, channelName: "Vertex", frameNumber: "1", startLatency: 2_000_000, state: "Active" },
  { start: 5_000_000, duration: 10_000_000, channelName: "Fragment", frameNumber: "1", startLatency: 1_000_000, state: "Active" },
  { start: 20_000_000, duration: 18_000_000, channelName: "Fragment", frameNumber: "2", startLatency: 2_500_000, state: "Active" },
  { start: 22_000_000, duration: 4_000_000, channelName: "Post", frameNumber: "2", startLatency: 1_500_000, state: "Active" },
]

describe("metal FPS honesty", () => {
  test("withholds FPS for Ripple-like noisy frame grouping", () => {
    const result = analyzeMetalSystemTraceTables({
      gpuIntervalsTable: parsePerfTableExport(buildGpuIntervalsXml(rippleLikeGpuRows)),
      encoderListTable: parsePerfTableExport(buildEncoderListXml(rippleLikeEncoderRows)),
    })

    expect(metricValue(result, "Estimated FPS")).toBe("withheld (unreliable grouping)")
    expect(metricValue(result, "Frames over 60 FPS budget")).toBe("withheld")
    expect(diagnosisByCode(result, "metal-fps-withheld")).toBeDefined()
    expect(diagnosisByCode(result, "metal-encoder-breakdown")).toBeDefined()
    expect(diagnosisByCode(result, "metal-frame-budget-duration")).toBeUndefined()
    expect(diagnosisByCode(result, "metal-frame-budget-latency")).toBeUndefined()
    expect(diagnosisByCode(result, "metal-frame-budget-fps")).toBeUndefined()
  })

  test("still reports encoder timing when FPS is withheld", () => {
    const result = analyzeMetalSystemTraceTables({
      gpuIntervalsTable: parsePerfTableExport(buildGpuIntervalsXml(rippleLikeGpuRows)),
      encoderListTable: parsePerfTableExport(buildEncoderListXml(rippleLikeEncoderRows)),
    })

    expect(result.summary.headline).toContain("FPS withheld")
    expect(result.summary.headline).toContain("Render Command 0")
    expect(diagnosisByCode(result, "metal-encoder-breakdown")).toBeDefined()
    expect(diagnosisByCode(result, "metal-gpu-counters-required")?.wall).toBe(true)
  })

  test("withholds FPS headline when no encoder table is present and grouping is unreliable", () => {
    const result = analyzeMetalSystemTraceTables({
      gpuIntervalsTable: parsePerfTableExport(buildGpuIntervalsXml(rippleLikeGpuRows)),
    })

    expect(result.summary.headline).toContain("FPS withheld")
    expect(result.summary.headline).not.toContain("dominated")
    expect(metricValue(result, "Estimated FPS")).toBe("withheld (unreliable grouping)")
    expect(metricValue(result, "Frames over 60 FPS budget")).toBe("withheld")
    expect(diagnosisByCode(result, "metal-fps-withheld")).toBeDefined()
    expect(diagnosisByCode(result, "metal-encoder-breakdown")).toBeUndefined()
  })

  test("still reports FPS for well-behaved frame grouping", () => {
    const result = analyzeMetalSystemTraceTables({
      gpuIntervalsTable: parsePerfTableExport(buildGpuIntervalsXml(wellBehavedGpuRows)),
    })

    expect(metricValue(result, "Estimated FPS")).toBe("60.6 fps")
    expect(metricValue(result, "Estimated FPS")).not.toContain("withheld")
    expect(diagnosisByCode(result, "metal-fps-withheld")).toBeUndefined()
    expect(diagnosisByCode(result, "metal-frame-budget-fps")).toBeDefined()
  })

  test("reports n/a FPS for empty GPU intervals", () => {
    const result = analyzeMetalSystemTraceTables({
      gpuIntervalsTable: parsePerfTableExport(buildGpuIntervalsXml([])),
    })

    expect(metricValue(result, "Estimated FPS")).toBe("n/a")
    expect(diagnosisByCode(result, "metal-no-rows")).toBeDefined()
    expect(diagnosisByCode(result, "metal-fps-withheld")).toBeUndefined()
  })
})
