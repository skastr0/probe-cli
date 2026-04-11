import { describe, expect, test } from "bun:test"
import { analyzeMetalSystemTraceTables, parsePerfTableExport } from "./perf"

const gpuIntervalsXml = `<?xml version="1.0"?>
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
    <row><start-time fmt="00:00.000.000">0</start-time><duration fmt="12.00 ms">12000000</duration><gpu-channel-name fmt="Vertex">Vertex</gpu-channel-name><gpu-frame-number fmt="Frame 1">1</gpu-frame-number><duration fmt="2.00 ms">2000000</duration><gpu-state fmt="Active">Active</gpu-state></row>
    <row><start-time fmt="00:00.005.000">5000000</start-time><duration fmt="10.00 ms">10000000</duration><gpu-channel-name fmt="Fragment">Fragment</gpu-channel-name><gpu-frame-number fmt="Frame 1">1</gpu-frame-number><duration fmt="1.00 ms">1000000</duration><gpu-state fmt="Active">Active</gpu-state></row>
    <row><start-time fmt="00:00.020.000">20000000</start-time><duration fmt="18.00 ms">18000000</duration><gpu-channel-name fmt="Fragment">Fragment</gpu-channel-name><gpu-frame-number fmt="Frame 2">2</gpu-frame-number><duration fmt="2.50 ms">2500000</duration><gpu-state fmt="Active">Active</gpu-state></row>
    <row><start-time fmt="00:00.022.000">22000000</start-time><duration fmt="4.00 ms">4000000</duration><gpu-channel-name fmt="Post">Post</gpu-channel-name><gpu-frame-number fmt="Frame 2">2</gpu-frame-number><duration fmt="1.50 ms">1500000</duration><gpu-state fmt="Active">Active</gpu-state></row>
  </node>
</trace-query-result>`

const driverIntervalsXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[2]'>
    <schema name="metal-driver-event-intervals">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>gpu-driver-name</mnemonic></col>
      <col><mnemonic>event-type</mnemonic></col>
      <col><mnemonic>event-depth</mnemonic></col>
      <col><mnemonic>event-label</mnemonic></col>
      <col><mnemonic>event-priority</mnemonic></col>
      <col><mnemonic>connection-UUID</mnemonic></col>
      <col><mnemonic>color</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
      <col><mnemonic>gpu</mnemonic></col>
      <col><mnemonic>resource-id</mnemonic></col>
      <col><mnemonic>show-per-thread</mnemonic></col>
    </schema>
    <row><start-time fmt="00:00.001.000">1000000</start-time><duration fmt="1.50 ms">1500000</duration><gpu-driver-name fmt="AGX">AGX</gpu-driver-name><driver-event-type fmt="Submit">Submit</driver-event-type><depth fmt="1">1</depth><event-label fmt="Submit Command Buffer">Submit Command Buffer</event-label><event-priority fmt="High">High</event-priority><uuid fmt="1">1</uuid><color fmt="Blue">1</color><process fmt="ProbeFixture (111)"><pid>111</pid></process><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 111)"><tid>1</tid></thread><gpu-device fmt="Apple GPU">Apple GPU</gpu-device><resource-id fmt="7">7</resource-id><show-per-thread fmt="true">1</show-per-thread></row>
    <row><start-time fmt="00:00.024.000">24000000</start-time><duration fmt="2.00 ms">2000000</duration><gpu-driver-name fmt="AGX">AGX</gpu-driver-name><driver-event-type fmt="Complete">Complete</driver-event-type><depth fmt="1">1</depth><event-label fmt="GPU Completion">GPU Completion</event-label><event-priority fmt="High">High</event-priority><uuid fmt="1">1</uuid><color fmt="Blue">1</color><process fmt="ProbeFixture (111)"><pid>111</pid></process><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 111)"><tid>1</tid></thread><gpu-device fmt="Apple GPU">Apple GPU</gpu-device><resource-id fmt="7">7</resource-id><show-per-thread fmt="true">1</show-per-thread></row>
  </node>
</trace-query-result>`

const encoderListXml = `<?xml version="1.0"?>
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
    <row><start-time fmt="00:00.000.000">0</start-time><duration fmt="6.00 ms">6000000</duration><thread fmt="Render Thread 0x2 (ProbeFixture, pid: 111)"><tid>2</tid></thread><process fmt="ProbeFixture (111)"><pid>111</pid></process><gpu-device fmt="Apple GPU">Apple GPU</gpu-device><gpu-frame-number fmt="Frame 1">1</gpu-frame-number><cmdbuffer-label fmt="Frame 1 Buffer">Frame 1 Buffer</cmdbuffer-label><cmdbuffer-label-indexed fmt="Frame 1 Buffer [1]">Frame 1 Buffer [1]</cmdbuffer-label-indexed><encoder-label fmt="Vertex Pass">Vertex Pass</encoder-label><encoder-label-indexed fmt="Vertex Pass [1]">Vertex Pass [1]</encoder-label-indexed><event-type fmt="Render">Render</event-type><cmdbuffer-id fmt="100">100</cmdbuffer-id><encoder-id fmt="10">10</encoder-id></row>
    <row><start-time fmt="00:00.005.000">5000000</start-time><duration fmt="11.00 ms">11000000</duration><thread fmt="Render Thread 0x2 (ProbeFixture, pid: 111)"><tid>2</tid></thread><process fmt="ProbeFixture (111)"><pid>111</pid></process><gpu-device fmt="Apple GPU">Apple GPU</gpu-device><gpu-frame-number fmt="Frame 1">1</gpu-frame-number><cmdbuffer-label fmt="Frame 1 Buffer">Frame 1 Buffer</cmdbuffer-label><cmdbuffer-label-indexed fmt="Frame 1 Buffer [1]">Frame 1 Buffer [1]</cmdbuffer-label-indexed><encoder-label fmt="Fragment Pass">Fragment Pass</encoder-label><encoder-label-indexed fmt="Fragment Pass [1]">Fragment Pass [1]</encoder-label-indexed><event-type fmt="Render">Render</event-type><cmdbuffer-id fmt="100">100</cmdbuffer-id><encoder-id fmt="11">11</encoder-id></row>
    <row><start-time fmt="00:00.020.000">20000000</start-time><duration fmt="12.00 ms">12000000</duration><thread fmt="Render Thread 0x2 (ProbeFixture, pid: 111)"><tid>2</tid></thread><process fmt="ProbeFixture (111)"><pid>111</pid></process><gpu-device fmt="Apple GPU">Apple GPU</gpu-device><gpu-frame-number fmt="Frame 2">2</gpu-frame-number><cmdbuffer-label fmt="Frame 2 Buffer">Frame 2 Buffer</cmdbuffer-label><cmdbuffer-label-indexed fmt="Frame 2 Buffer [2]">Frame 2 Buffer [2]</cmdbuffer-label-indexed><encoder-label fmt="Fragment Pass">Fragment Pass</encoder-label><encoder-label-indexed fmt="Fragment Pass [2]">Fragment Pass [2]</encoder-label-indexed><event-type fmt="Render">Render</event-type><cmdbuffer-id fmt="101">101</cmdbuffer-id><encoder-id fmt="12">12</encoder-id></row>
    <row><start-time fmt="00:00.022.000">22000000</start-time><duration fmt="3.00 ms">3000000</duration><thread fmt="Render Thread 0x2 (ProbeFixture, pid: 111)"><tid>2</tid></thread><process fmt="ProbeFixture (111)"><pid>111</pid></process><gpu-device fmt="Apple GPU">Apple GPU</gpu-device><gpu-frame-number fmt="Frame 2">2</gpu-frame-number><cmdbuffer-label fmt="Frame 2 Buffer">Frame 2 Buffer</cmdbuffer-label><cmdbuffer-label-indexed fmt="Frame 2 Buffer [2]">Frame 2 Buffer [2]</cmdbuffer-label-indexed><encoder-label fmt="Post Processing">Post Processing</encoder-label><encoder-label-indexed fmt="Post Processing [1]">Post Processing [1]</encoder-label-indexed><event-type fmt="Blit">Blit</event-type><cmdbuffer-id fmt="101">101</cmdbuffer-id><encoder-id fmt="13">13</encoder-id></row>
  </node>
</trace-query-result>`

describe("extended metal analysis", () => {
  test("combines gpu, driver, and encoder exports into one summary", () => {
    const result = analyzeMetalSystemTraceTables({
      gpuIntervalsTable: parsePerfTableExport(gpuIntervalsXml),
      driverEventTable: parsePerfTableExport(driverIntervalsXml),
      encoderListTable: parsePerfTableExport(encoderListXml),
    })

    expect(result.summary.headline).toContain("Fragment Pass")
    expect(result.summary.headline).toContain("60.6 fps average")
    expect(result.summary.headline).toContain("1 of 2 frames exceeded")
    expect(result.summary.metrics.find((metric) => metric.label === "Estimated FPS")?.value).toBe("60.6 fps")
    expect(result.summary.metrics.find((metric) => metric.label === "Frames over 60 FPS budget")?.value).toBe("1/2")
    expect(result.summary.metrics.find((metric) => metric.label === "Per-encoder summary")?.value).toContain("Fragment Pass (2 command buffers, 23.00 ms total, 11.50 ms avg)")
    expect(result.summary.metrics.find((metric) => metric.label === "Driver events")?.value).toBe("2")
    expect(result.diagnoses.some((diagnosis) => diagnosis.code === "metal-frame-budget-fps")).toBe(true)
    expect(result.diagnoses.some((diagnosis) => diagnosis.code === "metal-encoder-breakdown")).toBe(true)
    expect(result.diagnoses.some((diagnosis) => diagnosis.code === "metal-gpu-counters-required")).toBe(true)
    expect(result.diagnoses.some((diagnosis) => diagnosis.code === "metal-per-shader-wall")).toBe(false)
  })

  test("fails closed when encoder exports lose required columns", () => {
    const driftedEncoderXml = encoderListXml.replace("<col><mnemonic>encoder-label</mnemonic></col>", "")

    expect(() =>
      analyzeMetalSystemTraceTables({
        gpuIntervalsTable: parsePerfTableExport(gpuIntervalsXml),
        encoderListTable: parsePerfTableExport(driftedEncoderXml),
      })).toThrow(/metal-application-encoders-list is missing required columns: encoder-label/)
  })
})
