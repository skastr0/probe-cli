import { createWriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Context, Effect, Layer } from "effect"
import { EnvironmentError } from "../domain/errors"
import { type AppleProcessHandle, spawnAppleProcessHandle } from "./AppleProcessSupervisor"
import { resolveProbeLldbBridgeScriptPath, resolveProbeRuntimeRoot } from "./ProjectRoot"
import {
  decodeLldbBridgeFrameLine,
  encodeLldbBridgeRequestLine,
  type LldbBridgeFrame,
  type LldbBridgeReadyFrame,
  type LldbBridgeRequest,
  type LldbBridgeResponseFrame,
} from "./lldbProtocol"

export type { LldbBridgeReadyFrame, LldbBridgeRequest, LldbBridgeResponseFrame } from "./lldbProtocol"

const bridgeReadyTimeoutMs = Number(process.env.PROBE_LLDB_BRIDGE_READY_TIMEOUT_MS ?? 15_000)
const bridgeShutdownTimeoutMs = Number(process.env.PROBE_LLDB_BRIDGE_SHUTDOWN_TIMEOUT_MS ?? 5_000)

const timestampForFile = (): string => new Date().toISOString().replace(/[:.]/g, "-")

export interface LldbBridgeHandle {
  readonly ready: LldbBridgeReadyFrame
  readonly frameLogPath: string
  readonly stderrLogPath: string
  readonly send: (request: Record<string, unknown>, options?: { readonly timeoutMs?: number }) => Promise<LldbBridgeResponseFrame>
  readonly close: () => Promise<void>
  readonly isRunning: () => boolean
  readonly waitForExit: Promise<{ readonly code: number | null; readonly signal: string | null }>
}

const waitForFrame = async (
  queue: Array<LldbBridgeFrame>,
  waiters: Array<(frame: LldbBridgeFrame) => void>,
  timeoutMs: number,
): Promise<LldbBridgeFrame> => {
  if (queue.length > 0) {
    return queue.shift()!
  }

  return await new Promise<LldbBridgeFrame>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const waiterIndex = waiters.indexOf(waiter)
      if (waiterIndex >= 0) {
        waiters.splice(waiterIndex, 1)
      }
      reject(new Error(`Timed out waiting for LLDB bridge frame after ${timeoutMs} ms.`))
    }, timeoutMs)

    const waiter = (frame: LldbBridgeFrame) => {
      clearTimeout(timeout)
      resolve(frame)
    }

    waiters.push(waiter)
  })
}

/**
 * Spawns the LLDB bridge's line-framed JSON-RPC process via the supervisor
 * (piped stdin for requests, the raw stdout stream for `readline`-based frame
 * parsing, stderr streamed straight to `stderrLogPath`) and layers the
 * request/response queueing and ready-handshake wait on top. Generic over
 * `command`/`commandArgs` so this has direct test coverage against a fake
 * script speaking the same protocol (see LldbBridge.processHelpers.test.ts)
 * without needing a real LLDB/Xcode Python environment.
 */
export const startLldbBridgeProcess = async (args: {
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
  readonly frameLogPath: string
  readonly stderrLogPath: string
  readonly readyTimeoutMs?: number
  readonly shutdownGracePeriodMs?: number
}): Promise<LldbBridgeHandle> => {
  const readyTimeoutMs = args.readyTimeoutMs ?? bridgeReadyTimeoutMs
  const shutdownGracePeriodMs = args.shutdownGracePeriodMs ?? bridgeShutdownTimeoutMs

  const frameLog = createWriteStream(args.frameLogPath, { flags: "a" })

  const handle: AppleProcessHandle = await spawnAppleProcessHandle({
    command: args.command,
    commandArgs: args.commandArgs,
    cwd: process.cwd(),
    stdin: "pipe",
    externalStdout: true,
    stderrArtifactPath: args.stderrLogPath,
    gracePeriodMs: shutdownGracePeriodMs,
  })

  const stdin = handle.stdin
  const stdout = handle.stdout

  if (stdin === null || stdout === null) {
    throw new Error("AppleProcessSupervisor did not provide piped stdio for the LLDB bridge.")
  }

  const queue: Array<LldbBridgeFrame> = []
  const waiters: Array<(frame: LldbBridgeFrame) => void> = []
  let nextId = 0
  let requestChain = Promise.resolve<void>(undefined)

  const lines = createInterface({ input: stdout, crlfDelay: Infinity })
  lines.on("line", (line) => {
    frameLog.write(`${line}\n`)

    const frame = decodeLldbBridgeFrameLine(line)
    const waiter = waiters.shift()

    if (waiter) {
      waiter(frame)
      return
    }

    queue.push(frame)
  })

  const waitForExit = handle.awaitExit.then((result) => ({ code: result.exitCode, signal: result.signal }))
  void waitForExit.finally(() => {
    lines.close()
    frameLog.end()
  })

  const ready = await waitForFrame(queue, waiters, readyTimeoutMs)
  if (ready.kind !== "ready") {
    throw new Error(`Expected LLDB bridge ready frame, received ${JSON.stringify(ready)}.`)
  }

  const isRunning = handle.isRunning

  const send = (
    request: Record<string, unknown>,
    options?: { readonly timeoutMs?: number },
  ) => {
    const execute = async (): Promise<LldbBridgeResponseFrame> => {
      if (!isRunning() || stdin.destroyed || !stdin.writable) {
        throw new Error("The LLDB bridge is not running.")
      }

      const id = `lldb-${++nextId}`
      stdin.write(encodeLldbBridgeRequestLine({ id, ...request } as LldbBridgeRequest))
      const frame = await waitForFrame(
        queue,
        waiters,
        options?.timeoutMs ?? readyTimeoutMs,
      )

      if (frame.kind !== "response" || frame.id !== id) {
        throw new Error(`Unexpected LLDB bridge frame for ${id}: ${JSON.stringify(frame)}`)
      }

      return frame
    }

    const result = requestChain.then(execute, execute)
    requestChain = result.then(() => undefined, () => undefined)
    return result
  }

  const close = async () => {
    if (!isRunning()) {
      return
    }

    // Ask the bridge to shut down at the application level first (lets LLDB
    // detach/clean up its own state) before falling back to OS signals.
    await send({ command: "shutdown" }).catch(() => undefined)

    // handle.stop() sends SIGTERM, waits shutdownGracePeriodMs, escalates to
    // SIGKILL, and joins exit -- the TERM -> grace -> KILL ladder this used
    // to hand-roll via a bespoke Promise.race, now shared with every other
    // supervisor-owned child instead of duplicated here. A no-op if the
    // bridge already exited in response to the shutdown request above.
    await handle.stop("SIGTERM")
  }

  return {
    ready,
    frameLogPath: args.frameLogPath,
    stderrLogPath: args.stderrLogPath,
    send,
    close,
    isRunning,
    waitForExit,
  } satisfies LldbBridgeHandle
}

export class LldbBridgeFactory extends Context.Tag("@probe/LldbBridgeFactory")<
  LldbBridgeFactory,
  {
    readonly start: (args: {
      readonly sessionId: string
      readonly debugDirectory: string
    }) => Effect.Effect<LldbBridgeHandle, EnvironmentError>
  }
>() {}

export const LldbBridgeFactoryLive = Layer.succeed(
  LldbBridgeFactory,
  LldbBridgeFactory.of({
    start: ({ sessionId, debugDirectory }) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(debugDirectory, { recursive: true })

          const fileStem = `${timestampForFile()}-${sessionId}`
          const bridgeScriptPath = resolveProbeLldbBridgeScriptPath(resolveProbeRuntimeRoot())

          return await startLldbBridgeProcess({
            command: "xcrun",
            commandArgs: ["python3", bridgeScriptPath],
            frameLogPath: join(debugDirectory, `${fileStem}-lldb-bridge.frames.ndjson`),
            stderrLogPath: join(debugDirectory, `${fileStem}-lldb-bridge.stderr.log`),
          })
        },
        catch: (error) =>
          new EnvironmentError({
            code: "lldb-bridge-start",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Verify the Xcode LLDB Python environment and retry the debug attach request.",
            details: [],
          }),
      }),
  }),
)
