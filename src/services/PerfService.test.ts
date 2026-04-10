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
    fixtureProcessId: 123,
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
            stdout: "Time Profiler\nSystem Trace\nMetal System Trace\n",
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

  test("maps export file size overrun into a typed environment failure", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = {
        getSessionHealth: () => Effect.succeed(createSessionHealth(root, "ready")),
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

  test("surfaces export schema drift as a typed contract failure", async () => {
    await withTempRoot(async (root) => {
      const artifactStore = createArtifactStore()
      const sessionRegistry = {
        getSessionHealth: () => Effect.succeed(createSessionHealth(root, "ready")),
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
