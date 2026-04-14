import { readFile } from "node:fs/promises"
import { Effect } from "effect"
import { UserInputError } from "../../domain/errors"
import { decodeSessionFlowContract } from "../../domain/flow-v2"
import {
  defaultPerfTimeLimitForTemplate,
  formatNanoseconds,
  type PerfAroundFlowResult,
  perfTemplateChoiceText,
  perfTemplateChoices,
  type PerfRecordResult,
  type PerfSignpostSummaryResult,
  type PerfTemplate,
} from "../../domain/perf"
import { DaemonClient } from "../../services/DaemonClient"
import { invalidOption, optionalOption, requireOption, unknownSubcommand } from "../options"

const customTemplateUsageText = "--custom-template <path.tracetemplate>"
const perfRecordTemplateUsageText = `--template ${perfTemplateChoiceText} or ${customTemplateUsageText}`

const parseTemplate = (value: string) => {
  if (perfTemplateChoices.includes(value as PerfTemplate)) {
    return Effect.succeed(value as PerfTemplate)
  }

  return invalidOption(
    "--template",
    `invalid value ${value}; expected ${perfTemplateChoiceText}.`,
    `Provide --template ${perfTemplateChoiceText} and retry the command.`,
  )
}

const resolveRecordTemplateSelection = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const templateOption = yield* optionalOption(args, "--template")
    const customTemplatePath = yield* optionalOption(args, "--custom-template")

    if (templateOption && customTemplatePath) {
      return yield* invalidOption(
        "--custom-template",
        "cannot be combined with --template.",
        `Provide ${perfRecordTemplateUsageText} and retry the command.`,
      )
    }

    if (templateOption) {
      return {
        template: yield* parseTemplate(templateOption),
        customTemplatePath: undefined,
      }
    }

    if (customTemplatePath) {
      return {
        template: undefined,
        customTemplatePath,
      }
    }

    return yield* Effect.fail(new UserInputError({
      code: "missing-option",
      reason: "Missing required option --template or --custom-template.",
      nextStep: `Provide ${perfRecordTemplateUsageText} and retry the command.`,
      details: [],
    }))
  })

const parseGroupBy = (value: string) => {
  if (value === "signpost") {
    return Effect.succeed("signpost" as const)
  }

  return invalidOption(
    "--group-by",
    `invalid value ${value}; expected signpost.`,
    "Provide --group-by signpost and retry the command.",
  )
}

const readFlowFile = (path: string) =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (error) =>
        new UserInputError({
          code: "perf-flow-file-read",
          reason: `Could not read flow file ${path}: ${error instanceof Error ? error.message : String(error)}.`,
          nextStep: "Verify the flow file path and retry the command.",
          details: [],
        }),
    })

    return yield* Effect.try({
      try: () => decodeSessionFlowContract(JSON.parse(raw) as unknown),
      catch: (error) =>
        new UserInputError({
          code: "perf-flow-file-parse",
          reason: `Could not parse flow file ${path}: ${error instanceof Error ? error.message : String(error)}.`,
          nextStep: "Validate the flow JSON shape and retry the command.",
          details: [],
        }),
    })
  })

const formatPerfResult = (result: PerfRecordResult): string => {
  const metricLines = result.summary.metrics.map((metric) => `- ${metric.label}: ${metric.value}`)
  const diagnosisLines = result.diagnoses.map((diagnosis) => {
    const prefix = diagnosis.wall ? "wall" : diagnosis.severity
    const details = diagnosis.details.map((detail) => `    ${detail}`).join("\n")
    return details.length > 0
      ? `- [${prefix}] ${diagnosis.summary}\n${details}`
      : `- [${prefix}] ${diagnosis.summary}`
  })
  const templateLabel = result.template === "custom"
    ? `${result.templateName} (custom)`
    : `${result.templateName} (${result.template})`

  return [
    `template: ${templateLabel}`,
    ...(result.customTemplatePath ? [`template path: ${result.customTemplatePath}`] : []),
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

const formatPerfAroundResult = (result: PerfAroundFlowResult): string => {
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
    `recorded at: ${result.recordedAt}`,
    `xctrace: ${result.xctraceVersion}`,
    `session after record: ${result.session.state}`,
    `flow verdict: ${result.flow.verdict}`,
    `flow summary: ${result.flow.summary}`,
    `trace: ${result.artifacts.trace.absolutePath}`,
    `toc: ${result.artifacts.toc.absolutePath}`,
    "",
    "diagnoses:",
    ...(diagnosisLines.length > 0 ? diagnosisLines : ["- none"]),
  ].join("\n")
}

const formatSignpostSummary = (result: PerfSignpostSummaryResult): string => {
  const groups = result.groups.map((group) =>
    `- ${group.intervalName}: count=${group.count}, min=${formatNanoseconds(group.minDurationNs)}, max=${formatNanoseconds(group.maxDurationNs)}, avg=${formatNanoseconds(group.avgDurationNs)}, wall=${formatNanoseconds(group.wallTimeNs)}`,
  )

  return [
    `session: ${result.sessionId}`,
    `artifact: ${result.artifactKey}`,
    `group by: ${result.groupBy}`,
    `generated at: ${result.generatedAt}`,
    `xctrace: ${result.xctraceVersion}`,
    `total intervals: ${result.totalIntervals}`,
    `trace: ${result.artifacts.trace.absolutePath}`,
    `toc: ${result.artifacts.toc.absolutePath}`,
    `export: ${result.artifacts.export.absolutePath}`,
    "",
    "groups:",
    ...(groups.length > 0 ? groups : ["- none"]),
  ].join("\n")
}

export const runPerfCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [subcommand, ...rest] = args
    const asJson = rest.includes("--json")

    switch (subcommand) {
      case "record": {
        const sessionId = yield* requireOption(rest, "--session-id")
        const selection = yield* resolveRecordTemplateSelection(rest)
        const timeLimit = (yield* optionalOption(rest, "--time-limit"))
          ?? (selection.template ? defaultPerfTimeLimitForTemplate(selection.template) : "3s")
        const client = yield* DaemonClient
        const result = yield* client.recordPerf({
          sessionId,
          template: selection.template,
          customTemplatePath: selection.customTemplatePath,
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

      case "around": {
        const sessionId = yield* requireOption(rest, "--session-id")
        const filePath = yield* requireOption(rest, "--file")
        const templateOption = yield* requireOption(rest, "--template")
        const template = yield* parseTemplate(templateOption)
        const flow = yield* readFlowFile(filePath)
        const client = yield* DaemonClient
        const result = yield* client.recordPerfAroundFlow({
          sessionId,
          template,
          flow,
          onEvent: asJson
            ? undefined
            : (stage, message) => {
                console.error(`[${stage}] ${message}`)
              },
        })

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(result, null, 2) : formatPerfAroundResult(result))
        })
        return
      }

      case "summarize": {
        const sessionId = yield* requireOption(rest, "--session-id")
        const artifactKey = yield* requireOption(rest, "--artifact")
        const groupBy = yield* parseGroupBy(yield* requireOption(rest, "--group-by"))
        const client = yield* DaemonClient

        if (groupBy !== "signpost") {
          return yield* invalidOption(
            "--group-by",
            `invalid value ${groupBy}; expected signpost.`,
            "Provide --group-by signpost and retry the command.",
          )
        }

        const result = yield* client.summarizePerfBySignpost({
          sessionId,
          artifactKey,
          onEvent: asJson
            ? undefined
            : (stage, message) => {
                console.error(`[${stage}] ${message}`)
              },
        })

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(result, null, 2) : formatSignpostSummary(result))
        })
        return
      }

      default:
        return yield* unknownSubcommand("perf", subcommand)
    }
  })
