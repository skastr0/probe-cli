#!/usr/bin/env bun

import { Effect, Exit } from "effect"
import { formatProbeError, isProbeError } from "../domain/errors"
import { probeRuntime } from "../runtime"
import { runDrillCommand } from "./commands/drill"
import { runDoctorCommand } from "./commands/doctor"
import { runPerfCommand } from "./commands/perf"
import { runServeCommand } from "./commands/serve"
import { runSessionCommand } from "./commands/session"

const helpText = `Probe control plane

Usage:
  probe doctor [--json]
  probe serve
  probe session open [--bundle-id dev.probe.fixture] [--simulator-udid <udid>] [--json]
  probe session health --session-id <id> [--json]
  probe session logs --session-id <id> [--source runner|build|wrapper|stdout|simulator] [--lines 80] [--match <text>] [--seconds 2] [--predicate <expr>] [--process <name>] [--subsystem <name>] [--category <name>] [--output auto|inline|artifact] [--json]
  probe session snapshot --session-id <id> [--output auto|inline|artifact] [--json]
  probe session action --session-id <id> --file <action.json> [--json]
  probe session recording export --session-id <id> [--label <name>] [--json]
  probe session replay --session-id <id> --file <recording.json> [--json]
  probe session screenshot --session-id <id> [--label <name>] [--output auto|inline|artifact] [--json]
  probe session close --session-id <id> [--json]
  probe perf record --session-id <id> --template time-profiler|system-trace|metal-system-trace [--time-limit 3s] [--json]
  probe drill --session-id <id> --artifact <key> [--json-pointer <ptr> | --xpath <expr> | --lines <start:end> [--match <text>]] [--output auto|inline|artifact] [--json]

Notes:
  - serve runs the long-lived daemon over the local Unix socket
  - session commands are thin clients that talk to the daemon
  - the current vertical slice is honest and fixture-backed: dev.probe.fixture on Simulator
`

const print = (text: string) =>
  Effect.sync(() => {
    console.log(text)
  })

const printError = (text: string) =>
  Effect.sync(() => {
    console.error(text)
  })

const markFailure = Effect.sync(() => {
  process.exitCode = 1
})

const runCli = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [command, ...rest] = args

    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h": {
        yield* print(helpText)
        return
      }

      case "doctor": {
        yield* runDoctorCommand(rest)
        return
      }

      case "serve": {
        yield* runServeCommand
        return
      }

      case "session": {
        yield* runSessionCommand(rest)
        return
      }

      case "perf": {
        yield* runPerfCommand(rest)
        return
      }

      case "drill": {
        yield* runDrillCommand(rest)
        return
      }

      default: {
        yield* printError(`Unknown command: ${command}`)
        yield* markFailure
        yield* print(helpText)
      }
    }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        const message = isProbeError(error)
          ? formatProbeError(error)
          : String(error)

        yield* printError(message)
        yield* markFailure
      }),
    ),
  )

const main = async () => {
  const exit = await probeRuntime.runPromiseExit(runCli(process.argv.slice(2)))

  if (Exit.isFailure(exit)) {
    console.error(exit.cause)
    process.exitCode = 1
  }

  await probeRuntime.dispose()
}

await main()
