#!/usr/bin/env bun

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import net from "node:net"
import { createInterface, type Interface } from "node:readline"
import {
  decodeJsonLine,
  encodeJsonLine,
  type RunnerCommand,
  type RunnerMessage,
  type RunnerResponse,
  type TransportKind,
} from "./protocol"

interface SampleSummary {
  readonly count: number
  readonly minMs: number
  readonly maxMs: number
  readonly avgMs: number
  readonly medianMs: number
  readonly p95Ms: number
}

interface ReliabilitySummary {
  readonly steadyStateAttempts: number
  readonly steadyStateSuccesses: number
  readonly steadyStateFailures: number
  readonly restartAttempts: number
  readonly restartSuccesses: number
  readonly restartFailures: number
}

interface TransportBenchmarkResult {
  readonly transport: TransportKind
  readonly startup: SampleSummary
  readonly latency: SampleSummary
  readonly recovery: SampleSummary
  readonly reliability: ReliabilitySummary
  readonly startupComplexity: {
    readonly measuredReadyPath: string
    readonly coordinationSteps: number
    readonly notes: string
  }
  readonly restartBehavior: string
}

interface PendingRequest {
  readonly resolve: (response: RunnerResponse) => void
  readonly reject: (error: Error) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

const runnerScriptPath = join(import.meta.dir, "runner.ts")
const reportPath = join(process.cwd(), "knowledge", "xcuitest-runner", "transport-spike-results.json")

const benchmarkConfig = {
  startupRuns: 12,
  latencyWarmup: 50,
  latencySamples: 500,
  restartRuns: 15,
  timeoutMs: 2_000,
}

const round = (value: number) => Number(value.toFixed(3))

const summarizeSamples = (samples: ReadonlyArray<number>): SampleSummary => {
  if (samples.length === 0) {
    return {
      count: 0,
      minMs: 0,
      maxMs: 0,
      avgMs: 0,
      medianMs: 0,
      p95Ms: 0,
    }
  }

  const sorted = [...samples].sort((left, right) => left - right)
  const sum = sorted.reduce((total, value) => total + value, 0)
  const middle = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1]! + sorted[middle]!) / 2
      : sorted[middle]!
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)

  return {
    count: sorted.length,
    minMs: round(sorted[0] ?? 0),
    maxMs: round(sorted.at(-1) ?? 0),
    avgMs: round(sum / Math.max(sorted.length, 1)),
    medianMs: round(median),
    p95Ms: round(sorted[p95Index] ?? 0),
  }
}

const uniqueSocketPath = () => join(tmpdir(), `probe-${process.pid}-${crypto.randomUUID().slice(0, 8)}.sock`)

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const waitForChildExit = async (child: ChildProcessWithoutNullStreams) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }

  const [code, signal] = await once(child, "exit")
  return { code, signal }
}

const writeFrame = async (target: NodeJS.WritableStream, frame: string) => {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      target.off("error", handleError)
      reject(error)
    }

    target.on("error", handleError)
    target.write(frame, (error?: Error | null) => {
      target.off("error", handleError)

      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

abstract class BaseHarness {
  protected child: ChildProcessWithoutNullStreams | null = null
  protected nextCommandId = 0
  protected readonly pending = new Map<string, PendingRequest>()
  protected readonly stderrLines: string[] = []

  protected consumeChildOutput(child: ChildProcessWithoutNullStreams) {
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      this.stderrLines.push(chunk)
    })
  }

  protected spawnRunner(transport: TransportKind, extraArgs: ReadonlyArray<string> = []) {
    const child = spawn(process.execPath, [runnerScriptPath, "--transport", transport, ...extraArgs], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    })

    child.stdin.setDefaultEncoding("utf8")
    this.consumeChildOutput(child)
    child.on("exit", () => {
      this.rejectPending(new Error(`${transport} runner exited while requests were in flight`))
    })
    this.child = child
    return child
  }

  protected rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }

    this.pending.clear()
  }

  async command(action: RunnerCommand["action"], payload?: string) {
    const id = `${this.transport}-${++this.nextCommandId}`
    const command: RunnerCommand = {
      kind: "command",
      id,
      action,
      payload,
    }

    const startedAt = performance.now()
    const response = await new Promise<RunnerResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.transport} request timed out after ${benchmarkConfig.timeoutMs}ms`))
      }, benchmarkConfig.timeoutMs)

      this.pending.set(id, { resolve, reject, timeout })
      void this.writeCommand(command).catch((error) => {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })

    return {
      response,
      latencyMs: performance.now() - startedAt,
    }
  }

  protected resolveResponse(response: RunnerResponse) {
    const pending = this.pending.get(response.id)

    if (!pending) {
      return
    }

    clearTimeout(pending.timeout)
    this.pending.delete(response.id)
    pending.resolve(response)
  }

  abstract readonly transport: TransportKind

  abstract start(): Promise<number>

  protected abstract writeCommand(command: RunnerCommand): Promise<void>

  abstract forceRestart(): Promise<number>

  abstract shutdown(): Promise<void>
}

class StdoutJsonlHarness extends BaseHarness {
  readonly transport = "stdout-jsonl" as const

  private lines: Interface | null = null
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null

  async start() {
    const startedAt = performance.now()
    const child = this.spawnRunner(this.transport)
    child.stdout.setEncoding("utf8")

    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve
    })

    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.lines.on("line", (line) => {
      const message = decodeJsonLine<RunnerMessage>(line)

      if (message.kind === "ready") {
        this.readyResolve?.()
        this.readyResolve = null
        return
      }

      this.resolveResponse(message)
    })

    await this.readyPromise
    return performance.now() - startedAt
  }

  protected writeCommand(command: RunnerCommand) {
    if (!this.child) {
      throw new Error("stdout-jsonl runner is not started")
    }

    return writeFrame(this.child.stdin, encodeJsonLine(command))
  }

  async forceRestart() {
    const startedAt = performance.now()

    if (this.child && this.child.exitCode === null && !this.child.killed) {
      this.child.kill("SIGKILL")
      await waitForChildExit(this.child)
    }

    this.lines?.close()
    this.lines = null
    await this.start()
    return performance.now() - startedAt
  }

  async shutdown() {
    if (!this.child) {
      return
    }

    if (this.child.exitCode === null && !this.child.killed) {
      await this.command("shutdown")
      await waitForChildExit(this.child)
    }

    this.lines?.close()
    this.lines = null
    this.child = null
  }
}

class UnixSocketHarness extends BaseHarness {
  readonly transport = "unix-socket" as const

  private socketPath = uniqueSocketPath()
  private socket: net.Socket | null = null
  private lines: Interface | null = null

  async start() {
    const startedAt = performance.now()
    this.socketPath = uniqueSocketPath()
    this.spawnRunner(this.transport, ["--socket-path", this.socketPath])
    this.socket = await this.connectWithRetry(this.socketPath, benchmarkConfig.timeoutMs)
    this.socket.setNoDelay(true)
    this.lines = createInterface({ input: this.socket, crlfDelay: Infinity })
    this.lines.on("line", (line) => {
      const message = decodeJsonLine<RunnerResponse>(line)
      this.resolveResponse(message)
    })
    this.socket.on("close", () => {
      this.rejectPending(new Error("unix-socket connection closed while requests were in flight"))
    })
    return performance.now() - startedAt
  }

  private async connectWithRetry(socketPath: string, timeoutMs: number) {
    const startedAt = performance.now()

    while (performance.now() - startedAt < timeoutMs) {
      try {
        return await new Promise<net.Socket>((resolve, reject) => {
          const socket = net.createConnection(socketPath)
          const onError = (error: Error) => {
            socket.off("connect", onConnect)
            reject(error)
          }
          const onConnect = () => {
            socket.off("error", onError)
            resolve(socket)
          }

          socket.once("error", onError)
          socket.once("connect", onConnect)
        })
      } catch {
        await delay(10)
      }
    }

    throw new Error(`unix-socket runner did not accept connections within ${timeoutMs}ms`)
  }

  protected writeCommand(command: RunnerCommand) {
    if (!this.socket) {
      throw new Error("unix-socket runner is not connected")
    }

    return writeFrame(this.socket, encodeJsonLine(command))
  }

  async forceRestart() {
    const startedAt = performance.now()

    this.socket?.destroy()
    this.lines?.close()
    this.socket = null
    this.lines = null

    if (this.child && this.child.exitCode === null && !this.child.killed) {
      this.child.kill("SIGKILL")
      await waitForChildExit(this.child)
    }

    await this.start()
    return performance.now() - startedAt
  }

  async shutdown() {
    if (!this.child) {
      return
    }

    if (this.child.exitCode === null && !this.child.killed) {
      await this.command("shutdown")
      await waitForChildExit(this.child)
    }

    this.socket?.destroy()
    this.lines?.close()
    this.socket = null
    this.lines = null
    this.child = null
  }
}

const benchmarkTransport = async (harness: BaseHarness): Promise<TransportBenchmarkResult> => {
  const startupSamples: number[] = []

  for (let index = 0; index < benchmarkConfig.startupRuns; index += 1) {
    startupSamples.push(await harness.start())
    await harness.shutdown()
  }

  await harness.start()

  for (let index = 0; index < benchmarkConfig.latencyWarmup; index += 1) {
    await harness.command("ping", `warmup-${index}`)
  }

  const latencySamples: number[] = []
  let steadyStateFailures = 0

  for (let index = 0; index < benchmarkConfig.latencySamples; index += 1) {
    try {
      const { latencyMs } = await harness.command("ping", `sample-${index}`)
      latencySamples.push(latencyMs)
    } catch {
      steadyStateFailures += 1
    }
  }

  const recoverySamples: number[] = []
  let restartFailures = 0

  for (let index = 0; index < benchmarkConfig.restartRuns; index += 1) {
    try {
      recoverySamples.push(await harness.forceRestart())
      await harness.command("ping", `recovery-${index}`)
    } catch {
      restartFailures += 1
    }
  }

  await harness.shutdown()

  return {
    transport: harness.transport,
    startup: summarizeSamples(startupSamples),
    latency: summarizeSamples(latencySamples),
    recovery: summarizeSamples(recoverySamples),
    reliability: {
      steadyStateAttempts: benchmarkConfig.latencySamples,
      steadyStateSuccesses: benchmarkConfig.latencySamples - steadyStateFailures,
      steadyStateFailures,
      restartAttempts: benchmarkConfig.restartRuns,
      restartSuccesses: benchmarkConfig.restartRuns - restartFailures,
      restartFailures,
    },
    startupComplexity:
      harness.transport === "stdout-jsonl"
        ? {
            measuredReadyPath: "wait for runner's stdout ready frame",
            coordinationSteps: 2,
            notes: "Host only needs spawn + first parsed JSONL frame before steady-state commands can flow over existing stdin/stdout pipes.",
          }
        : {
            measuredReadyPath: "spawn runner, retry connect until socket accepts, then establish line reader",
            coordinationSteps: 4,
            notes: "Host must choose a socket path, wait for bind/listen, connect, and recreate the connection after every restart.",
          },
    restartBehavior:
      harness.transport === "stdout-jsonl"
        ? "Host kills the child, respawns it, waits for a new ready line, and resumes using the new stdio pipes."
        : "Host destroys the old connection, kills the child, respawns it with a fresh socket path, reconnects, and recreates the line reader.",
  }
}

const main = async () => {
  if (!existsSync(join(process.cwd(), "knowledge", "xcuitest-runner"))) {
    mkdirSync(join(process.cwd(), "knowledge", "xcuitest-runner"), { recursive: true })
  }

  const stdoutResult = await benchmarkTransport(new StdoutJsonlHarness())
  const socketResult = await benchmarkTransport(new UnixSocketHarness())

  const results = {
    generatedAt: new Date().toISOString(),
    config: benchmarkConfig,
    results: [stdoutResult, socketResult],
  }

  writeFileSync(reportPath, `${JSON.stringify(results, null, 2)}\n`)
  console.log(JSON.stringify(results, null, 2))
}

await main()
