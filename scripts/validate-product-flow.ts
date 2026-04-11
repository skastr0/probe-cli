#!/usr/bin/env bun

import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { formatProbeError, isProbeError } from "../src/domain/errors"
import type { PerfRecordResult } from "../src/domain/perf"
import type { SessionAction } from "../src/domain/action"
import type { SessionHealth, SimulatorSessionMode } from "../src/domain/session"
import type { SessionSnapshotResult, SnapshotPreviewItem, StoredSnapshotArtifact } from "../src/domain/snapshot"
import { probeRuntime } from "../src/runtime"
import { ArtifactStore } from "../src/services/ArtifactStore"
import { DaemonClient } from "../src/services/DaemonClient"

const defaultFixtureBundleId = "dev.probe.fixture"
const daemonReadyTimeoutMs = 20_000
const daemonShutdownTimeoutMs = 5_000

type Target = "simulator" | "device"

interface Options {
  readonly target: Target
  readonly bundleId: string
  readonly deviceId: string | null
  readonly sessionMode: SimulatorSessionMode | null
}

interface StepResult {
  readonly name: string
  readonly status: "passed" | "failed"
  readonly durationMs: number
  readonly detail: string
}

interface SpawnedDaemon {
  readonly child: ChildProcess
  stdout: string
  stderr: string
}

interface DeviceCandidate {
  readonly identifier: string
  readonly name: string
  readonly runtime: string | null
}

const usage = `Validate Probe's product flow.

Usage:
  bun run scripts/validate-product-flow.ts [--target simulator|device] [--bundle-id <bundle-id>] [--device-id <id>]

Notes:
  - simulator defaults to Probe's built-in fixture app (${defaultFixtureBundleId})
  - simulator uses build-and-install for the fixture, attach-to-running for any other bundle id
  - device requires --bundle-id because the target app must already be installed
  - device validation checks that at least one connected device is visible before opening the session
`

const sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms)
})

const formatDuration = (durationMs: number): string => (
  durationMs < 1_000
    ? `${durationMs.toFixed(0)}ms`
    : `${(durationMs / 1_000).toFixed(2)}s`
)

const formatError = (error: unknown): string => {
  if (isProbeError(error)) {
    return formatProbeError(error)
  }

  return error instanceof Error ? error.message : String(error)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const readNestedString = (value: unknown, path: ReadonlyArray<string>): string | null => {
  let current: unknown = value

  for (const segment of path) {
    if (!isRecord(current)) {
      return null
    }

    current = current[segment]
  }

  return typeof current === "string" && current.trim().length > 0 ? current.trim() : null
}

const parseArgs = (argv: ReadonlyArray<string>): Options => {
  let target: Target = "simulator"
  let bundleId: string | null = null
  let deviceId: string | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (argument === "--help" || argument === "-h") {
      console.log(usage)
      process.exit(0)
    }

    const readValue = (flag: string): string => {
      const next = argv[index + 1]

      if (!next || next.startsWith("--")) {
        throw new Error(`Missing value for ${flag}.\n\n${usage}`)
      }

      index += 1
      return next
    }

    switch (argument) {
      case "--target": {
        const value = readValue(argument)

        if (value !== "simulator" && value !== "device") {
          throw new Error(`Unsupported --target ${value}. Expected simulator or device.`)
        }

        target = value
        break
      }

      case "--bundle-id": {
        bundleId = readValue(argument)
        break
      }

      case "--device-id": {
        deviceId = readValue(argument)
        break
      }

      default:
        throw new Error(`Unknown argument ${argument}.\n\n${usage}`)
    }
  }

  if (target === "simulator" && deviceId !== null) {
    throw new Error("--device-id is only valid with --target device.")
  }

  if (target === "device" && bundleId === null) {
    throw new Error("--target device requires --bundle-id because the app must already be installed on the device.")
  }

  const resolvedBundleId = bundleId ?? defaultFixtureBundleId
  const sessionMode: SimulatorSessionMode | null = target === "simulator"
    ? (resolvedBundleId === defaultFixtureBundleId ? "build-and-install" : "attach-to-running")
    : null

  return {
    target,
    bundleId: resolvedBundleId,
    deviceId,
    sessionMode,
  }
}

const spawnDaemon = (): SpawnedDaemon => {
  const daemon: SpawnedDaemon = {
    child: spawn(Bun.which("bun") ?? "bun", ["run", "probe", "--", "serve"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
    stdout: "",
    stderr: "",
  }

  daemon.child.stdout?.setEncoding("utf8")
  daemon.child.stderr?.setEncoding("utf8")
  daemon.child.stdout?.on("data", (chunk: string) => {
    daemon.stdout += chunk
  })
  daemon.child.stderr?.on("data", (chunk: string) => {
    daemon.stderr += chunk
  })
  daemon.child.once("error", (error: Error) => {
    daemon.stderr += `${error instanceof Error ? error.message : String(error)}\n`
  })

  return daemon
}

const waitForExit = async (child: ChildProcess, timeoutMs: number): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true
  }

  return await Promise.race([
    new Promise<boolean>((resolve) => {
      child.once("exit", () => {
        resolve(true)
      })
    }),
    sleep(timeoutMs).then(() => false),
  ])
}

const daemonPing = async () => (
  await probeRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* DaemonClient
      return yield* client.ping()
    }),
  )
)

const isDaemonRunning = async () => (
  await probeRuntime.runPromise(
    Effect.gen(function* () {
      const artifactStore = yield* ArtifactStore
      return yield* artifactStore.isDaemonRunning()
    }),
  )
)

const getDaemonSocketPath = async () => (
  await probeRuntime.runPromise(
    Effect.gen(function* () {
      const artifactStore = yield* ArtifactStore
      return yield* artifactStore.getDaemonSocketPath()
    }),
  )
)

const waitForDaemonReady = async (daemon: SpawnedDaemon): Promise<string> => {
  const startedAt = performance.now()
  const socketPath = await getDaemonSocketPath()

  while (performance.now() - startedAt < daemonReadyTimeoutMs) {
    if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) {
      throw new Error(
        [
          `probe serve exited before it became ready (code=${daemon.child.exitCode}, signal=${daemon.child.signalCode ?? "none"}).`,
          daemon.stderr.trim().length > 0 ? daemon.stderr.trim() : daemon.stdout.trim(),
        ].filter((line) => line && line.length > 0).join("\n"),
      )
    }

    try {
      await daemonPing()
      return socketPath
    } catch {
      await sleep(250)
    }
  }

  throw new Error(
    `Timed out waiting ${formatDuration(daemonReadyTimeoutMs)} for probe serve to accept RPC connections at ${socketPath}.`,
  )
}

const stopDaemon = async (daemon: SpawnedDaemon): Promise<string> => {
  if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) {
    return `daemon already exited (code=${daemon.child.exitCode}, signal=${daemon.child.signalCode ?? "none"})`
  }

  daemon.child.kill("SIGINT")

  if (!(await waitForExit(daemon.child, daemonShutdownTimeoutMs))) {
    daemon.child.kill("SIGTERM")
  }

  if (!(await waitForExit(daemon.child, daemonShutdownTimeoutMs))) {
    daemon.child.kill("SIGKILL")
  }

  await waitForExit(daemon.child, daemonShutdownTimeoutMs)

  const stillRunning = await isDaemonRunning()
  return stillRunning
    ? `daemon process stopped, but the socket still appears reachable`
    : `daemon exited with code=${daemon.child.exitCode}, signal=${daemon.child.signalCode ?? "none"}`
}

const runCommand = async (command: string, args: ReadonlyArray<string>): Promise<{ stdout: string; stderr: string; exitCode: number | null }> =>
  await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.once("close", (exitCode: number | null) => {
      resolve({ stdout, stderr, exitCode })
    })
  })

const parseConnectedDevices = (payload: unknown): ReadonlyArray<DeviceCandidate> => {
  const rawDevices = isRecord(payload) && isRecord(payload.result) && Array.isArray(payload.result.devices)
    ? payload.result.devices
    : []

  const devices = rawDevices.map((value) => {
    const identifier = readNestedString(value, ["identifier"])
      ?? readNestedString(value, ["udid"])
      ?? readNestedString(value, ["hardwareProperties", "udid"])
      ?? readNestedString(value, ["connectionProperties", "udid"])
      ?? readNestedString(value, ["deviceProperties", "identifier"])
    const name = readNestedString(value, ["name"])
      ?? readNestedString(value, ["deviceProperties", "name"])
    const runtime = readNestedString(value, ["runtime"])
      ?? readNestedString(value, ["deviceProperties", "osVersion"])
      ?? readNestedString(value, ["deviceProperties", "productVersion"])

    if (!identifier || !name) {
      return null
    }

    return {
      identifier,
      name,
      runtime,
    } satisfies DeviceCandidate
  })

  return devices.filter((device): device is DeviceCandidate => device !== null)
}

const validateConnectedDevice = async (requestedDeviceId: string | null): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "probe-validate-device-"))
  const outputPath = join(root, "devices.json")

  try {
    const result = await runCommand("xcrun", ["devicectl", "list", "devices", "--json-output", outputPath])

    if (result.exitCode !== 0) {
      throw new Error(
        `xcrun devicectl list devices failed with exit code ${result.exitCode}.\n${result.stderr.trim() || result.stdout.trim()}`,
      )
    }

    const devices = parseConnectedDevices(JSON.parse(await readFile(outputPath, "utf8")) as unknown)

    if (devices.length === 0) {
      throw new Error("No connected iOS devices were reported by CoreDevice.")
    }

    if (requestedDeviceId === null) {
      const first = devices[0]
      return devices.length === 1
        ? `connected device: ${first?.name} (${first?.identifier})${first?.runtime ? ` on ${first.runtime}` : ""}`
        : `${devices.length} connected devices detected; no explicit --device-id was provided`
    }

    const selected = devices.find((device) =>
      device.identifier === requestedDeviceId || device.name === requestedDeviceId,
    )

    if (!selected) {
      throw new Error(`Requested --device-id ${requestedDeviceId} was not found among ${devices.length} connected device(s).`)
    }

    return `connected device: ${selected.name} (${selected.identifier})${selected.runtime ? ` on ${selected.runtime}` : ""}`
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const daemonEvent = (stage: string, message: string) => {
  console.error(`[${stage}] ${message}`)
}

const openSession = async (options: Options): Promise<SessionHealth> => (
  await probeRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* DaemonClient
      return yield* client.openSession({
        target: options.target,
        bundleId: options.bundleId,
        sessionMode: options.sessionMode,
        simulatorUdid: null,
        deviceId: options.deviceId,
        onEvent: daemonEvent,
      })
    }),
  )
)

const getSessionHealth = async (sessionId: string): Promise<SessionHealth> => (
  await probeRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* DaemonClient
      return yield* client.getSessionHealth({ sessionId, onEvent: daemonEvent })
    }),
  )
)

const captureSnapshot = async (sessionId: string): Promise<SessionSnapshotResult> => (
  await probeRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* DaemonClient
      return yield* client.captureSnapshot({ sessionId, outputMode: "auto", onEvent: daemonEvent })
    }),
  )
)

const performAction = async (sessionId: string, action: SessionAction) => (
  await probeRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* DaemonClient
      return yield* client.performSessionAction({ sessionId, action, onEvent: daemonEvent })
    }),
  )
)

const recordPerf = async (sessionId: string): Promise<PerfRecordResult> => (
  await probeRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* DaemonClient
      return yield* client.recordPerf({
        sessionId,
        template: "time-profiler",
        timeLimit: "5s",
        onEvent: daemonEvent,
      })
    }),
  )
)

const closeSession = async (sessionId: string) => (
  await probeRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* DaemonClient
      return yield* client.closeSession({ sessionId, onEvent: daemonEvent })
    }),
  )
)

const loadInteractiveNodes = async (snapshot: SessionSnapshotResult): Promise<ReadonlyArray<SnapshotPreviewItem>> => {
  const previewNodes = snapshot.preview?.nodes.filter((node) => node.interactive) ?? []

  if (previewNodes.length > 0) {
    return previewNodes
  }

  const artifact = JSON.parse(await readFile(snapshot.artifact.absolutePath, "utf8")) as StoredSnapshotArtifact
  return artifact.renderings.interactive.nodes
}

const describeNode = (node: SnapshotPreviewItem): string => {
  const identity = node.identifier ?? node.label ?? node.value ?? node.placeholder ?? node.ref
  return `${identity} (${node.type})`
}

const chooseTapCandidate = (nodes: ReadonlyArray<SnapshotPreviewItem>): SnapshotPreviewItem | null => {
  const excludedTypes = new Set(["application", "window", "other", "keyboard"])
  const preferredTypes = new Set(["button", "cell", "link", "tabbarbutton", "navigationbarbutton", "switch"])

  const eligible = nodes.filter((node) =>
    node.interactive
    && node.state?.disabled !== true
    && !excludedTypes.has(node.type.toLowerCase()),
  )

  const score = (node: SnapshotPreviewItem): number => {
    let value = 0

    if (preferredTypes.has(node.type.toLowerCase())) {
      value += 10
    }

    if (node.identifier) {
      value += 4
    }

    if (node.label) {
      value += 2
    }

    if (node.value) {
      value += 1
    }

    value += Math.max(0, 6 - node.depth)
    return value
  }

  return [...eligible].sort((left, right) => score(right) - score(left))[0] ?? null
}

const buildAction = async (options: Options, snapshot: SessionSnapshotResult): Promise<{ action: SessionAction; detail: string }> => {
  if (options.bundleId === defaultFixtureBundleId) {
    return {
      action: {
        kind: "type",
        target: {
          kind: "semantic",
          identifier: "fixture.form.input",
          label: null,
          value: null,
          placeholder: null,
          type: "textField",
          section: null,
          interactive: true,
        },
        text: "probe-validation",
        replace: true,
      },
      detail: "typed probe-validation into fixture.form.input",
    }
  }

  const interactiveNodes = await loadInteractiveNodes(snapshot)
  const candidate = chooseTapCandidate(interactiveNodes)

  if (!candidate) {
    throw new Error("Snapshot did not expose a tappable interactive node for the configured target app.")
  }

  return {
    action: {
      kind: "tap",
      target: {
        kind: "ref",
        ref: candidate.ref,
        fallback: {
          kind: "semantic",
          identifier: candidate.identifier,
          label: candidate.label,
          value: candidate.value,
          placeholder: candidate.placeholder,
          type: candidate.type,
          section: candidate.section,
          interactive: true,
        },
      },
    },
    detail: `tapped ${describeNode(candidate)}`,
  }
}

const formatArtifacts = (health: SessionHealth): ReadonlyArray<string> =>
  health.artifacts.map((artifact) => `- ${artifact.key}: ${artifact.absolutePath}`)

const tailText = (value: string, maxLines: number): string => {
  const lines = value.trim().split(/\r?\n/).filter((line) => line.length > 0)
  return lines.slice(-maxLines).join("\n")
}

const printSummary = (args: {
  readonly options: Options
  readonly results: ReadonlyArray<StepResult>
  readonly sessionId: string | null
  readonly artifactLines: ReadonlyArray<string>
  readonly daemon: SpawnedDaemon | null
  readonly failure: string | null
}) => {
  console.log("")
  console.log("Probe product-flow validation")
  console.log(`target: ${args.options.target}`)
  console.log(`bundle id: ${args.options.bundleId}`)
  console.log(`device id: ${args.options.deviceId ?? "auto"}`)

  if (args.options.sessionMode) {
    console.log(`session mode: ${args.options.sessionMode}`)
  }

  if (args.sessionId) {
    console.log(`session id: ${args.sessionId}`)
  }

  console.log(`overall: ${args.failure === null ? "PASS" : "FAIL"}`)
  console.log("")
  console.log("Steps")

  for (const result of args.results) {
    const prefix = result.status === "passed" ? "✓" : "✗"
    console.log(`${prefix} ${result.name} (${formatDuration(result.durationMs)})${result.detail ? ` — ${result.detail}` : ""}`)
  }

  if (args.artifactLines.length > 0) {
    console.log("")
    console.log("Artifacts")
    for (const line of args.artifactLines) {
      console.log(line)
    }
  }

  if (args.failure) {
    console.log("")
    console.log("Failure")
    console.log(args.failure)
  }

  if (args.daemon && args.failure && args.daemon.stderr.trim().length > 0) {
    console.log("")
    console.log("Daemon stderr tail")
    console.log(tailText(args.daemon.stderr, 20))
  }
}

const runStep = async <T>(
  results: Array<StepResult>,
  name: string,
  operation: () => Promise<{ value: T; detail: string }>,
): Promise<T> => {
  const startedAt = performance.now()

  try {
    const { value, detail } = await operation()
    results.push({
      name,
      status: "passed",
      durationMs: performance.now() - startedAt,
      detail,
    })
    return value
  } catch (error) {
    results.push({
      name,
      status: "failed",
      durationMs: performance.now() - startedAt,
      detail: formatError(error),
    })
    throw error
  }
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const results: Array<StepResult> = []
  const artifactLines: Array<string> = []

  let daemon: SpawnedDaemon | null = null
  let sessionId: string | null = null
  let sessionClosed = false
  let daemonStopped = false
  let failure: string | null = null

  try {
    await runStep(results, "ensure no daemon is already running", async () => {
      const running = await isDaemonRunning()
      const socketPath = await getDaemonSocketPath()

      if (running) {
        throw new Error(`A Probe daemon is already running at ${socketPath}. Stop it before running this validation script.`)
      }

      return {
        value: undefined,
        detail: `socket path ${socketPath} is free`,
      }
    })

    if (options.target === "device") {
      await runStep(results, "validate connected device", async () => ({
        value: undefined,
        detail: await validateConnectedDevice(options.deviceId),
      }))
    }

    daemon = await runStep(results, "start daemon", async () => {
      const started = spawnDaemon()
      const socketPath = await waitForDaemonReady(started)
      return {
        value: started,
        detail: `probe serve is accepting RPC connections at ${socketPath}`,
      }
    })

    const opened = await runStep(results, "open session", async () => {
      const health = await openSession(options)

      if (health.state !== "ready") {
        throw new Error(
          `Session ${health.sessionId} opened in state ${health.state}; expected ready. Warnings: ${health.warnings.join(" | ") || "none"}`,
        )
      }

      sessionId = health.sessionId
      return {
        value: health,
        detail: `${health.state} on ${health.target.deviceName} (${health.target.deviceId})`,
      }
    })

    await runStep(results, "send ping", async () => {
      const health = await getSessionHealth(opened.sessionId)
      return {
        value: health,
        detail: `runner RTT ${health.healthCheck.pingRttMs ?? "n/a"}ms`,
      }
    })

    const snapshot = await runStep(results, "capture snapshot", async () => {
      const result = await captureSnapshot(opened.sessionId)
      return {
        value: result,
        detail: `${result.snapshotId} with ${result.metrics.nodeCount} nodes / ${result.metrics.interactiveNodeCount} interactive`,
      }
    })

    const plannedAction = await buildAction(options, snapshot)
    await runStep(results, "perform UI action", async () => {
      const result = await performAction(opened.sessionId, plannedAction.action)
      return {
        value: result,
        detail: `${plannedAction.detail}; ${result.summary}`,
      }
    })

    await runStep(results, "record perf trace", async () => {
      const result = await recordPerf(opened.sessionId)
      return {
        value: result,
        detail: `${result.templateName} for ${result.timeLimit}; ${result.summary.headline}`,
      }
    })

    await runStep(results, "list artifacts", async () => {
      const health = await getSessionHealth(opened.sessionId)
      artifactLines.splice(0, artifactLines.length, ...formatArtifacts(health))
      return {
        value: health,
        detail: `${health.artifacts.length} artifacts currently registered`,
      }
    })

    await runStep(results, "close session", async () => {
      const result = await closeSession(opened.sessionId)
      sessionClosed = true
      return {
        value: result,
        detail: `closed at ${result.closedAt}`,
      }
    })

    await runStep(results, "stop daemon", async () => {
      if (!daemon) {
        throw new Error("Daemon process was never started.")
      }

      const detail = await stopDaemon(daemon)
      daemonStopped = true
      return {
        value: undefined,
        detail,
      }
    })
  } catch (error) {
    failure = formatError(error)
    process.exitCode = 1
  } finally {
    try {
      if (sessionId !== null && !sessionClosed) {
        const cleanupSessionId = sessionId
        await runStep(results, "close session (cleanup)", async () => {
          const result = await closeSession(cleanupSessionId)
          sessionClosed = true
          return {
            value: result,
            detail: `closed at ${result.closedAt}`,
          }
        })
      }
    } catch (error) {
      if (failure === null) {
        failure = formatError(error)
      }
      process.exitCode = 1
    }

    try {
      if (daemon !== null && !daemonStopped) {
        const cleanupDaemon = daemon
        await runStep(results, "stop daemon (cleanup)", async () => {
          const detail = await stopDaemon(cleanupDaemon)
          daemonStopped = true
          return {
            value: undefined,
            detail,
          }
        })
      }
    } catch (error) {
      if (failure === null) {
        failure = formatError(error)
      }
      process.exitCode = 1
    }

    printSummary({
      options,
      results,
      sessionId,
      artifactLines,
      daemon,
      failure,
    })

    await probeRuntime.dispose()
  }
}

await main()
