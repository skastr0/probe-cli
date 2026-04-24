#!/usr/bin/env bun

import { Effect, Exit } from "effect"
import { perfTemplateChoiceText } from "../domain/perf"
import { formatProbeError, isProbeError, toFailurePayload } from "../domain/errors"
import { probeRuntime } from "../runtime"
import { runExamplesCommand, runSchemaCommand } from "./discovery"
import { runDrillCommand } from "./commands/drill"
import { runCapabilitiesCommand, runDoctorCommand } from "./commands/doctor"
import { runPerfCommand } from "./commands/perf"
import { runServeCommand } from "./commands/serve"
import { runSessionCommand } from "./commands/session"
import { runValidateCommand } from "./commands/validate"
import { hasMachineJsonOutput } from "./json"

const helpText = `Probe control plane

Usage:
  probe doctor [--output-json|--json]
  probe capabilities [--output-json|--json]
  probe schema list [--output-json|--json]
  probe schema show <schema-id|command|rpc-method> [--output-json|--json]
  probe examples list [--output-json|--json]
  probe examples show <name|command> [--output-json|--json]
  probe doctor accessibility (--input-json <payload> | --session-id <id>) [--output-json|--json]
  probe doctor commerce (--input-json <payload> | --bundle-id <bundle-id> [--mode local-storekit|sandbox|testflight] [--config <path>] [--provider revenuecat]) [--output-json|--json]
  probe serve
  probe validate accessibility (--input-json <payload> | --session-id <id> [--scope current-screen]) [--output-json|--json]
  probe validate commerce (--input-json <payload> | --session-id <id> --mode local-storekit|sandbox|testflight [--plan <commerce-plan.json>] [--provider revenuecat]) [--output-json|--json]
  probe session list [--output-json|--json]
  probe session open [--input-json <payload>] [--target simulator|device] [--bundle-id <bundle-id>] [--simulator-udid <udid>] [--device-id <id>] [--output-json|--json]
  probe session show --session-id <id> [--output-json|--json]
  probe session health --session-id <id> [--output-json|--json]
  probe session logs (--input-json <payload> | --session-id <id> [--source runner|build|wrapper|stdout|simulator] [--lines 80] [--match <text>] [--seconds 2] [--predicate <expr>] [--process <name>] [--subsystem <name>] [--category <name>] [--output auto|inline|artifact]) [--output-json|--json]
  probe session logs mark (--input-json <payload> | --session-id <id> --label <label>) [--output-json|--json]
  probe session logs capture (--input-json <payload> | --session-id <id> [--seconds 3]) [--output-json|--json]
  probe session logs doctor (--input-json <payload> | --session-id <id>) [--output-json|--json]
  probe session snapshot --session-id <id> [--output auto|inline|artifact] [--output-json|--json]
  probe session run (--input-json <payload> | --session-id <id> (--file <flow.json> | --stdin)) [--output-json|--json]
  probe session action (--input-json <payload> | --session-id <id> --file <action.json>) [--output-json|--json]
  probe session recording export --session-id <id> [--label <name>] [--output-json|--json]
  probe session replay (--input-json <payload> | --session-id <id> --file <recording.json>) [--output-json|--json]
  probe session result summary (--input-json <payload> | --session-id <id>) [--output-json|--json]
  probe session result attachments (--input-json <payload> | --session-id <id>) [--output-json|--json]
  probe session screenshot --session-id <id> [--label <name>] [--output auto|inline|artifact] [--output-json|--json]
  probe session video --session-id <id> --duration <duration> [--output-json|--json]
  probe session close --session-id <id> [--output-json|--json]
  probe perf record (--input-json <payload> | --session-id <id> (--template ${perfTemplateChoiceText} | --custom-template <path.tracetemplate>) [--time-limit <duration>]) [--output-json|--json]
  probe perf around (--input-json <payload> | --session-id <id> --file <flow.json> --template ${perfTemplateChoiceText}) [--output-json|--json]
  probe perf summarize --session-id <id> --artifact <trace-key> --group-by signpost [--output-json|--json]
  probe drill (--input-json <payload> | --session-id <id> --artifact <key> [--xcresult summary|attachments [--attachment-id <id>] | --json-pointer <ptr> | --xpath <expr> | --lines <start:end> [--match <text>]] [--output auto|inline|artifact]) [--output-json|--json]

Notes:
  - serve runs the long-lived daemon over the local Unix socket
  - session commands are thin clients that talk to the daemon
  - --output-json is the canonical machine-output flag; bare --json remains a compatibility alias
  - use --input-json, --file, or --stdin for domain JSON payloads; --json <payload> is no longer accepted
  - on simulator, omit --bundle-id to use Probe's built-in fixture app, or pass --bundle-id <bundle-id> to attach to an already-running installed app
  - built-in perf templates: ${perfTemplateChoiceText}
  - custom perf templates: pass --custom-template <path.tracetemplate> after saving a template from Instruments.app
  - perf recording defaults to 60s for metal-system-trace and 3s for time-profiler, system-trace, hangs, swift-concurrency, logging, and custom templates
  - CPU Counters guided mode works without GUI preconfiguration, but specific counter selections and other GUI-authored templates still require Instruments.app setup first
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

const commandName = (args: ReadonlyArray<string>) =>
  args.filter((arg) => !arg.startsWith("--")).slice(0, 3).join(" ") || "probe"

const printFailure = (args: ReadonlyArray<string>, error: unknown) =>
  Effect.sync(() => {
    if (hasMachineJsonOutput(args) && isProbeError(error)) {
      const failure = toFailurePayload(error)
      console.error(JSON.stringify({
        ok: false,
        command: commandName(args),
        error: {
          type: error._tag,
          message: failure.reason,
          details: {
            ...failure,
            next_step: failure.next_step,
            retryable: failure.retryable,
          },
        },
      }, null, 2))
      return
    }

    const message = isProbeError(error)
      ? formatProbeError(error)
      : String(error)

    console.error(message)
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

      case "capabilities": {
        yield* runCapabilitiesCommand(rest)
        return
      }

      case "schema": {
        yield* runSchemaCommand(rest)
        return
      }

      case "examples": {
        yield* runExamplesCommand(rest)
        return
      }

      case "serve": {
        yield* runServeCommand
        return
      }

      case "validate": {
        yield* runValidateCommand(rest)
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
        yield* printFailure(args, error)
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
