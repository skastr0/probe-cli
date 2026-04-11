import { describe, expect, test } from "bun:test"
import { analyzeSwiftConcurrencyTables, parsePerfTableExport } from "./perf"

const taskStateXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[1]'>
    <schema name="swift-task-state">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>task</mnemonic></col>
      <col><mnemonic>state</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
    </schema>
    <row><start-time fmt="00:00.000.000">0</start-time><duration fmt="1.00 ms">1000000</duration><swift-task fmt="Task 1">Task 1</swift-task><task-state fmt="Created">Created</task-state><process fmt="ProbeFixture (111)"><pid>111</pid></process><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 111)"><tid>1</tid></thread></row>
    <row><start-time fmt="00:00.005.000">5000000</start-time><duration fmt="10.00 ms">10000000</duration><swift-task fmt="Task 1">Task 1</swift-task><task-state fmt="Running">Running</task-state><process fmt="ProbeFixture (111)"><pid>111</pid></process><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 111)"><tid>1</tid></thread></row>
    <row><start-time fmt="00:00.160.000">160000000</start-time><duration fmt="1.00 ms">1000000</duration><swift-task fmt="Task 1">Task 1</swift-task><task-state fmt="Completed">Completed</task-state><process fmt="ProbeFixture (111)"><pid>111</pid></process><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 111)"><tid>1</tid></thread></row>
    <row><start-time fmt="00:00.010.000">10000000</start-time><duration fmt="1.00 ms">1000000</duration><swift-task fmt="Task 2">Task 2</swift-task><task-state fmt="Created">Created</task-state><process fmt="ProbeFixture (111)"><pid>111</pid></process><thread fmt="Worker Thread 0x2 (ProbeFixture, pid: 111)"><tid>2</tid></thread></row>
    <row><start-time fmt="00:00.020.000">20000000</start-time><duration fmt="10.00 ms">10000000</duration><swift-task fmt="Task 2">Task 2</swift-task><task-state fmt="Running">Running</task-state><process fmt="ProbeFixture (111)"><pid>111</pid></process><thread fmt="Worker Thread 0x2 (ProbeFixture, pid: 111)"><tid>2</tid></thread></row>
    <row><start-time fmt="00:00.040.000">40000000</start-time><duration fmt="1.00 ms">1000000</duration><swift-task fmt="Task 2">Task 2</swift-task><task-state fmt="Cancelled">Cancelled</task-state><process fmt="ProbeFixture (111)"><pid>111</pid></process><thread fmt="Worker Thread 0x2 (ProbeFixture, pid: 111)"><tid>2</tid></thread></row>
  </node>
</trace-query-result>`

const taskLifetimeXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[2]'>
    <schema name="swift-task-lifetime">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>task</mnemonic></col>
    </schema>
    <row><start-time fmt="00:00.000.000">0</start-time><duration fmt="250.00 ms">250000000</duration><swift-task fmt="Task 1">Task 1</swift-task></row>
    <row><start-time fmt="00:00.010.000">10000000</start-time><duration fmt="50.00 ms">50000000</duration><swift-task fmt="Task 2">Task 2</swift-task></row>
  </node>
</trace-query-result>`

const actorExecutionXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[3]'>
    <schema name="swift-actor-execution">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>actor</mnemonic></col>
      <col><mnemonic>task</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
    </schema>
    <row><start-time fmt="00:00.006.000">6000000</start-time><duration fmt="4.00 ms">4000000</duration><swift-actor fmt="MainActor">MainActor</swift-actor><swift-task fmt="Task 1">Task 1</swift-task><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 111)"><tid>1</tid></thread></row>
    <row><start-time fmt="00:00.025.000">25000000</start-time><duration fmt="30.00 ms">30000000</duration><swift-actor fmt="ImagePipelineActor">ImagePipelineActor</swift-actor><swift-task fmt="Task 2">Task 2</swift-task><thread fmt="Worker Thread 0x2 (ProbeFixture, pid: 111)"><tid>2</tid></thread></row>
  </node>
</trace-query-result>`

describe("swift concurrency analysis", () => {
  test("reports task counts, state transitions, and actor timing", () => {
    const result = analyzeSwiftConcurrencyTables({
      taskStateTable: parsePerfTableExport(taskStateXml),
      taskLifetimeTable: parsePerfTableExport(taskLifetimeXml),
      actorExecutionTable: parsePerfTableExport(actorExecutionXml),
    })

    expect(result.summary.headline).toContain("Observed 2 Swift tasks")
    expect(result.summary.metrics.find((metric) => metric.label === "Task creations")?.value).toBe("2")
    expect(result.summary.metrics.find((metric) => metric.label === "Task terminations")?.value).toBe("2")
    expect(result.summary.metrics.find((metric) => metric.label === "State transitions")?.value).toContain("Created → Running (2)")
    expect(result.summary.metrics.find((metric) => metric.label === "Actor executions")?.value).toBe("2")
    expect(result.summary.metrics.find((metric) => metric.label === "Avg actor execution")?.value).toBe("17.00 ms")
    expect(result.diagnoses.some((diagnosis) => diagnosis.code === "swift-concurrency-long-running-tasks")).toBe(true)
  })

  test("fails closed when required task-state columns disappear", () => {
    const driftedTaskStateXml = taskStateXml.replace("<col><mnemonic>state</mnemonic></col>", "")

    expect(() =>
      analyzeSwiftConcurrencyTables({
        taskStateTable: parsePerfTableExport(driftedTaskStateXml),
        taskLifetimeTable: parsePerfTableExport(taskLifetimeXml),
      })).toThrow(/swift-task-state is missing required columns: state/)
  })
})
