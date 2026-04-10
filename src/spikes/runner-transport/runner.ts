#!/usr/bin/env bun

import { existsSync, rmSync } from "node:fs"
import net from "node:net"
import { createInterface } from "node:readline"
import { decodeJsonLine, encodeJsonLine, type RunnerCommand, type RunnerResponse, type TransportKind } from "./protocol"

const usage = `Usage: bun run src/spikes/runner-transport/runner.ts --transport <stdout-jsonl|unix-socket> [--socket-path <path>]`

const parseArgs = () => {
  const args = process.argv.slice(2)
  let transport: TransportKind | undefined
  let socketPath: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    switch (arg) {
      case "--transport":
        transport = args[index + 1] as TransportKind | undefined
        index += 1
        break
      case "--socket-path":
        socketPath = args[index + 1]
        index += 1
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (transport !== "stdout-jsonl" && transport !== "unix-socket") {
    throw new Error(`Missing or invalid --transport. ${usage}`)
  }

  if (transport === "unix-socket" && !socketPath) {
    throw new Error(`--socket-path is required for unix-socket. ${usage}`)
  }

  return {
    transport,
    socketPath,
  }
}

const args = parseArgs()

let sequence = 0

const responseFor = (command: RunnerCommand, transport: TransportKind): RunnerResponse => ({
  kind: "response",
  id: command.id,
  transport,
  pid: process.pid,
  ok: true,
  action: command.action,
  sequence: ++sequence,
  payload: command.payload,
})

const runCommand = (
  command: RunnerCommand,
  transport: TransportKind,
  send: (response: RunnerResponse) => void,
  shutdown: () => void,
) => {
  if (command.action === "crash") {
    process.exit(86)
  }

  const response = responseFor(command, transport)
  send(response)

  if (command.action === "shutdown") {
    shutdown()
  }
}

if (args.transport === "stdout-jsonl") {
  process.stdout.write(
    encodeJsonLine({
      kind: "ready",
      transport: args.transport,
      pid: process.pid,
    }),
  )

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

  lines.on("line", (line) => {
    const command = decodeJsonLine<RunnerCommand>(line)
    runCommand(
      command,
      args.transport,
      (response) => {
        process.stdout.write(encodeJsonLine(response))
      },
      () => {
        lines.close()
        setImmediate(() => process.exit(0))
      },
    )
  })

  process.stdin.resume()
} else {
  const socketPath = args.socketPath!

  if (existsSync(socketPath)) {
    rmSync(socketPath, { force: true })
  }

  const cleanupSocketPath = () => {
    if (existsSync(socketPath)) {
      rmSync(socketPath, { force: true })
    }
  }

  const server = net.createServer((socket) => {
    socket.setNoDelay(true)

    const lines = createInterface({ input: socket, crlfDelay: Infinity })
    const send = (response: RunnerResponse) => {
      socket.write(encodeJsonLine(response))
    }

    const shutdown = () => {
      lines.close()
      socket.end()
      server.close(() => {
        cleanupSocketPath()
        process.exit(0)
      })
    }

    lines.on("line", (line) => {
      const command = decodeJsonLine<RunnerCommand>(line)
      runCommand(command, args.transport, send, shutdown)
    })
  })

  const closeServer = () => {
    server.close(() => {
      cleanupSocketPath()
      process.exit(0)
    })
  }

  process.on("SIGINT", closeServer)
  process.on("SIGTERM", closeServer)
  process.on("exit", cleanupSocketPath)

  server.listen(socketPath)
}
