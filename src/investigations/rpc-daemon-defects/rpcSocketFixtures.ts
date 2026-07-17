import { access, mkdtemp, rm } from "node:fs/promises"
import { createConnection, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface TempSocketRoot {
  readonly root: string
  readonly socketPath: string
  readonly metadataPath: string
}

export const withTempSocketRoot = async <T>(run: (paths: TempSocketRoot) => Promise<T>): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "probe-investigation-"))

  try {
    return await run({
      root,
      socketPath: join(root, "probe.sock"),
      metadataPath: join(root, "daemon.json"),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export const waitForSocket = async (socketPath: string, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      await access(socketPath)
      return
    } catch {
      await sleep(10)
    }
  }

  throw new Error(`Timed out waiting for socket ${socketPath}.`)
}

export const connectRawSocket = (socketPath: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.once("connect", () => resolve(socket))
    socket.once("error", reject)
  })

export const writeRawLine = (socket: Socket, line: string): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.write(line, (error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
