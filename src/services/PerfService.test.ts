import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either } from "effect"
import {
  ArtifactNotFoundError,
  ChildProcessError,
  EnvironmentError,
  UnsupportedCapabilityError,
  UserInputError,
} from "../domain/errors"
import type { ArtifactRecord } from "../domain/output"
import { DaemonClient } from "./DaemonClient"
import { createPerfService, ExportBudgetExceededError } from "./PerfService"
import { runPerfCommand } from "../cli/commands/perf"

const mib = 1024 * 1024

const tocXml = `<?xml version="1.0"?>
<trace-toc>
  <run number="1"/>
</trace-toc>`

const loggingTocWithSignpostSchemaXml = `<?xml version="1.0"?>
<trace-toc>
  <run number="1">
    <data>
      <table schema="os-signpost-interval"/>
    </data>
  </run>
</trace-toc>`

const loggingTocWithoutSignpostSchemaXml = `<?xml version="1.0"?>
<trace-toc>
  <run number="1">
    <data>
      <table schema="thread-state"/>
    </data>
  </run>
</trace-toc>`

const customTemplateTocXml = `<?xml version="1.0"?>
<trace-toc>
  <run number="1">
    <data>
      <table schema="custom-main"/>
      <table schema="custom-secondary"/>
    </data>
  </run>
</trace-toc>`

const timeProfilerXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[1]'>
    <schema name="time-sample">
      <col><mnemonic>time</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
      <col><mnemonic>core-index</mnemonic></col>
      <col><mnemonic>thread-state</mnemonic></col>
      <col><mnemonic>sample-type</mnemonic></col>
    </schema>
    <row><sample-time fmt="00:00.100.000">100000000</sample-time><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 123)"><tid>1</tid></thread><core fmt="CPU 3">3</core><thread-state fmt="Running">Running</thread-state><time-sample-kind fmt="Stackshot">3</time-sample-kind></row>
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
    <row><start-time fmt="00:00.000.000">0</start-time><core fmt="CPU 3">3</core><core-state fmt="Running">Running</core-state><duration fmt="1.00 µs">1000</duration><process fmt="ProbeFixture (123)"><pid>123</pid></process><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 123)"><tid>1</tid></thread><sched-priority fmt="31">31</sched-priority></row>
  </node>
</trace-query-result>`

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
    <row><start-time fmt="00:00.100.000">100000000</start-time><duration fmt="450.00 ms">450000000</duration><hang-type fmt="Main Run Loop Unresponsive">Main Run Loop Unresponsive</hang-type><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 123)"><tid>1</tid></thread><process fmt="ProbeFixture (123)"><pid>123</pid></process></row>
    <row><start-time fmt="00:00.900.000">900000000</start-time><duration fmt="300.00 ms">300000000</duration><hang-type fmt="Main Run Loop Unresponsive">Main Run Loop Unresponsive</hang-type><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 123)"><tid>1</tid></thread><process fmt="ProbeFixture (123)"><pid>123</pid></process></row>
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
    <row><event-time fmt="00:00.120.000">120000000</event-time><process fmt="ProbeFixture (123)"><pid>123</pid></process><message fmt="Main thread blocked in expensive layout pass">Main thread blocked in expensive layout pass</message><severity fmt="Severe">Severe</severity><event-type fmt="Hang Risk">Hang Risk</event-type><backtrace fmt="MainActor.run → LayoutPass.render → ExpensiveView.body">MainActor.run → LayoutPass.render → ExpensiveView.body</backtrace><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 123)"><tid>1</tid></thread></row>
  </node>
</trace-query-result>`

const swiftTaskStateXml = `<?xml version="1.0"?>
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
    <row><start-time fmt="00:00.000.000">0</start-time><duration fmt="1.00 ms">1000000</duration><swift-task fmt="Task 1">Task 1</swift-task><task-state fmt="Created">Created</task-state><process fmt="ProbeFixture (123)"><pid>123</pid></process><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 123)"><tid>1</tid></thread></row>
    <row><start-time fmt="00:00.005.000">5000000</start-time><duration fmt="10.00 ms">10000000</duration><swift-task fmt="Task 1">Task 1</swift-task><task-state fmt="Running">Running</task-state><process fmt="ProbeFixture (123)"><pid>123</pid></process><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 123)"><tid>1</tid></thread></row>
    <row><start-time fmt="00:00.160.000">160000000</start-time><duration fmt="1.00 ms">1000000</duration><swift-task fmt="Task 1">Task 1</swift-task><task-state fmt="Completed">Completed</task-state><process fmt="ProbeFixture (123)"><pid>123</pid></process><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 123)"><tid>1</tid></thread></row>
    <row><start-time fmt="00:00.010.000">10000000</start-time><duration fmt="1.00 ms">1000000</duration><swift-task fmt="Task 2">Task 2</swift-task><task-state fmt="Created">Created</task-state><process fmt="ProbeFixture (123)"><pid>123</pid></process><thread fmt="Worker Thread 0x2 (ProbeFixture, pid: 123)"><tid>2</tid></thread></row>
    <row><start-time fmt="00:00.020.000">20000000</start-time><duration fmt="10.00 ms">10000000</duration><swift-task fmt="Task 2">Task 2</swift-task><task-state fmt="Running">Running</task-state><process fmt="ProbeFixture (123)"><pid>123</pid></process><thread fmt="Worker Thread 0x2 (ProbeFixture, pid: 123)"><tid>2</tid></thread></row>
    <row><start-time fmt="00:00.040.000">40000000</start-time><duration fmt="1.00 ms">1000000</duration><swift-task fmt="Task 2">Task 2</swift-task><task-state fmt="Cancelled">Cancelled</task-state><process fmt="ProbeFixture (123)"><pid>123</pid></process><thread fmt="Worker Thread 0x2 (ProbeFixture, pid: 123)"><tid>2</tid></thread></row>
  </node>
</trace-query-result>`

const swiftTaskLifetimeXml = `<?xml version="1.0"?>
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

const swiftActorExecutionXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[3]'>
    <schema name="swift-actor-execution">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>actor</mnemonic></col>
      <col><mnemonic>task</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
    </schema>
    <row><start-time fmt="00:00.006.000">6000000</start-time><duration fmt="4.00 ms">4000000</duration><swift-actor fmt="MainActor">MainActor</swift-actor><swift-task fmt="Task 1">Task 1</swift-task><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 123)"><tid>1</tid></thread></row>
    <row><start-time fmt="00:00.025.000">25000000</start-time><duration fmt="30.00 ms">30000000</duration><swift-actor fmt="ImagePipelineActor">ImagePipelineActor</swift-actor><swift-task fmt="Task 2">Task 2</swift-task><thread fmt="Worker Thread 0x2 (ProbeFixture, pid: 123)"><tid>2</tid></thread></row>
  </node>
</trace-query-result>`

const signpostIntervalsXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[1]'>
    <schema name="os-signpost-interval">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>name</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
      <col><mnemonic>subsystem</mnemonic></col>
      <col><mnemonic>category</mnemonic></col>
    </schema>
    <row><start-time fmt="00:00.000.000">0</start-time><duration fmt="10.00 ms">10000000</duration><name fmt="loadData">loadData</name><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 123)"><tid>1</tid></thread><process fmt="ProbeFixture (123)"><pid>123</pid></process><subsystem fmt="dev.probe.fixture">dev.probe.fixture</subsystem><category fmt="startup">startup</category></row>
    <row><start-time fmt="00:00.015.000">15000000</start-time><duration fmt="20.00 ms">20000000</duration><name fmt="loadData">loadData</name><thread fmt="Main Thread 0x1 (ProbeFixture, pid: 123)"><tid>1</tid></thread><process fmt="ProbeFixture (123)"><pid>123</pid></process><subsystem fmt="dev.probe.fixture">dev.probe.fixture</subsystem><category fmt="startup">startup</category></row>
    <row><start-time fmt="00:00.050.000">50000000</start-time><duration fmt="5.00 ms">5000000</duration><name fmt="renderFrame">renderFrame</name><thread fmt="Render Thread 0x2 (ProbeFixture, pid: 123)"><tid>2</tid></thread><process fmt="ProbeFixture (123)"><pid>123</pid></process><subsystem fmt="dev.probe.fixture">dev.probe.fixture</subsystem><category fmt="render">render</category></row>
  </node>
</trace-query-result>`

const emptySignpostIntervalsXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[1]'>
    <schema name="os-signpost-interval">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>name</mnemonic></col>
      <col><mnemonic>thread</mnemonic></col>
      <col><mnemonic>process</mnemonic></col>
      <col><mnemonic>subsystem</mnemonic></col>
      <col><mnemonic>category</mnemonic></col>
    </schema>
  </node>
</trace-query-result>`

const metalDriverIntervalsXml = `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[2]'>
    <schema name="metal-driver-event-intervals">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>event-type</mnemonic></col>
      <col><mnemonic>event-label</mnemonic></col>
    </schema>
    <row><start-time fmt="00:00.001.000">1000000</start-time><duration fmt="1.50 ms">1500000</duration><driver-event-type fmt="Submit">Submit</driver-event-type><event-label fmt="Submit Command Buffer">Submit Command Buffer</event-label></row>
    <row><start-time fmt="00:00.024.000">24000000</start-time><duration fmt="2.00 ms">2000000</duration><driver-event-type fmt="Complete">Complete</driver-event-type><event-label fmt="GPU Completion">GPU Completion</event-label></row>
  </node>
</trace-query-result>`

const metalEncoderListXml = `<?xml version="1.0"?>
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
    <row><start-time fmt="00:00.000.000">0</start-time><duration fmt="6.00 ms">6000000</duration><thread fmt="Render Thread 0x2 (ProbeFixture, pid: 123)"><tid>2</tid></thread><process fmt="ProbeFixture (123)"><pid>123</pid></process><gpu-device fmt="Apple GPU">Apple GPU</gpu-device><gpu-frame-number fmt="Frame 1">1</gpu-frame-number><cmdbuffer-label fmt="Frame 1 Buffer">Frame 1 Buffer</cmdbuffer-label><cmdbuffer-label-indexed fmt="Frame 1 Buffer [1]">Frame 1 Buffer [1]</cmdbuffer-label-indexed><encoder-label fmt="Vertex Pass">Vertex Pass</encoder-label><encoder-label-indexed fmt="Vertex Pass [1]">Vertex Pass [1]</encoder-label-indexed><event-type fmt="Render">Render</event-type><cmdbuffer-id fmt="100">100</cmdbuffer-id><encoder-id fmt="10">10</encoder-id></row>
    <row><start-time fmt="00:00.005.000">5000000</start-time><duration fmt="11.00 ms">11000000</duration><thread fmt="Render Thread 0x2 (ProbeFixture, pid: 123)"><tid>2</tid></thread><process fmt="ProbeFixture (123)"><pid>123</pid></process><gpu-device fmt="Apple GPU">Apple GPU</gpu-device><gpu-frame-number fmt="Frame 1">1</gpu-frame-number><cmdbuffer-label fmt="Frame 1 Buffer">Frame 1 Buffer</cmdbuffer-label><cmdbuffer-label-indexed fmt="Frame 1 Buffer [1]">Frame 1 Buffer [1]</cmdbuffer-label-indexed><encoder-label fmt="Fragment Pass">Fragment Pass</encoder-label><encoder-label-indexed fmt="Fragment Pass [1]">Fragment Pass [1]</encoder-label-indexed><event-type fmt="Render">Render</event-type><cmdbuffer-id fmt="100">100</cmdbuffer-id><encoder-id fmt="11">11</encoder-id></row>
    <row><start-time fmt="00:00.020.000">20000000</start-time><duration fmt="12.00 ms">12000000</duration><thread fmt="Render Thread 0x2 (ProbeFixture, pid: 123)"><tid>2</tid></thread><process fmt="ProbeFixture (123)"><pid>123</pid></process><gpu-device fmt="Apple GPU">Apple GPU</gpu-device><gpu-frame-number fmt="Frame 2">2</gpu-frame-number><cmdbuffer-label fmt="Frame 2 Buffer">Frame 2 Buffer</cmdbuffer-label><cmdbuffer-label-indexed fmt="Frame 2 Buffer [2]">Frame 2 Buffer [2]</cmdbuffer-label-indexed><encoder-label fmt="Fragment Pass">Fragment Pass</encoder-label><encoder-label-indexed fmt="Fragment Pass [2]">Fragment Pass [2]</encoder-label-indexed><event-type fmt="Render">Render</event-type><cmdbuffer-id fmt="101">101</cmdbuffer-id><encoder-id fmt="12">12</encoder-id></row>
  </node>
</trace-query-result>`

const loadPerfFixture = (name: string) =>
  readFileSync(join(import.meta.dir, "..", "test-fixtures", "perf", name), "utf8")

const buildGenericPerfExportXml = (schema: string) => `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[1]'>
    <schema name="${schema}">
      <col><mnemonic>value</mnemonic></col>
    </schema>
    <row><value fmt="example">example</value></row>
  </node>
</trace-query-result>`

const withTempRoot = async <T>(run: (root: string) => Promise<T>) => {
  const root = await mkdtemp(join(tmpdir(), "probe-perf-service-"))

  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const createArtifactStore = () => {
  const artifacts: Array<ArtifactRecord> = []

  return {
    artifacts,
    service: {
      registerArtifact: (_sessionId: string, record: ArtifactRecord) =>
        Effect.sync(() => {
          artifacts.push(record)
          return record
        }),
      getArtifact: (sessionId: string, artifactKey: string) => {
        const artifact = artifacts.find((entry) => entry.key === artifactKey)

        return artifact
          ? Effect.succeed(artifact)
          : Effect.fail(new ArtifactNotFoundError({
              sessionId,
              artifactKey,
              nextStep: "none",
            }))
      },
    },
  }
}

// PRB-097: registers an already-recorded trace artifact directly (bypassing
// record()) so exportSchema()/analyzeTrace() tests exercise the lazy-access
// path -- `perf.export`/`perf.analyze` start from a stored artifact key, not
// a live trace lease. Deliberately does not pre-register a sibling `-toc`
// artifact: resolveTraceAnalysisContext's self-heal (re-derive the TOC via a
// fresh `xctrace export --toc`) is exercised by every test that uses this,
// matching the existing summarizeBySignpost fixture pattern below.
const registerTraceFixture = async (args: {
  readonly artifactStore: ReturnType<typeof createArtifactStore>
  readonly root: string
  readonly slug: string
  readonly targetProcessId?: number
}) => {
  const tracesDirectory = join(args.root, "traces")
  const tracePath = join(tracesDirectory, `${args.slug}.trace`)
  await mkdir(tracePath, { recursive: true })

  if (args.targetProcessId !== undefined) {
    await writeFile(
      join(tracesDirectory, `${args.slug}.perf-meta.json`),
      `${JSON.stringify({ targetProcessId: args.targetProcessId }, null, 2)}\n`,
      "utf8",
    )
  }

  return Effect.runPromise(
    args.artifactStore.service.registerArtifact("session-1", {
      key: `${args.slug}-trace`,
      label: `${args.slug}-trace`,
      kind: "directory",
      summary: `${args.slug} trace`,
      absolutePath: tracePath,
      relativePath: `traces/${args.slug}.trace`,
      external: false,
      createdAt: "2026-04-14T00:00:00.000Z",
    }),
  )
}

const createSessionHealth = (
  root: string,
  state: "ready" | "degraded" | "failed",
  options?: {
    readonly wrapperRunning?: boolean
    readonly lastOk?: boolean | null
    readonly runnerActionsBlocked?: boolean
    readonly reason?: string | null
  },
) => ({
  sessionId: "session-1",
  state,
  openedAt: "2026-04-10T00:00:00.000Z",
  updatedAt: "2026-04-10T00:00:00.000Z",
  expiresAt: "2026-04-10T01:00:00.000Z",
  artifactRoot: root,
  target: {
    platform: "simulator",
    bundleId: "dev.probe.fixture",
    deviceId: "sim-1",
    deviceName: "iPhone 15",
    runtime: "iOS 18.0",
  },
  connection: {
    status: "connected",
    checkedAt: "2026-04-10T00:00:00.000Z",
    summary: "Simulator connected.",
    details: [],
  },
  resources: {
    runner: state === "failed" ? "failed" : "ready",
    debugger: "not-requested",
    logs: "not-requested",
    trace: "not-requested",
  },
  transport: {
    kind: "simulator-runner",
    contract: "probe.runner.transport/hybrid-v1",
    bootstrapSource: "simulator-bootstrap-manifest",
    bootstrapPath: "/tmp/bootstrap.json",
    sessionIdentifier: "session-1",
    commandIngress: "http-post",
    eventEgress: "stdout-jsonl-mixed-log",
    stdinProbeStatus: "not-required-http",
    note: "test transport",
  },
  runner: {
    kind: "simulator-runner",
    wrapperProcessId: 456,
    testProcessId: 789,
    targetProcessId: 123,
    attachLatencyMs: 10,
    runtimeControlDirectory: "/tmp/runtime-control",
    observerControlDirectory: "/tmp/observer-control",
    logPath: "/tmp/runner.log",
    buildLogPath: "/tmp/build.log",
    stdoutEventsPath: "/tmp/stdout.ndjson",
    resultBundlePath: "/tmp/result.xcresult",
    wrapperStderrPath: "/tmp/wrapper.stderr.log",
    stdinProbeStatus: "not-required-http",
  },
  healthCheck: {
    checkedAt: "2026-04-10T00:00:00.000Z",
    wrapperRunning: options?.wrapperRunning ?? state !== "failed",
    pingRttMs: state === "ready" ? 4 : null,
    lastCommand: "ping",
    lastOk: options?.lastOk ?? (state === "ready" ? true : false),
  },
  coordination: {
    runnerActionsBlocked: options?.runnerActionsBlocked ?? false,
    reason: options?.reason ?? null,
  },
  debugger: {
    attachState: "not-attached",
    targetScope: null,
    bridgePid: null,
    bridgeStartedAt: null,
    bridgeExitedAt: null,
    pythonExecutable: null,
    lldbPythonPath: null,
    lldbVersion: null,
    attachedPid: null,
    processState: null,
    stopId: null,
    stopReason: null,
    stopDescription: null,
    lastCommand: null,
    lastCommandOk: null,
    lastUpdatedAt: null,
    frameLogArtifactKey: null,
    stderrArtifactKey: null,
  },
  warnings: [],
  artifacts: [],
}) as any

// PRB-096: a raw record()'s target-process lease -- matches the pid/device
// createSessionHealth's "runner" fixture advertises, so the identity check
// stubbed in createCommandRunner's `ps` branch lines up with it.
const createTraceLeaseHandle = (root: string) => ({
  target: {
    sessionId: "session-1",
    platform: "simulator" as const,
    deviceId: "sim-1",
    deviceName: "iPhone 15",
    bundleId: "dev.probe.fixture",
    targetProcessId: 123,
    artifactRoot: root,
  },
  signal: new AbortController().signal,
})

/**
 * PRB-096: default SessionRegistry mock for record()/recordAroundFlow()
 * tests -- `beginTraceLease`/`endTraceLease`/`peekSessionHealth` succeed by
 * default (mirroring `getSessionHealth`/`sendRunnerKeepalive`'s existing
 * "ready" defaults) so most tests only need to override what they actually
 * exercise.
 */
const createSessionRegistryMock = (root: string, overrides?: Record<string, unknown>) => ({
  getSessionHealth: () => Effect.succeed(createSessionHealth(root, "ready")),
  sendRunnerKeepalive: () => Effect.void,
  peekSessionHealth: () => Effect.succeed(createSessionHealth(root, "ready")),
  beginTraceLease: () => Effect.succeed(createTraceLeaseHandle(root)),
  endTraceLease: () => Effect.void,
  ...overrides,
})

const createCommandRunner = (options: {
  readonly exports: Record<string, string>
  readonly tocXml?: string
  readonly onExport?: (args: {
    readonly outputPath: string
    readonly schema: string
    readonly budget: { readonly maxBytes: number; readonly maxRows: number }
  }) => Promise<void> | void
  readonly recordDelayMs?: number
  readonly onStartRecording?: (args: {
    readonly command: string
    readonly commandArgs: ReadonlyArray<string>
    readonly startupNotificationKey: string
    readonly startupTimeoutMs: number
    readonly timeoutMs: number
    readonly gracePeriodMs?: number
  }) => Promise<void> | void
  readonly stopRecordingResult?: {
    readonly stdout: string
    readonly stderr: string
    readonly exitCode: number | null
    readonly wasRunning: boolean
  }
  /** PRB-096: override the `ps -p <pid> -o pid=,comm=` identity-check response (e.g. to simulate a dead/reused pid). */
  readonly identityCheckResult?: {
    readonly stdout: string
    readonly stderr: string
    readonly exitCode: number | null
  }
}) => {
  const stats = {
    captureCalls: 0,
    exportCalls: 0,
    budgets: [] as Array<{ schema: string; maxBytes: number; maxRows: number }>,
    startRecordingCalls: 0,
  }

  return {
    stats,
    runner: {
      capture: async (args: {
        readonly commandArgs: ReadonlyArray<string>
        readonly command: string
        readonly timeoutMs: number
        readonly allowFailure?: boolean
      }) => {
        stats.captureCalls += 1

        // PRB-096: the fresh pre-spawn target-process identity check `ps -p
        // <pid> -o pid=,comm=` -- succeeds by default so every existing
        // record() test reaches recording without per-test wiring; the
        // stdout deliberately includes the fixture's simulator deviceId
        // ("sim-1", see createSessionHealth) since that is what the
        // simulator identity check matches against.
        if (args.command === "ps") {
          if (options.identityCheckResult) {
            return options.identityCheckResult
          }

          const pid = args.commandArgs[1] ?? "123"
          return {
            stdout: `${pid}  /Users/x/Library/Developer/CoreSimulator/Devices/sim-1/data/Containers/Bundle/Application/X/ProbeFixture.app/ProbeFixture`,
            stderr: "",
            exitCode: 0,
          }
        }

        if (args.command !== "xcrun") {
          throw new Error(`Unexpected command ${args.command}`)
        }

        if (args.commandArgs[0] === "xctrace" && args.commandArgs[1] === "list") {
          return {
            stdout: "Time Profiler\nSystem Trace\nMetal System Trace\nSwift Concurrency\nHangs\nLogging\n",
            stderr: "",
            exitCode: 0,
          }
        }

        if (args.commandArgs[0] === "xctrace" && args.commandArgs[1] === "version") {
          return {
            stdout: "xctrace 26.0 (17C529)\n",
            stderr: "",
            exitCode: 0,
          }
        }

        if (args.commandArgs[0] === "xctrace" && args.commandArgs[1] === "record") {
          const outputIndex = args.commandArgs.indexOf("--output")
          const outputPath = args.commandArgs[outputIndex + 1]

          if (!outputPath) {
            throw new Error("Missing --output path in record stub")
          }

          if (options.recordDelayMs !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, options.recordDelayMs))
          }

          await mkdir(outputPath, { recursive: true })
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
          }
        }

        if (args.commandArgs[0] === "xctrace" && args.commandArgs[1] === "export" && args.commandArgs.includes("--toc")) {
          return {
            stdout: options.tocXml ?? tocXml,
            stderr: "",
            exitCode: 0,
          }
        }

        throw new Error(`Unexpected capture invocation: ${args.commandArgs.join(" ")}`)
      },
      exportToFile: async (args: {
        readonly command: string
        readonly commandArgs: ReadonlyArray<string>
        readonly timeoutMs: number
        readonly outputPath: string
        readonly budget: { readonly maxBytes: number; readonly maxRows: number }
        readonly budgetPolicy?: "fail" | "truncate"
      }) => {
        stats.exportCalls += 1

        const xpathIndex = args.commandArgs.indexOf("--xpath")
        const xpath = args.commandArgs[xpathIndex + 1]
        const schemaMatch = xpath?.match(/@schema="([^"]+)"\]/)
        const schema = schemaMatch ? schemaMatch[1] : undefined

        if (!schema) {
          throw new Error(`Missing schema in xpath ${String(xpath)}`)
        }

        stats.budgets.push({ schema, ...args.budget })

        const xml = options.exports[schema]

        if (!xml) {
          throw new Error(`Missing XML fixture for schema ${schema}`)
        }

        await writeFile(args.outputPath, xml, "utf8")
        try {
          await options.onExport?.({ outputPath: args.outputPath, schema, budget: args.budget })
        } catch (error) {
          if (
            error instanceof ExportBudgetExceededError
            && args.budgetPolicy === "truncate"
          ) {
            return {
              stdout: "",
              stderr: "",
              exitCode: 0,
              bytesWritten: Buffer.byteLength(xml, "utf8"),
              rowCount: (xml.match(/<row>/g) ?? []).length,
              truncated: true,
            }
          }

          throw error
        }

        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          bytesWritten: Buffer.byteLength(xml, "utf8"),
          rowCount: (xml.match(/<row>/g) ?? []).length,
          truncated: false,
        }
      },
      startRecording: async (args: {
        readonly command: string
        readonly commandArgs: ReadonlyArray<string>
        readonly startupNotificationKey: string
        readonly startupTimeoutMs: number
        readonly timeoutMs: number
        readonly gracePeriodMs?: number
      }) => {
        stats.startRecordingCalls += 1

        const outputIndex = args.commandArgs.indexOf("--output")
        const outputPath = args.commandArgs[outputIndex + 1]

        if (!outputPath) {
          throw new Error("Missing --output path in startRecording stub")
        }

        await mkdir(outputPath, { recursive: true })
        await options.onStartRecording?.(args)

        return {
          stop: async () => options.stopRecordingResult ?? {
            stdout: "",
            stderr: "",
            exitCode: 0,
            wasRunning: true,
          },
        }
      },
    },
  }
}

const neverReachedDaemonClient = DaemonClient.of({
  ping: () => Effect.die("unexpected daemon client call"),
  listSessions: () => Effect.die("unexpected daemon client call"),
  openSession: () => Effect.die("unexpected daemon client call"),
  showSession: () => Effect.die("unexpected daemon client call"),
  getSessionHealth: () => Effect.die("unexpected daemon client call"),
  closeSession: () => Effect.die("unexpected daemon client call"),
  getSessionLogs: () => Effect.die("unexpected daemon client call"),
  markSessionLog: () => Effect.die("unexpected daemon client call"),
  captureLogWindow: () => Effect.die("unexpected daemon client call"),
  getLogDoctorReport: () => Effect.die("unexpected daemon client call"),
  captureDiagnosticBundle: () => Effect.die("unexpected daemon client call"),
  runSessionDebugCommand: () => Effect.die("unexpected daemon client call"),
  captureScreenshot: () => Effect.die("unexpected daemon client call"),
  recordVideo: () => Effect.die("unexpected daemon client call"),
  captureSnapshot: () => Effect.die("unexpected daemon client call"),
  performSessionAction: () => Effect.die("unexpected daemon client call"),
  runSessionFlow: () => Effect.die("unexpected daemon client call"),
  exportSessionRecording: () => Effect.die("unexpected daemon client call"),
  replaySessionRecording: () => Effect.die("unexpected daemon client call"),
  getSessionResultSummary: () => Effect.die("unexpected daemon client call"),
  getSessionResultAttachments: () => Effect.die("unexpected daemon client call"),
  recordPerf: () => Effect.die("unexpected daemon client call"),
  recordPerfAroundFlow: () => Effect.die("unexpected daemon client call"),
  summarizePerfBySignpost: () => Effect.die("unexpected daemon client call"),
  exportPerfSchema: () => Effect.die("unexpected daemon client call"),
  analyzePerfTrace: () => Effect.die("unexpected daemon client call"),
  drillArtifact: () => Effect.die("unexpected daemon client call"),
})

describe("PerfService", () => {
  // PRB-096: raw record's `session` outcome now comes from a passive
  // `peekSessionHealth` read, never a fresh `getSessionHealth` ping -- these
  // two tests replace the pre-PRB-096 "records a trace and reports a
  // failed/degraded post-record session" tests, which asserted the old
  // ping-and-refresh behavior the superseding gate removes from the raw
  // path ("post-record runner health refresh").
  test("raw record reports peekSessionHealth's snapshot and never calls getSessionHealth", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      let getSessionHealthCalls = 0
      const sessionRegistry = createSessionRegistryMock(root, {
        getSessionHealth: () => {
          getSessionHealthCalls += 1
          return Effect.succeed(createSessionHealth(root, "ready"))
        },
        peekSessionHealth: () =>
          Effect.succeed(createSessionHealth(root, "failed", { wrapperRunning: false, lastOk: false })),
      })
      const commandRunner = createCommandRunner({
        exports: {
          "time-sample": timeProfilerXml,
        },
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        perfService.record({
          sessionId: "session-1",
          template: "time-profiler",
          timeLimit: "3s",
          emitProgress: () => undefined,
        }),
      )

      expect(getSessionHealthCalls).toBe(0)
      expect(result.session.state).toBe("failed")
      expect(result.diagnoses.some((diagnosis) => diagnosis.code === "perf-target-identity-verified")).toBe(true)
      // PRB-097: record() is trace-first -- no schema export artifact.
      expect(artifactStore.artifacts.map((artifact) => artifact.label)).toEqual([
        "time-profiler-trace",
        "time-profiler-toc",
      ])
      expect(commandRunner.stats.exportCalls).toBe(0)
    })
  })

  test("raw record acquires and releases exactly one trace lease, reporting a stopped outcome on success", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const leaseCalls: Array<string> = []
      const sessionRegistry = createSessionRegistryMock(root, {
        beginTraceLease: () => {
          leaseCalls.push("begin")
          return Effect.succeed(createTraceLeaseHandle(root))
        },
        endTraceLease: (_sessionId: string, outcome: { readonly kind: string }) => {
          leaseCalls.push(`end:${outcome.kind}`)
          return Effect.void
        },
      })
      const commandRunner = createCommandRunner({
        exports: {
          "time-sample": timeProfilerXml,
        },
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      await Effect.runPromise(
        perfService.record({
          sessionId: "session-1",
          template: "time-profiler",
          timeLimit: "3s",
          emitProgress: () => undefined,
        }),
      )

      expect(leaseCalls).toEqual(["begin", "end:stopped"])
    })
  })

  // PRB-096: replaces the pre-PRB-096 "sends runner keepalives during slow
  // recordings" test with its exact inverse -- the raw path must send none,
  // before, during, or after the xctrace record command.
  test("raw record sends no runner keepalives, even during a slow recording", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      let keepaliveCalls = 0
      const sessionRegistry = createSessionRegistryMock(root, {
        sendRunnerKeepalive: () =>
          Effect.sync(() => {
            keepaliveCalls += 1
          }),
      })
      const commandRunner = createCommandRunner({
        exports: {
          "time-sample": timeProfilerXml,
        },
        recordDelayMs: 50,
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        perfService.record({
          sessionId: "session-1",
          template: "time-profiler",
          timeLimit: "3s",
          emitProgress: () => undefined,
        }),
      )

      expect(result.template).toBe("time-profiler")
      expect(keepaliveCalls).toBe(0)
    })
  })

  test("a dead/reused target pid returns a typed pre-spawn error and starts no xctrace record", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const leaseCalls: Array<string> = []
      const sessionRegistry = createSessionRegistryMock(root, {
        beginTraceLease: () => {
          leaseCalls.push("begin")
          return Effect.succeed(createTraceLeaseHandle(root))
        },
        endTraceLease: (_sessionId: string, outcome: { readonly kind: string }) => {
          leaseCalls.push(`end:${outcome.kind}`)
          return Effect.void
        },
      })
      const commandRunner = createCommandRunner({
        exports: { "time-sample": timeProfilerXml },
        // The target pid is no longer alive by the time raw record verifies
        // identity immediately before spawning xctrace.
        identityCheckResult: { stdout: "", stderr: "", exitCode: 1 },
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        Effect.either(
          perfService.record({
            sessionId: "session-1",
            template: "time-profiler",
            timeLimit: "3s",
            emitProgress: () => undefined,
          }),
        ),
      )

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(EnvironmentError)
        if (result.left instanceof EnvironmentError) {
          expect(result.left.code).toBe("perf-target-process-not-found")
        }
      }

      // No `xctrace record` (or any other xctrace capture) ever ran, and the
      // lease is still released -- as "failed" -- even though the failure
      // happened before recording started.
      expect(commandRunner.stats.captureCalls).toBe(1)
      expect(artifactStore.artifacts).toHaveLength(0)
      expect(leaseCalls).toEqual(["begin", "end:failed"])
    })
  })

  test("rejects nonexistent custom template paths before recording starts", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const commandRunner = createCommandRunner({ exports: {} })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        Effect.either(
          perfService.record({
            sessionId: "session-1",
            customTemplatePath: join(root, "missing.tracetemplate"),
            timeLimit: "3s",
            emitProgress: () => undefined,
          }),
        ),
      )

      expect(Either.isLeft(result)).toBe(true)
      expect(commandRunner.stats.captureCalls).toBe(0)

      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(UserInputError)

        if (result.left instanceof UserInputError) {
          expect(result.left.code).toBe("perf-custom-template-read")
          expect(result.left.reason).toContain("missing.tracetemplate")
        }
      }
    })
  })

  test("rejects custom template paths with the wrong extension", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const commandRunner = createCommandRunner({ exports: {} })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })
      const wrongPath = join(root, "custom-template.txt")

      await writeFile(wrongPath, "not a template", "utf8")

      const result = await Effect.runPromise(
        Effect.either(
          perfService.record({
            sessionId: "session-1",
            customTemplatePath: wrongPath,
            timeLimit: "3s",
            emitProgress: () => undefined,
          }),
        ),
      )

      expect(Either.isLeft(result)).toBe(true)
      expect(commandRunner.stats.captureCalls).toBe(0)

      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(UserInputError)

        if (result.left instanceof UserInputError) {
          expect(result.left.code).toBe("perf-custom-template-extension")
          expect(result.left.reason).toContain(".tracetemplate")
        }
      }
    })
  })

  // PRB-097: record() is trace-first -- a custom template exposing many
  // schemas returns trace + TOC + a compact schema catalog, never forty
  // (or here, two) eager exports.
  test("record() returns a compact schema catalog with zero export subprocesses for a custom template", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const templatePath = join(root, "GPU Counters.tracetemplate")

      await writeFile(templatePath, "custom-template", "utf8")

      const commandRunner = createCommandRunner({
        tocXml: customTemplateTocXml,
        exports: {
          "custom-main": buildGenericPerfExportXml("custom-main"),
          "custom-secondary": buildGenericPerfExportXml("custom-secondary"),
        },
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        perfService.record({
          sessionId: "session-1",
          customTemplatePath: templatePath,
          timeLimit: "3s",
          emitProgress: () => undefined,
        }),
      )

      expect(result.template).toBe("custom")
      expect(result.templateName).toBe("GPU Counters")
      expect(result.customTemplatePath).toBe(templatePath)
      expect(result.schemas).toEqual([{ schema: "custom-main" }, { schema: "custom-secondary" }])
      expect(result.summary.headline).toContain("2 schema(s)")
      expect(artifactStore.artifacts.map((artifact) => artifact.label)).toEqual(["custom-trace", "custom-toc"])
      expect(commandRunner.stats.exportCalls).toBe(0)
      expect(commandRunner.stats.budgets).toEqual([])
    })
  })

  test("rejects mutually exclusive perf record template flags", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        runPerfCommand([
          "record",
          "--session-id",
          "session-1",
          "--template",
          "logging",
          "--custom-template",
          "/tmp/custom.tracetemplate",
          "--json",
        ]).pipe(Effect.provideService(DaemonClient, neverReachedDaemonClient)),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)

    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(UserInputError)

      if (result.left instanceof UserInputError) {
        expect(result.left.code).toBe("invalid-option")
        expect(result.left.reason).toContain("--custom-template")
        expect(result.left.reason).toContain("cannot be combined with --template")
      }
    }
  })

  test("rejects over-long system trace windows before xctrace runs", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const commandRunner = createCommandRunner({ exports: {} })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        Effect.either(
          perfService.record({
            sessionId: "session-1",
            template: "system-trace",
            timeLimit: "16s",
            emitProgress: () => undefined,
          }),
        ),
      )

      expect(Either.isLeft(result)).toBe(true)
      expect(commandRunner.stats.captureCalls).toBe(0)
      expect(commandRunner.stats.exportCalls).toBe(0)

      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(EnvironmentError)

        if (result.left instanceof EnvironmentError) {
          expect(result.left.code).toBe("perf-template-time-limit-too-large")
        }
      }
    })
  })

  test("rejects metal trace windows above the 120 second cap before xctrace runs", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const commandRunner = createCommandRunner({ exports: {} })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        Effect.either(
          perfService.record({
            sessionId: "session-1",
            template: "metal-system-trace",
            timeLimit: "121s",
            emitProgress: () => undefined,
          }),
        ),
      )

      expect(Either.isLeft(result)).toBe(true)
      expect(commandRunner.stats.captureCalls).toBe(0)
      expect(commandRunner.stats.exportCalls).toBe(0)

      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(EnvironmentError)

        if (result.left instanceof EnvironmentError) {
          expect(result.left.code).toBe("perf-template-time-limit-too-large")
          expect(result.left.reason).toContain("2m")
        }
      }
    })
  })


  test("records a trace around a bounded flow and returns the flow report", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const events: Array<string> = []
      const sessionRegistry = createSessionRegistryMock(root, {
        runFlow: () =>
          Effect.sync(() => {
            events.push("run-flow")
            return {
              contract: "probe.session-flow/report-v2",
              executedAt: "2026-04-14T00:00:00.000Z",
              sessionId: "session-1",
              summary: "bounded flow passed",
              verdict: "passed",
              executedSteps: [],
              failedStep: null,
              retries: 0,
              artifacts: [],
              finalSnapshotId: null,
              warnings: [],
            } as const
          }),
      })
      const commandRunner = createCommandRunner({
        exports: {},
        onStartRecording: async () => {
          events.push("start-recording")
        },
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        perfService.recordAroundFlow({
          sessionId: "session-1",
          template: "logging",
          flow: {
            contract: "probe.session-flow/v2",
            steps: [{ kind: "sleep", durationMs: 250 }],
          },
          emitProgress: () => undefined,
        }),
      )

      expect(commandRunner.stats.startRecordingCalls).toBe(1)
      expect(events).toEqual(["start-recording", "run-flow"])
      expect(result.template).toBe("logging")
      expect(result.flow.verdict).toBe("passed")
      expect(result.artifacts.trace.kind).toBe("directory")
      expect(artifactStore.artifacts.map((artifact) => artifact.label)).toEqual([
        "logging-trace",
        "logging-toc",
      ])
    })
  })

  // PRB-096 gate 8: "UI failure after flow completion cannot discard a
  // completed trace" -- the post-flow session-health refresh is UI/runner
  // work that happens strictly after the trace itself is done and its
  // artifacts are already registered; a failure there must degrade the
  // reported `session` outcome, not the whole result.
  test("a post-flow session health failure degrades the result instead of discarding the completed trace", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      let healthChecks = 0
      const sessionRegistry = createSessionRegistryMock(root, {
        getSessionHealth: () => {
          healthChecks += 1
          return healthChecks === 1
            ? Effect.succeed(createSessionHealth(root, "ready"))
            : Effect.fail(
                new EnvironmentError({
                  code: "session-runner-ping",
                  reason: "Runner wrapper stopped responding after the bounded flow completed.",
                  nextStep: "Reopen the session.",
                  details: [],
                }),
              )
        },
        runFlow: () =>
          Effect.succeed({
            contract: "probe.session-flow/report-v2",
            executedAt: "2026-04-14T00:00:00.000Z",
            sessionId: "session-1",
            summary: "bounded flow passed",
            verdict: "passed",
            executedSteps: [],
            failedStep: null,
            retries: 0,
            artifacts: [],
            finalSnapshotId: null,
            warnings: [],
          } as const),
      })
      const commandRunner = createCommandRunner({ exports: {} })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        perfService.recordAroundFlow({
          sessionId: "session-1",
          template: "logging",
          flow: {
            contract: "probe.session-flow/v2",
            steps: [{ kind: "sleep", durationMs: 10 }],
          },
          emitProgress: () => undefined,
        }),
      )

      // The result still comes back -- carrying the completed trace -- not
      // an EnvironmentError from the failed health refresh.
      expect(result.flow.verdict).toBe("passed")
      expect(result.session.state).toBe("degraded")
      expect(result.diagnoses.some((diagnosis) => diagnosis.code === "perf-session-degraded-after-record")).toBe(true)
      expect(result.artifacts.trace.kind).toBe("directory")
      expect(artifactStore.artifacts.map((artifact) => artifact.label)).toEqual([
        "logging-trace",
        "logging-toc",
      ])
    })
  })

  test("summarizes signpost intervals by interval name", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const tracePath = join(root, "traces", "logging.trace")

      await mkdir(tracePath, { recursive: true })
      await Effect.runPromise(
        artifactStore.service.registerArtifact("session-1", {
          key: "logging-trace",
          label: "logging-trace",
          kind: "directory",
          summary: "logging trace",
          absolutePath: tracePath,
          relativePath: "traces/logging.trace",
          external: false,
          createdAt: "2026-04-14T00:00:00.000Z",
        }),
      )

      const sessionRegistry = createSessionRegistryMock(root)
      const commandRunner = createCommandRunner({
        tocXml: loggingTocWithSignpostSchemaXml,
        exports: {
          "os-signpost-interval": signpostIntervalsXml,
        },
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        perfService.summarizeBySignpost({
          sessionId: "session-1",
          artifactKey: "logging-trace",
          emitProgress: () => undefined,
        }),
      )

      expect(result.groupBy).toBe("signpost")
      expect(result.totalIntervals).toBe(3)
      expect(result.groups).toHaveLength(2)
      expect(result.groups[0]).toMatchObject({
        intervalName: "loadData",
        count: 2,
        minDurationNs: 10_000_000,
        maxDurationNs: 20_000_000,
        wallTimeNs: 30_000_000,
      })
      expect(result.groups[1]).toMatchObject({
        intervalName: "renderFrame",
        count: 1,
        avgDurationNs: 5_000_000,
      })
      expect(artifactStore.artifacts.map((artifact) => artifact.label)).toContain("signpost-intervals")
    })
  })

  test("wraps signpost export command failures in a typed environment error", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const tracePath = join(root, "traces", "logging.trace")

      await mkdir(tracePath, { recursive: true })
      await Effect.runPromise(
        artifactStore.service.registerArtifact("session-1", {
          key: "logging-trace",
          label: "logging-trace",
          kind: "directory",
          summary: "logging trace",
          absolutePath: tracePath,
          relativePath: "traces/logging.trace",
          external: false,
          createdAt: "2026-04-14T00:00:00.000Z",
        }),
      )

      const sessionRegistry = createSessionRegistryMock(root)
      const baseRunner = createCommandRunner({
        tocXml: loggingTocWithSignpostSchemaXml,
        exports: {},
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: {
          capture: baseRunner.runner.capture,
          exportToFile: async (args) => {
            throw new ChildProcessError({
              code: "command-failed",
              command: `${args.command} ${args.commandArgs.join(" ")}`,
              reason: "xcrun exited with code 1",
              nextStep: "Inspect stderr and retry.",
              exitCode: 1,
              stderrExcerpt: "No data found matching export query",
            })
          },
        },
      })

      const result = await Effect.runPromise(
        Effect.either(
          perfService.summarizeBySignpost({
            sessionId: "session-1",
            artifactKey: "logging-trace",
            emitProgress: () => undefined,
          }),
        ),
      )

      expect(Either.isLeft(result)).toBe(true)
      expect(artifactStore.artifacts.map((artifact) => artifact.label)).toEqual([
        "logging-trace",
        "signpost-toc",
      ])

      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(EnvironmentError)
        expect(result.left).not.toBeInstanceOf(ChildProcessError)

        if (result.left instanceof EnvironmentError) {
          expect(result.left.code).toBe("perf-export-schema-failed")
          expect(result.left.reason).toContain("os-signpost-interval")
          expect(result.left.reason).toContain("code 1")
          expect(result.left.details).toContain("schema: os-signpost-interval")
          expect(result.left.details).toContain("stderr: No data found matching export query")
        }
      }
    })
  })

  test("returns an empty signpost summary when export contains zero interval rows", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const tracePath = join(root, "traces", "logging.trace")

      await mkdir(tracePath, { recursive: true })
      await Effect.runPromise(
        artifactStore.service.registerArtifact("session-1", {
          key: "logging-trace",
          label: "logging-trace",
          kind: "directory",
          summary: "logging trace",
          absolutePath: tracePath,
          relativePath: "traces/logging.trace",
          external: false,
          createdAt: "2026-04-14T00:00:00.000Z",
        }),
      )

      const sessionRegistry = createSessionRegistryMock(root)
      const commandRunner = createCommandRunner({
        tocXml: loggingTocWithSignpostSchemaXml,
        exports: {
          "os-signpost-interval": emptySignpostIntervalsXml,
        },
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        perfService.summarizeBySignpost({
          sessionId: "session-1",
          artifactKey: "logging-trace",
          emitProgress: () => undefined,
        }),
      )

      expect(result.totalIntervals).toBe(0)
      expect(result.groups).toEqual([])
      expect(artifactStore.artifacts.map((artifact) => artifact.label)).toContain("signpost-intervals")
    })
  })

  test("fails with unsupported capability when the TOC omits the signpost interval schema", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const tracePath = join(root, "traces", "logging.trace")

      await mkdir(tracePath, { recursive: true })
      await Effect.runPromise(
        artifactStore.service.registerArtifact("session-1", {
          key: "logging-trace",
          label: "logging-trace",
          kind: "directory",
          summary: "logging trace",
          absolutePath: tracePath,
          relativePath: "traces/logging.trace",
          external: false,
          createdAt: "2026-04-14T00:00:00.000Z",
        }),
      )

      const sessionRegistry = createSessionRegistryMock(root)
      const commandRunner = createCommandRunner({
        tocXml: loggingTocWithoutSignpostSchemaXml,
        exports: {},
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        Effect.either(
          perfService.summarizeBySignpost({
            sessionId: "session-1",
            artifactKey: "logging-trace",
            emitProgress: () => undefined,
          }),
        ),
      )

      expect(Either.isLeft(result)).toBe(true)
      expect(commandRunner.stats.exportCalls).toBe(0)

      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(UnsupportedCapabilityError)

        if (result.left instanceof UnsupportedCapabilityError) {
          expect(result.left.code).toBe("perf-signpost-schema-missing")
          expect(result.left.capability).toBe("perf.summarize.group-by.signpost")
        }
      }
    })
  })
})

// PRB-097: exportSchema() -- one requested schema/XPath derivative, exported
// on demand from an already-recorded trace and cached by trace identity +
// run number + schema + XPath + xctrace version.
describe("PerfService exportSchema", () => {
  test("exports a requested schema on demand and registers a durable artifact (no raw XML returned inline)", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const traceArtifact = await registerTraceFixture({ artifactStore, root, slug: "time-profiler" })
      const commandRunner = createCommandRunner({ exports: { "time-sample": timeProfilerXml } })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        perfService.exportSchema({
          sessionId: "session-1",
          artifactKey: traceArtifact.key,
          schema: "time-sample",
          emitProgress: () => undefined,
        }),
      )

      expect(commandRunner.stats.exportCalls).toBe(1)
      expect(result.schema).toBe("time-sample")
      expect(result.cacheHit).toBe(false)
      expect(result.rowCount).toBeGreaterThan(0)
      expect(result.artifacts.export.kind).toBe("xml")
      expect(result.artifacts.export.absolutePath).toContain("time-sample")
      // The result carries an artifact reference, never the raw XML text.
      expect(Object.values(result)).not.toContain(timeProfilerXml)
    })
  })

  test("reuses a cached export without rerunning xctrace", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const traceArtifact = await registerTraceFixture({ artifactStore, root, slug: "time-profiler" })
      const commandRunner = createCommandRunner({ exports: { "time-sample": timeProfilerXml } })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })
      const request = {
        sessionId: "session-1",
        artifactKey: traceArtifact.key,
        schema: "time-sample",
        emitProgress: () => undefined,
      } as const

      const first = await Effect.runPromise(perfService.exportSchema(request))
      const second = await Effect.runPromise(perfService.exportSchema(request))

      expect(first.cacheHit).toBe(false)
      expect(second.cacheHit).toBe(true)
      expect(second.artifacts.export.key).toBe(first.artifacts.export.key)
      expect(commandRunner.stats.exportCalls).toBe(1)
    })
  })

  test("a different schema is a different cache entry and reruns xctrace", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const traceArtifact = await registerTraceFixture({ artifactStore, root, slug: "custom" })
      const commandRunner = createCommandRunner({
        tocXml: customTemplateTocXml,
        exports: {
          "custom-main": buildGenericPerfExportXml("custom-main"),
          "custom-secondary": buildGenericPerfExportXml("custom-secondary"),
        },
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const main = await Effect.runPromise(
        perfService.exportSchema({
          sessionId: "session-1",
          artifactKey: traceArtifact.key,
          schema: "custom-main",
          emitProgress: () => undefined,
        }),
      )
      const secondary = await Effect.runPromise(
        perfService.exportSchema({
          sessionId: "session-1",
          artifactKey: traceArtifact.key,
          schema: "custom-secondary",
          emitProgress: () => undefined,
        }),
      )

      expect(commandRunner.stats.exportCalls).toBe(2)
      expect(main.artifacts.export.key).not.toBe(secondary.artifacts.export.key)
    })
  })

  test("rejects a schema the TOC does not advertise", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const traceArtifact = await registerTraceFixture({ artifactStore, root, slug: "custom" })
      // A TOC that advertises schemas (unlike the default fixture, which
      // declares none) so the pre-flight "does the TOC expose this schema"
      // check has something to check against.
      const commandRunner = createCommandRunner({ tocXml: customTemplateTocXml, exports: {} })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        Effect.either(
          perfService.exportSchema({
            sessionId: "session-1",
            artifactKey: traceArtifact.key,
            schema: "does-not-exist",
            emitProgress: () => undefined,
          }),
        ),
      )

      expect(Either.isLeft(result)).toBe(true)
      expect(commandRunner.stats.exportCalls).toBe(0)

      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(UserInputError)

        if (result.left instanceof UserInputError) {
          expect(result.left.code).toBe("perf-export-schema-missing")
        }
      }
    })
  })

  // PRB-097: `perf.export`'s single explicit request always fails closed on
  // a budget overrun -- it never silently skips (that behavior is reserved
  // for analyzeTrace's optional schemas).
  test("fails closed (never skips) when the requested schema exceeds its export budget", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const traceArtifact = await registerTraceFixture({ artifactStore, root, slug: "time-profiler" })
      const commandRunner = createCommandRunner({
        exports: { "time-sample": timeProfilerXml },
        onExport: () => {
          throw new ExportBudgetExceededError({ kind: "rows", limit: 20_000, observed: 20_001 })
        },
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        Effect.either(
          perfService.exportSchema({
            sessionId: "session-1",
            artifactKey: traceArtifact.key,
            schema: "time-sample",
            emitProgress: () => undefined,
          }),
        ),
      )

      expect(Either.isLeft(result)).toBe(true)

      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(EnvironmentError)

        if (result.left instanceof EnvironmentError) {
          expect(result.left.code).toBe("perf-export-row-budget")
        }
      }
    })
  })

  test("maps an oversized export file into a typed environment failure", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const traceArtifact = await registerTraceFixture({ artifactStore, root, slug: "time-profiler" })
      const commandRunner = createCommandRunner({
        exports: { "time-sample": timeProfilerXml },
        onExport: async ({ outputPath, schema }) => {
          // Above the 32 MiB parse limit (maxExportFileSizeBytes).
          const largeContent = "x".repeat(33 * 1024 * 1024)
          await writeFile(outputPath, `<schema name="${schema}"></schema>${largeContent}`, "utf8")
        },
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        Effect.either(
          perfService.exportSchema({
            sessionId: "session-1",
            artifactKey: traceArtifact.key,
            schema: "time-sample",
            emitProgress: () => undefined,
          }),
        ),
      )

      expect(Either.isLeft(result)).toBe(true)

      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(EnvironmentError)

        if (result.left instanceof EnvironmentError) {
          expect(result.left.code).toBe("perf-export-file-too-large")
        }
      }
    })
  })
})

// PRB-097: analyzeTrace() -- lazily exports (and caches) only the schemas
// one named built-in analyzer needs, then runs that analyzer's existing,
// unchanged math. These replace the pre-PRB-097 record()-level assertions
// for the same behavior -- record() no longer runs any of this eagerly.
describe("PerfService analyzeTrace", () => {
  test("system-trace keeps a truncated optional export when it exceeds budget, using targeted budgets", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const traceArtifact = await registerTraceFixture({ artifactStore, root, slug: "system-trace", targetProcessId: 123 })
      const commandRunner = createCommandRunner({
        exports: {
          "thread-state": systemThreadOnlyXml,
          "cpu-state": systemCpuXml,
        },
        onExport: ({ schema }) => {
          if (schema === "cpu-state") {
            throw new ExportBudgetExceededError({ kind: "rows", limit: 50_000, observed: 50_001 })
          }
        },
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        perfService.analyzeTrace({
          sessionId: "session-1",
          artifactKey: traceArtifact.key,
          analyzer: "system-trace",
          emitProgress: () => undefined,
        }),
      )

      expect(commandRunner.stats.exportCalls).toBe(2)
      expect(commandRunner.stats.budgets).toEqual([
        { schema: "thread-state", maxBytes: 6 * mib, maxRows: 20_000 },
        { schema: "cpu-state", maxBytes: 12 * mib, maxRows: 50_000 },
      ])
      // Optional cpu-state is truncated and kept (not dropped) so dense exports stay useful.
      expect(result.artifacts.exports).toHaveLength(2)
      expect(result.diagnoses.some((d) => d.code === "perf-export-truncated")).toBe(true)
      expect(result.summary.headline).toContain("1 target thread intervals")
    })
  })

  test("system-trace keeps a truncated prefix when the required export exceeds its budget", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const traceArtifact = await registerTraceFixture({ artifactStore, root, slug: "system-trace", targetProcessId: 123 })
      const commandRunner = createCommandRunner({
        exports: {
          "thread-state": systemThreadOnlyXml,
          "cpu-state": systemCpuXml,
        },
        onExport: ({ schema }) => {
          if (schema === "thread-state") {
            throw new ExportBudgetExceededError({ kind: "rows", limit: 20_000, observed: 20_001 })
          }
        },
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        perfService.analyzeTrace({
          sessionId: "session-1",
          artifactKey: traceArtifact.key,
          analyzer: "system-trace",
          emitProgress: () => undefined,
        }),
      )

      // Required schema budget hit → prefix kept + optional still exported.
      expect(commandRunner.stats.exportCalls).toBe(2)
      expect(result.artifacts.exports.length).toBeGreaterThanOrEqual(1)
      expect(result.diagnoses.some((d) => d.code === "perf-export-truncated")).toBe(true)
      expect(result.summary.headline.length).toBeGreaterThan(0)
    })
  })

  test("system-trace fails with a typed error when the trace has no recorded target-pid metadata", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      // No `targetProcessId` -- simulates a trace recorded before PRB-097.
      const traceArtifact = await registerTraceFixture({ artifactStore, root, slug: "system-trace" })
      const sessionRegistry = createSessionRegistryMock(root)
      const commandRunner = createCommandRunner({
        exports: { "thread-state": systemThreadOnlyXml, "cpu-state": systemCpuXml },
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        Effect.either(
          perfService.analyzeTrace({
            sessionId: "session-1",
            artifactKey: traceArtifact.key,
            analyzer: "system-trace",
            emitProgress: () => undefined,
          }),
        ),
      )

      expect(Either.isLeft(result)).toBe(true)

      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(EnvironmentError)

        if (result.left instanceof EnvironmentError) {
          expect(result.left.code).toBe("perf-analyze-missing-target-pid")
        }
      }
    })
  })

  test("metal-system-trace analyzes gpu, driver, and encoder tables with the extended budgets", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const traceArtifact = await registerTraceFixture({ artifactStore, root, slug: "metal-system-trace" })
      const emptyCounterXml = (schema: string) => `<?xml version="1.0"?>
<trace-query-result>
  <node>
    <schema name="${schema}">
      <col><mnemonic>value</mnemonic></col>
      <col><mnemonic>counter-name</mnemonic></col>
    </schema>
  </node>
</trace-query-result>`
      const commandRunner = createCommandRunner({
        exports: {
          "metal-gpu-intervals": loadPerfFixture("metal-system-trace.metal-gpu-intervals.xml"),
          "metal-driver-event-intervals": metalDriverIntervalsXml,
          "metal-application-encoders-list": metalEncoderListXml,
          "gpu-counter-value": emptyCounterXml("gpu-counter-value"),
          "metal-gpu-counter-intervals": emptyCounterXml("metal-gpu-counter-intervals"),
          "displayed-surfaces-per-second": `<?xml version="1.0"?>
<trace-query-result>
  <node>
    <schema name="displayed-surfaces-per-second">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
      <col><mnemonic>count</mnemonic></col>
    </schema>
    <row><start-time>0</start-time><duration>1000000000</duration><uint32 fmt="58">58</uint32></row>
    <row><start-time>1000000000</start-time><duration>1000000000</duration><uint32 fmt="60">60</uint32></row>
  </node>
</trace-query-result>`,
        },
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        perfService.analyzeTrace({
          sessionId: "session-1",
          artifactKey: traceArtifact.key,
          analyzer: "metal-system-trace",
          emitProgress: () => undefined,
        }),
      )

      expect(commandRunner.stats.budgets).toEqual([
        { schema: "metal-gpu-intervals", maxBytes: 16 * mib, maxRows: 50_000 },
        { schema: "metal-driver-event-intervals", maxBytes: 8 * mib, maxRows: 25_000 },
        { schema: "metal-application-encoders-list", maxBytes: 24 * mib, maxRows: 50_000 },
        { schema: "gpu-counter-value", maxBytes: 8 * mib, maxRows: 50_000 },
        { schema: "metal-gpu-counter-intervals", maxBytes: 8 * mib, maxRows: 25_000 },
        { schema: "displayed-surfaces-per-second", maxBytes: 1 * mib, maxRows: 4_000 },
      ])
      // Empty counter tables omitted (0 rows); surface-rate + gpu/driver/encoder kept.
      expect(result.artifacts.exports.length).toBeGreaterThanOrEqual(4)
      expect(result.summary.metrics.find((metric) => metric.label === "Estimated FPS")?.value).toContain("fps")
      expect(result.summary.metrics.find((metric) => metric.label === "FPS source")?.value).toBe("displayed-surfaces-per-second")
      expect(result.summary.metrics.find((metric) => metric.label === "Per-encoder summary")?.value).toContain("command buffer")
      expect(result.summary.metrics.find((metric) => metric.label === "GPU counters")?.value).toBe("none exported")
      expect(result.diagnoses.some((d) => d.code === "metal-display-surface-fps")).toBe(true)
    })
  })

  test("hangs analyzer returns structured hang diagnostics", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const traceArtifact = await registerTraceFixture({ artifactStore, root, slug: "hangs" })
      const commandRunner = createCommandRunner({
        exports: {
          "potential-hangs": potentialHangsXml,
          "hang-risks": hangRisksXml,
        },
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        perfService.analyzeTrace({
          sessionId: "session-1",
          artifactKey: traceArtifact.key,
          analyzer: "hangs",
          emitProgress: () => undefined,
        }),
      )

      expect(result.artifacts.exports).toHaveLength(2)
      expect(result.summary.headline).toContain("Detected 2 hang events")
      expect(result.summary.metrics.find((metric) => metric.label === "Call stack hints")?.value).toBe("available")
      expect(result.diagnoses.find((diagnosis) => diagnosis.code === "hangs-longest-event")?.details.join(" ")).toContain("LayoutPass.render")
    })
  })

  test("swift-concurrency analyzer returns task and actor diagnostics", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const traceArtifact = await registerTraceFixture({ artifactStore, root, slug: "swift-concurrency" })
      const commandRunner = createCommandRunner({
        exports: {
          "swift-task-state": swiftTaskStateXml,
          "swift-task-lifetime": swiftTaskLifetimeXml,
          "swift-actor-execution": swiftActorExecutionXml,
        },
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        perfService.analyzeTrace({
          sessionId: "session-1",
          artifactKey: traceArtifact.key,
          analyzer: "swift-concurrency",
          emitProgress: () => undefined,
        }),
      )

      expect(result.artifacts.exports).toHaveLength(3)
      expect(result.summary.headline).toContain("Observed 2 Swift tasks")
      expect(result.summary.metrics.find((metric) => metric.label === "Task creations")?.value).toBe("2")
      expect(result.summary.metrics.find((metric) => metric.label === "Actor executions")?.value).toBe("2")
      expect(result.diagnoses.some((diagnosis) => diagnosis.code === "swift-concurrency-long-running-tasks")).toBe(true)
    })
  })

  test("surfaces export schema drift as a typed contract failure", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const traceArtifact = await registerTraceFixture({ artifactStore, root, slug: "time-profiler" })
      const commandRunner = createCommandRunner({
        exports: {
          "time-sample": timeProfilerXml.replace('<col><mnemonic>sample-type</mnemonic></col>', ""),
        },
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        Effect.either(
          perfService.analyzeTrace({
            sessionId: "session-1",
            artifactKey: traceArtifact.key,
            analyzer: "time-profiler",
            emitProgress: () => undefined,
          }),
        ),
      )

      expect(Either.isLeft(result)).toBe(true)

      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(EnvironmentError)

        if (result.left instanceof EnvironmentError) {
          expect(result.left.code).toBe("perf-analyze-export-contract")
          expect(result.left.reason).toContain("sample-type")
        }
      }
    })
  })

  test("logging analyzer returns signpost interval diagnostics", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const traceArtifact = await registerTraceFixture({ artifactStore, root, slug: "logging" })
      const commandRunner = createCommandRunner({
        exports: { "os-signpost-interval": signpostIntervalsXml },
      })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })

      const result = await Effect.runPromise(
        perfService.analyzeTrace({
          sessionId: "session-1",
          artifactKey: traceArtifact.key,
          analyzer: "logging",
          emitProgress: () => undefined,
        }),
      )

      expect(result.artifacts.exports).toHaveLength(1)
      expect(result.summary.metrics.find((metric) => metric.label === "Signpost intervals")?.value).toBe("3")
      expect(result.summary.headline).toContain("loadData dominated")
    })
  })

  test("reuses exportSchema's cache across two analyze calls on the same trace", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = createSessionRegistryMock(root)
      const traceArtifact = await registerTraceFixture({ artifactStore, root, slug: "time-profiler" })
      const commandRunner = createCommandRunner({ exports: { "time-sample": timeProfilerXml } })
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: commandRunner.runner,
      })
      const request = {
        sessionId: "session-1",
        artifactKey: traceArtifact.key,
        analyzer: "time-profiler" as const,
        emitProgress: () => undefined,
      }

      await Effect.runPromise(perfService.analyzeTrace(request))
      await Effect.runPromise(perfService.analyzeTrace(request))

      // Two `analyzeTrace` calls, one xctrace schema-export subprocess: the
      // second run's `time-sample` pull is a cache hit.
      expect(commandRunner.stats.exportCalls).toBe(1)
    })
  })
})
