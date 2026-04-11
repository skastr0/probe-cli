import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either } from "effect"
import { EnvironmentError } from "../domain/errors"
import type { ArtifactRecord } from "../domain/output"
import { createPerfService, ExportBudgetExceededError } from "./PerfService"

const mib = 1024 * 1024

const tocXml = `<?xml version="1.0"?>
<trace-toc>
  <run number="1"/>
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

const withTempRoot = async <T>(run: (root: string) => Promise<T>) => {
  const root = await mkdtemp(join(tmpdir(), "probe-cli-perf-service-"))

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
    },
  }
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
    commandIngress: "file-mailbox",
    eventEgress: "stdout-jsonl-mixed-log",
    stdinProbeStatus: "timeout",
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
    stdinProbeStatus: "timeout",
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

const createCommandRunner = (options: {
  readonly exports: Record<string, string>
  readonly onExport?: (args: {
    readonly outputPath: string
    readonly schema: string
    readonly budget: { readonly maxBytes: number; readonly maxRows: number }
  }) => Promise<void> | void
  readonly recordDelayMs?: number
}) => {
  const stats = {
    captureCalls: 0,
    exportCalls: 0,
    budgets: [] as Array<{ schema: string; maxBytes: number; maxRows: number }>,
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

        if (args.command !== "xcrun") {
          throw new Error(`Unexpected command ${args.command}`)
        }

        if (args.commandArgs[0] === "xctrace" && args.commandArgs[1] === "list") {
          return {
            stdout: "Time Profiler\nSystem Trace\nMetal System Trace\nSwift Concurrency\nHangs\n",
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
            stdout: tocXml,
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
        await options.onExport?.({ outputPath: args.outputPath, schema, budget: args.budget })

        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          bytesWritten: Buffer.byteLength(xml, "utf8"),
          rowCount: (xml.match(/<row>/g) ?? []).length,
        }
      },
    },
  }
}

describe("PerfService", () => {
  test("records a trace and reports a failed post-record session honestly", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      let healthChecks = 0
      const sessionRegistry = {
        getSessionHealth: () =>
          Effect.succeed(
            (healthChecks += 1) === 1
              ? createSessionHealth(root, "ready")
              : createSessionHealth(root, "failed", {
                  wrapperRunning: false,
                  lastOk: false,
                }),
          ),
        sendRunnerKeepalive: () => Effect.void,
      }
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

      expect(healthChecks).toBe(2)
      expect(result.session.state).toBe("failed")
      expect(result.diagnoses.some((diagnosis) => diagnosis.code === "perf-session-failed-after-record")).toBe(true)
      expect(artifactStore.artifacts.map((artifact) => artifact.label)).toEqual([
        "time-profiler-trace",
        "time-profiler-toc",
        "time-profiler-time-sample",
      ])
    })
  })

  test("records a trace and reports degraded post-record session with warning", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      let healthChecks = 0
      const sessionRegistry = {
        getSessionHealth: () =>
          Effect.succeed(
            (healthChecks += 1) === 1
              ? createSessionHealth(root, "ready")
              : createSessionHealth(root, "degraded", {
                  wrapperRunning: true,
                  lastOk: true,
                  runnerActionsBlocked: true,
                  reason: "Runner health check degraded after recording",
                }),
          ),
        sendRunnerKeepalive: () => Effect.void,
      }
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

      expect(healthChecks).toBe(2)
      expect(result.session.state).toBe("degraded")
      expect(result.diagnoses.some((diagnosis) => diagnosis.code === "perf-session-degraded-after-record")).toBe(true)
      expect(result.diagnoses.some((diagnosis) => diagnosis.summary.includes("degraded"))).toBe(true)
    })
  })

  test("sends runner keepalives during slow recordings", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      let keepaliveCalls = 0
      const sessionRegistry = {
        getSessionHealth: () => Effect.succeed(createSessionHealth(root, "ready")),
        sendRunnerKeepalive: () =>
          Effect.sync(() => {
            keepaliveCalls += 1
          }),
      }
      const commandRunner = createCommandRunner({
        exports: {
          "time-sample": timeProfilerXml,
        },
        recordDelayMs: 11_000,
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
          timeLimit: "12s",
          emitProgress: () => undefined,
        }),
      )

      expect(result.template).toBe("time-profiler")
      expect(keepaliveCalls).toBeGreaterThanOrEqual(1)
    })
  }, 20_000)

  test("maps export file size overrun into a typed environment failure", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = {
        getSessionHealth: () => Effect.succeed(createSessionHealth(root, "ready")),
        sendRunnerKeepalive: () => Effect.void,
      }
      const commandRunner = createCommandRunner({
        exports: {
          "time-sample": timeProfilerXml,
        },
        onExport: async ({ outputPath, schema }) => {
          // Write a file that exceeds the maxExportFileSizeBytes (8 MiB)
          const { writeFile } = await import("node:fs/promises")
          const largeContent = "x".repeat(9 * 1024 * 1024) // 9 MiB
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
          expect(result.left.code).toBe("perf-export-file-too-large")
        }
      }
    })
  })

  test("rejects over-long system trace windows before xctrace runs", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = {
        getSessionHealth: () => Effect.succeed(createSessionHealth(root, "ready")),
        sendRunnerKeepalive: () => Effect.void,
      }
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

  test("maps export budget exceeded into a typed environment failure", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = {
        getSessionHealth: () => Effect.succeed(createSessionHealth(root, "ready")),
        sendRunnerKeepalive: () => Effect.void,
      }
      // Provide minimal stubs for the template list/version calls
      const baseRunner = createCommandRunner({ exports: {} })
      let exportCalls = 0
      const perfService = createPerfService({
        artifactStore: artifactStore.service,
        sessionRegistry,
        commandRunner: {
          capture: baseRunner.runner.capture,
          exportToFile: async () => {
            exportCalls++
            throw new ExportBudgetExceededError({
              kind: "rows",
              limit: 8000,
              observed: 8001,
            })
          },
        },
      })

      const result = await Effect.runPromise(
        Effect.either(
          perfService.record({
            sessionId: "session-1",
            template: "system-trace",
            timeLimit: "3s",
            emitProgress: () => undefined,
          }),
        ),
      )

      expect(Either.isLeft(result)).toBe(true)
      expect(exportCalls).toBe(1)
      expect(artifactStore.artifacts.map((artifact) => artifact.label)).toEqual([
        "system-trace-trace",
        "system-trace-toc",
      ])

      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(EnvironmentError)

        if (result.left instanceof EnvironmentError) {
          expect(result.left.code).toBe("perf-export-row-budget")
          expect(result.left.reason).toContain("thread-state")
        }
      }
    })
  })

  test("system trace uses reduced budgets and time limits", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = {
        getSessionHealth: () => Effect.succeed(createSessionHealth(root, "ready")),
        sendRunnerKeepalive: () => Effect.void,
      }
      const commandRunner = createCommandRunner({
        exports: {
          "thread-state": loadPerfFixture("system-trace.thread-state.no-target.xml"),
          "cpu-state": loadPerfFixture("system-trace.cpu-state.no-target.xml"),
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
          template: "system-trace",
          timeLimit: "5s",
          emitProgress: () => undefined,
        }),
      )

      // Verify system trace uses the reduced budgets
      expect(commandRunner.stats.budgets).toEqual([
        { schema: "thread-state", maxBytes: 2 * mib, maxRows: 8_000 },
        { schema: "cpu-state", maxBytes: 2 * mib, maxRows: 8_000 },
      ])
      expect(result.template).toBe("system-trace")
      expect(result.artifacts.exports).toHaveLength(2)
    })
  })

  test("metal system trace exports gpu, driver, and encoder tables with the extended budgets", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = {
        getSessionHealth: () => Effect.succeed(createSessionHealth(root, "ready")),
        sendRunnerKeepalive: () => Effect.void,
      }
      const commandRunner = createCommandRunner({
        exports: {
          "metal-gpu-intervals": loadPerfFixture("metal-system-trace.metal-gpu-intervals.xml"),
          "metal-driver-event-intervals": metalDriverIntervalsXml,
          "metal-application-encoders-list": metalEncoderListXml,
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
          template: "metal-system-trace",
          timeLimit: "90s",
          emitProgress: () => undefined,
        }),
      )

      expect(commandRunner.stats.budgets).toEqual([
        { schema: "metal-gpu-intervals", maxBytes: 8 * mib, maxRows: 25_000 },
        { schema: "metal-driver-event-intervals", maxBytes: 4 * mib, maxRows: 12_000 },
        { schema: "metal-application-encoders-list", maxBytes: 4 * mib, maxRows: 12_000 },
      ])
      expect(result.template).toBe("metal-system-trace")
      expect(result.timeLimit).toBe("90s")
      expect(result.artifacts.exports).toHaveLength(3)
      expect(result.summary.metrics.find((metric) => metric.label === "Estimated FPS")?.value).toContain("fps")
      expect(result.summary.metrics.find((metric) => metric.label === "Per-encoder summary")?.value).toContain("command buffer")
    })
  })

  test("records hangs traces and returns structured hang diagnostics", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = {
        getSessionHealth: () => Effect.succeed(createSessionHealth(root, "ready")),
        sendRunnerKeepalive: () => Effect.void,
      }
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
        perfService.record({
          sessionId: "session-1",
          template: "hangs",
          timeLimit: "10s",
          emitProgress: () => undefined,
        }),
      )

      expect(result.template).toBe("hangs")
      expect(result.templateName).toBe("Hangs")
      expect(result.artifacts.exports).toHaveLength(2)
      expect(result.summary.headline).toContain("Detected 2 hang events")
      expect(result.summary.metrics.find((metric) => metric.label === "Call stack hints")?.value).toBe("available")
      expect(result.diagnoses.find((diagnosis) => diagnosis.code === "hangs-longest-event")?.details.join(" ")).toContain("LayoutPass.render")
    })
  })

  test("records swift concurrency traces and returns task and actor diagnostics", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = {
        getSessionHealth: () => Effect.succeed(createSessionHealth(root, "ready")),
        sendRunnerKeepalive: () => Effect.void,
      }
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
        perfService.record({
          sessionId: "session-1",
          template: "swift-concurrency",
          timeLimit: "10s",
          emitProgress: () => undefined,
        }),
      )

      expect(result.template).toBe("swift-concurrency")
      expect(result.templateName).toBe("Swift Concurrency")
      expect(result.artifacts.exports).toHaveLength(3)
      expect(result.summary.headline).toContain("Observed 2 Swift tasks")
      expect(result.summary.metrics.find((metric) => metric.label === "Task creations")?.value).toBe("2")
      expect(result.summary.metrics.find((metric) => metric.label === "Actor executions")?.value).toBe("2")
      expect(result.diagnoses.some((diagnosis) => diagnosis.code === "swift-concurrency-long-running-tasks")).toBe(true)
    })
  })

  test("rejects metal trace windows above the 120 second cap before xctrace runs", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = {
        getSessionHealth: () => Effect.succeed(createSessionHealth(root, "ready")),
        sendRunnerKeepalive: () => Effect.void,
      }
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

  test("surfaces export schema drift as a typed contract failure", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = {
        getSessionHealth: () => Effect.succeed(createSessionHealth(root, "ready")),
        sendRunnerKeepalive: () => Effect.void,
      }
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
          expect(result.left.code).toBe("perf-analyze-export-contract")
          expect(result.left.reason).toContain("sample-type")
        }
      }
    })
  })
})
