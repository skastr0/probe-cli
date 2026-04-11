import { describe, expect, test } from "bun:test"
import { analyzeHangsTables, parsePerfTableExport } from "./perf"

const potentialHangsXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[1]'>
    <schema name="potential-hangs">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>hang-type</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
    </schema>
    <row><start-time fmt="00:00.100.000">100000000</start-time><duration fmt="450.00 ms">450000000</duration><hang-type fmt="Main Run Loop Unresponsive">Main Run Loop Unresponsive</hang-type><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 111)"><tid>1</tid></thread><process fmt="ProbeFixture (111)"><pid>111</pid></process></row>
    <row><start-time fmt="00:00.900.000">900000000</start-time><duration fmt="300.00 ms">300000000</duration><hang-type fmt="Main Run Loop Unresponsive">Main Run Loop Unresponsive</hang-type><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 111)"><tid>1</tid></thread><process fmt="ProbeFixture (111)"><pid>111</pid></process></row>
  </node>
</trace-query-result>`

const hangRisksXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[2]'>
    <schema name="hang-risks">
      <col><mnemonic>time</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
      <col><mnemonic>message</mnemonic></col>
      <col><mnemonic>severity</mnemonic></col>
      <col><mnemonic>event-type</mnemonic></col>
      <col><mnemonic>backtrace</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
    </schema>
    <row><event-time fmt="00:00.120.000">120000000</event-time><process fmt="ProbeFixture (111)"><pid>111</pid></process><message fmt="Main thread blocked in expensive layout pass">Main thread blocked in expensive layout pass</message><severity fmt="Severe">Severe</severity><event-type fmt="Hang Risk">Hang Risk</event-type><backtrace fmt="MainActor.run → LayoutPass.render → ExpensiveView.body">MainActor.run → LayoutPass.render → ExpensiveView.body</backtrace><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 111)"><tid>1</tid></thread></row>
  </node>
</trace-query-result>`

describe("hangs analysis", () => {
  test("reports hang durations, thread attribution, and call stack hints", () => {
    const result = analyzeHangsTables({
      hangTable: parsePerfTableExport(potentialHangsXml),
      hangRiskTable: parsePerfTableExport(hangRisksXml),
    })

    expect(result.summary.headline).toContain("Detected 2 hang events")
    expect(result.summary.metrics.find((metric) => metric.label === "Avg duration")?.value).toBe("375.00 ms")
    expect(result.summary.metrics.find((metric) => metric.label === "Max duration")?.value).toBe("450.00 ms")
    expect(result.summary.metrics.find((metric) => metric.label === "Call stack hints")?.value).toBe("available")

    const longestHangDiagnosis = result.diagnoses.find((diagnosis) => diagnosis.code === "hangs-longest-event")
    expect(longestHangDiagnosis?.details.join(" ")).toContain("LayoutPass.render")
    expect(longestHangDiagnosis?.details.join(" ")).toContain("Main Thread")
  })

  test("fails closed when required hang columns disappear", () => {
    const driftedHangXml = potentialHangsXml.replace("<col><mnemonic>hang-type</mnemonic></col>", "")

    expect(() => analyzeHangsTables({ hangTable: parsePerfTableExport(driftedHangXml) })).toThrow(
      /potential-hangs is missing required columns: hang-type/,
    )
  })
})
