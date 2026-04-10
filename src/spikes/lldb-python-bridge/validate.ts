#!/usr/bin/env bun

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"

type BridgeReady = {
  readonly kind: "ready"
  readonly bridgePid: number
  readonly pythonExecutable: string
  readonly lldbPythonPath: string
  readonly lldbVersion: string
  readonly initFilesSkipped: boolean
  readonly asyncMode: boolean
}

type BridgeResponse = {
  readonly kind: "response"
  readonly id: string | null
  readonly command: string
  readonly ok: boolean
  readonly error?: string
  readonly process?: {
    readonly pid: number
    readonly state: string
    readonly stopId?: number
    readonly numThreads?: number
    readonly selectedThread?: {
      readonly threadId: number
      readonly indexId: number
      readonly stopReason: string
    } | null
    readonly threads?: ReadonlyArray<{
      readonly threadId: number
      readonly indexId: number
      readonly stopReason: string
      readonly stopDescription: string | null
      readonly frames: ReadonlyArray<{
        readonly frameId: number
        readonly function: string | null
        readonly displayFunction: string | null
        readonly lineEntry: { readonly file: string | null; readonly line: number; readonly column: number } | null
      }>
    }>
  }
  readonly targetId?: number
  readonly thread?: {
    readonly threadId: number
    readonly indexId: number
    readonly stopReason: string
    readonly stopDescription: string | null
    readonly frames: ReadonlyArray<{
      readonly frameId: number
      readonly function: string | null
      readonly displayFunction: string | null
      readonly lineEntry: { readonly file: string | null; readonly line: number; readonly column: number } | null
    }>
  }
  readonly frame?: {
    readonly frameId: number
    readonly function: string | null
    readonly displayFunction: string | null
    readonly lineEntry: { readonly file: string | null; readonly line: number; readonly column: number } | null
  }
  readonly variables?: ReadonlyArray<{
    readonly name: string | null
    readonly type: string | null
    readonly value: string | null
    readonly summary: string | null
    readonly valueText: string | null
  }>
  readonly expression?: string
  readonly result?: {
    readonly name: string | null
    readonly type: string | null
    readonly value: string | null
    readonly summary: string | null
    readonly valueText: string | null
  }
  readonly options?: Record<string, unknown>
  readonly pid?: number
  readonly state?: string
  readonly bridgePid?: number
  readonly pythonExecutable?: string
  readonly lldbPythonPath?: string
  readonly lldbVersion?: string
}

type BridgeFrame = BridgeReady | BridgeResponse

interface CommandRecord {
  readonly request: Record<string, unknown>
  readonly response: BridgeResponse
}

const spikeDir = import.meta.dir
const bridgePath = join(spikeDir, "bridge.py")
const targetSourcePath = join(spikeDir, "target.c")
const entitlementsPath = join(spikeDir, "debuggee-entitlements.plist")
const resultsPath = join(process.cwd(), "knowledge", "lldb-python", "bridge-spike-results.json")

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const runCommand = async (command: string, args: ReadonlyArray<string>) => {
  const child = spawn(command, [...args], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  })

  let stdout = ""
  let stderr = ""

  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    stdout += chunk
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk
  })

  const [code] = (await once(child, "close")) as [number]
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stdout}${stderr}`)
  }

  return { stdout, stderr }
}

class BridgeHarness {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly lines
  private readonly queue: Array<BridgeFrame> = []
  private readonly waiters: Array<(frame: BridgeFrame) => void> = []
  private readonly stderrChunks: string[] = []
  private nextId = 0

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child
    this.child.stdout.setEncoding("utf8")
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (chunk) => {
      this.stderrChunks.push(String(chunk))
    })

    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    this.lines.on("line", (line) => {
      const frame = JSON.parse(line) as BridgeFrame
      const waiter = this.waiters.shift()
      if (waiter) {
        waiter(frame)
        return
      }

      this.queue.push(frame)
    })
  }

  static async start() {
    const child = spawn("/usr/bin/python3", [bridgePath], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    })

    const harness = new BridgeHarness(child)
    const ready = (await harness.nextFrame()) as BridgeReady
    if (ready.kind !== "ready") {
      throw new Error(`Expected bridge ready frame, received ${JSON.stringify(ready)}`)
    }
    return { harness, ready }
  }

  get stderr() {
    return this.stderrChunks.join("")
  }

  private async nextFrame() {
    if (this.queue.length > 0) {
      return this.queue.shift()!
    }

    return await new Promise<BridgeFrame>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  async command(request: Record<string, unknown>) {
    const id = `bridge-${++this.nextId}`
    const frame = { id, ...request }
    this.child.stdin.write(`${JSON.stringify(frame)}\n`)
    const response = (await this.nextFrame()) as BridgeResponse
    if (response.kind !== "response" || response.id !== id) {
      throw new Error(`Unexpected bridge frame for ${id}: ${JSON.stringify(response)}`)
    }
    return { request: frame, response } satisfies CommandRecord
  }

  async shutdown() {
    if (this.child.exitCode !== null || this.child.killed) {
      return
    }

    await this.command({ command: "shutdown" })
    await once(this.child, "exit")
  }
}

const launchTarget = (binaryPath: string) => {
  const child = spawn(binaryPath, [], {
    cwd: process.cwd(),
    stdio: "ignore",
  })

  return child
}

const pickLeafFrame = (response: BridgeResponse) => {
  const threads = response.process?.threads
  if (!threads) {
    throw new Error(`Attach response missing thread inventory: ${JSON.stringify(response)}`)
  }

  for (const thread of threads) {
    const frame = thread.frames.find((candidate) => candidate.function?.includes("probe_bridge_leaf_wait"))
    if (frame) {
      return {
        threadIndexId: thread.indexId,
        frameIndex: frame.frameId,
      }
    }
  }

  throw new Error(`Could not find probe_bridge_leaf_wait in attached thread inventory: ${JSON.stringify(threads)}`)
}

const assertOk = (record: CommandRecord) => {
  if (!record.response.ok) {
    throw new Error(`${record.response.command} failed: ${record.response.error}`)
  }
}

const waitForPidExit = async (pid: number, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await delay(50)
    } catch {
      return true
    }
  }
  return false
}

const main = async () => {
  const workDir = mkdtempSync(join(tmpdir(), "probe-lldb-bridge-"))
  const targetBinaryPath = join(workDir, "probe-lldb-target")
  const compileCommand = [
    "clang",
    "-g",
    "-O0",
    "-fno-omit-frame-pointer",
    targetSourcePath,
    "-o",
    targetBinaryPath,
  ]

  const cleanupPaths = [workDir]
  const targetChildren: Array<ReturnType<typeof launchTarget>> = []

  let bridge: BridgeHarness | null = null
  let ready: BridgeReady | null = null

  try {
    const compile = await runCommand("xcrun", compileCommand)
    const codesign = await runCommand("codesign", [
      "--force",
      "--sign",
      "-",
      "--entitlements",
      entitlementsPath,
      targetBinaryPath,
    ])
    const entitlements = await runCommand("codesign", ["-d", "--entitlements", ":-", targetBinaryPath])

    const started = await BridgeHarness.start()
    bridge = started.harness
    ready = started.ready

    const target1 = launchTarget(targetBinaryPath)
    targetChildren.push(target1)
    if (target1.pid === undefined) {
      throw new Error("Target 1 did not expose a pid.")
    }
    await delay(1_000)

    const handshake = await bridge.command({ command: "handshake" })
    assertOk(handshake)

    const attach = await bridge.command({ command: "attach", pid: target1.pid })
    assertOk(attach)

    const selectedFrame = pickLeafFrame(attach.response)

    const backtrace = await bridge.command({
      command: "backtrace",
      frameLimit: 8,
      threadIndexId: selectedFrame.threadIndexId,
    })
    assertOk(backtrace)

    const vars = await bridge.command({
      command: "vars",
      threadIndexId: selectedFrame.threadIndexId,
      frameIndex: selectedFrame.frameIndex,
    })
    assertOk(vars)

    const evalExpression = await bridge.command({
      command: "eval",
      threadIndexId: selectedFrame.threadIndexId,
      frameIndex: selectedFrame.frameIndex,
      expression: "counter + derived",
      timeoutMs: 500,
    })
    assertOk(evalExpression)

    await delay(750)
    const repeatBacktrace = await bridge.command({ command: "backtrace", frameLimit: 8 })
    assertOk(repeatBacktrace)

    const signalContinuePromise = bridge.command({ command: "continue" })
    await delay(200)
    process.kill(target1.pid, "SIGUSR1")
    const signalStop = await signalContinuePromise
    assertOk(signalStop)

    const crashContinuePromise = bridge.command({ command: "continue" })
    await delay(200)
    process.kill(target1.pid, "SIGABRT")
    const crashStop = await crashContinuePromise
    assertOk(crashStop)

    const exitAfterCrash = await bridge.command({ command: "continue" })
    assertOk(exitAfterCrash)
    await waitForPidExit(target1.pid, 3_000)

    const target2 = launchTarget(targetBinaryPath)
    targetChildren.push(target2)
    if (target2.pid === undefined) {
      throw new Error("Target 2 did not expose a pid.")
    }
    await delay(1_000)

    const reattach = await bridge.command({ command: "attach", pid: target2.pid })
    assertOk(reattach)

    const reattachBacktrace = await bridge.command({ command: "backtrace", frameLimit: 8 })
    assertOk(reattachBacktrace)

    const detach = await bridge.command({ command: "detach" })
    assertOk(detach)

    process.kill(target2.pid, "SIGTERM")
    await waitForPidExit(target2.pid, 3_000)

    const results = {
      capturedAt: new Date().toISOString(),
      host: {
        cwd: process.cwd(),
        platform: process.platform,
        arch: process.arch,
      },
      tooling: {
        bridgeReady: ready,
        compileCommand: `xcrun ${compileCommand.join(" ")}`,
        compileStdout: compile.stdout,
        compileStderr: compile.stderr,
        codesignCommand: `codesign --force --sign - --entitlements ${entitlementsPath} ${targetBinaryPath}`,
        codesignStdout: codesign.stdout,
        codesignStderr: codesign.stderr,
        debuggeeEntitlements: entitlements.stderr || entitlements.stdout,
        targetBinaryPath,
      },
      commands: {
        handshake,
        attach,
        backtrace,
        vars,
        evalExpression,
        repeatBacktrace,
        signalStop,
        crashStop,
        exitAfterCrash,
        reattach,
        reattachBacktrace,
        detach,
      },
      derivedEvidence: {
        attachedPid: attach.response.process?.pid ?? null,
        attachedState: attach.response.process?.state ?? null,
        backtraceFunctions:
          backtrace.response.thread?.frames.map((frame) => frame.function ?? frame.displayFunction ?? "<unknown>") ?? [],
        vars:
          vars.response.variables?.map((value) => ({
            name: value.name,
            type: value.type,
            value: value.value,
            summary: value.summary,
          })) ?? [],
        evalValue: evalExpression.response.result?.value ?? evalExpression.response.result?.summary ?? null,
        signalState: signalStop.response.process?.state ?? null,
        signalStopReason: signalStop.response.process?.selectedThread?.stopReason ?? null,
        crashState: crashStop.response.process?.state ?? null,
        crashStopReason: crashStop.response.process?.selectedThread?.stopReason ?? null,
        exitState: exitAfterCrash.response.process?.state ?? null,
        reattachedPid: reattach.response.process?.pid ?? null,
      },
      bridgeStderr: bridge.stderr,
    }

    mkdirSync(dirname(resultsPath), { recursive: true })
    writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`, "utf8")

    console.log(`Wrote bridge spike results to ${resultsPath}`)
  } finally {
    if (bridge) {
      await bridge.shutdown().catch(() => undefined)
    }

    for (const child of targetChildren) {
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(child.pid, "SIGKILL")
        } catch {
          // best effort cleanup
        }
      }
    }

    for (const path of cleanupPaths) {
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true })
      }
    }
  }
}

await main()
