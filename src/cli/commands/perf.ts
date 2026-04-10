import { Effect } from "effect"
import type { PerfRecordResult, PerfTemplate } from "../../domain/perf"
import { DaemonClient } from "../../services/DaemonClient"
import { invalidOption, optionalOption, requireOption, unknownSubcommand } from "../options"

const parseTemplate = (value: string) => {
  switch (value) {
    case "time-profiler":
    case "system-trace":
    case "metal-system-trace":
      return Effect.succeed(value satisfies PerfTemplate)
    default:
      return invalidOption(
        "--template",
        `invalid value ${value}; expected time-profiler, system-trace, or metal-system-trace.`,
        "Provide --template time-profiler|system-trace|metal-system-trace and retry the command.",
      )
  }
}

const formatPerfResult = (result: PerfRecordResult): string => {
  const metricLines = result.summary.metrics.map((metric) => `- ${metric.label}: ${metric.value}`)
  const diagnosisLines = result.diagnoses.map((diagnosis) => {
    const prefix = diagnosis.wall ? "wall" : diagnosis.severity
    const details = diagnosis.details.map((detail) => `    ${detail}`).join("\n")
    return details.length > 0
      ? `- [${prefix}] ${diagnosis.summary}\n${details}`
      : `- [${prefix}] ${diagnosis.summary}`
  })

  return [
    `template: ${result.templateName} (${result.template})`,
    `session: ${result.sessionId}`,
    `session after record: ${result.session.state}`,
    `runner wrapper after record: ${result.session.healthCheck.wrapperRunning ? "running" : "not running"}`,
    `time limit: ${result.timeLimit}`,
    `recorded at: ${result.recordedAt}`,
    `xctrace: ${result.xctraceVersion}`,
    `summary: ${result.summary.headline}`,
    "",
    "metrics:",
    ...metricLines,
    "",
    "diagnoses:",
    ...diagnosisLines,
    "",
    "artifacts:",
    `- trace: ${result.artifacts.trace.absolutePath}`,
    `- toc: ${result.artifacts.toc.absolutePath}`,
    ...result.artifacts.exports.map((artifact) => `- ${artifact.label}: ${artifact.absolutePath}`),
  ].join("\n")
}

export const runPerfCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [subcommand, ...rest] = args
    const asJson = rest.includes("--json")

    switch (subcommand) {
      case "record": {
        const sessionId = yield* requireOption(rest, "--session-id")
        const templateOption = yield* requireOption(rest, "--template")
        const template = yield* parseTemplate(templateOption)
        const timeLimit = (yield* optionalOption(rest, "--time-limit")) ?? "3s"
        const client = yield* DaemonClient
        const result = yield* client.recordPerf({
          sessionId,
          template,
          timeLimit,
          onEvent: asJson
            ? undefined
            : (stage, message) => {
                console.error(`[${stage}] ${message}`)
              },
        })

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(result, null, 2) : formatPerfResult(result))
        })
        return
      }

      default:
        return yield* unknownSubcommand("perf", subcommand)
    }
  })
