import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { createWriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Context, Effect, Layer } from "effect"
import { EnvironmentError } from "../domain/errors"
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
          const frameLogPath = join(debugDirectory, `${fileStem}-lldb-bridge.frames.ndjson`)
          const stderrLogPath = join(debugDirectory, `${fileStem}-lldb-bridge.stderr.log`)
          const frameLog = createWriteStream(frameLogPath, { flags: "a" })
          const stderrLog = createWriteStream(stderrLogPath, { flags: "a" })
          const bridgeScriptPath = join(import.meta.dir, "..", "bridge", "lldb-python", "bridge.py")
          const child = spawn("xcrun", ["python3", bridgeScriptPath], {
            cwd: process.cwd(),
            stdio: ["pipe", "pipe", "pipe"],
            env: process.env,
          })

          const queue: Array<LldbBridgeFrame> = []
          const waiters: Array<(frame: LldbBridgeFrame) => void> = []
          let nextId = 0
          let requestChain = Promise.resolve<void>(undefined)

          child.stdout.setEncoding("utf8")
          child.stderr.setEncoding("utf8")
          child.stderr.on("data", (chunk) => {
            stderrLog.write(String(chunk))
          })

          const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
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

          const waitForExit = once(child, "exit").then(([code, signal]) => ({
            code: code as number | null,
            signal: signal as string | null,
          }))
          void waitForExit.finally(() => {
            lines.close()
            frameLog.end()
            stderrLog.end()
          })

          const ready = await waitForFrame(queue, waiters, bridgeReadyTimeoutMs)
          if (ready.kind !== "ready") {
            throw new Error(`Expected LLDB bridge ready frame, received ${JSON.stringify(ready)}.`)
          }

          const isRunning = () => child.exitCode === null && !child.killed

          const send = (
            request: Record<string, unknown>,
            options?: { readonly timeoutMs?: number },
          ) => {
            const execute = async (): Promise<LldbBridgeResponseFrame> => {
              if (!isRunning() || child.stdin.destroyed || !child.stdin.writable) {
                throw new Error("The LLDB bridge is not running.")
              }

              const id = `lldb-${++nextId}`
              child.stdin.write(encodeLldbBridgeRequestLine({ id, ...request } as LldbBridgeRequest))
              const frame = await waitForFrame(
                queue,
                waiters,
                options?.timeoutMs ?? bridgeReadyTimeoutMs,
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

            await send({ command: "shutdown" }).catch(() => undefined)

            await Promise.race([
              waitForExit,
              new Promise<void>((resolve) => {
                setTimeout(() => {
                  if (isRunning()) {
                    child.kill("SIGTERM")
                  }
                  resolve()
                }, bridgeShutdownTimeoutMs)
              }),
            ])

            if (isRunning()) {
              child.kill("SIGKILL")
              await waitForExit.catch(() => undefined)
            }
          }

          return {
            ready,
            frameLogPath,
            stderrLogPath,
            send,
            close,
            isRunning,
            waitForExit,
          } satisfies LldbBridgeHandle
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
