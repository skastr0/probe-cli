import { readFile } from "node:fs/promises"
import { Effect } from "effect"
import {
  decodeActionRecordingScript,
  decodeSessionAction,
  type ActionRecordingScript,
  type SessionActionResult,
  type SessionRecordingExportResult,
  type SessionReplayResult,
} from "../../domain/action"
import { UserInputError } from "../../domain/errors"
import {
  decodeSessionFlowContract,
  type SessionFlowContract,
  type SessionFlowResult,
} from "../../domain/flow-v2"
import type {
  OutputMode,
  SessionResultAttachmentsResult,
  SessionLogDoctorReport,
  SessionLogSource,
  SessionResultSummaryResult,
  SessionScreenshotResult,
  SummaryArtifactResult,
} from "../../domain/output"
import {
  isLiveRunnerDetails,
  isLiveRunnerTransport,
  type SimulatorSessionMode,
  type SessionHealth,
  type SessionListEntry,
} from "../../domain/session"
import type { SessionSnapshotResult } from "../../domain/snapshot"
import { DaemonClient } from "../../services/DaemonClient"
import { invalidOption, optionalOption, requireOption, unknownSubcommand } from "../options"

const defaultTestBundleId = "dev.probe.fixture"

export interface SessionCommandDependencies {
  readonly readStdinText?: () => Effect.Effect<string, UserInputError>
}

const inferSimulatorSessionMode = (bundleId: string): SimulatorSessionMode =>
  bundleId === defaultTestBundleId ? "build-and-install" : "attach-to-running"

const formatSessionListTarget = (target: SessionListEntry["target"]): string => {
  const runtimeSuffix = target.runtime ? ` @ ${target.runtime}` : ""
  return `${target.deviceName} (${target.deviceId}) [${target.platform}${runtimeSuffix}]`
}

const formatSessionList = (sessions: ReadonlyArray<SessionListEntry>): string => {
  if (sessions.length === 0) {
    return "no active sessions"
  }

  return sessions.map((session) => [
    `session id: ${session.id}`,
    `state: ${session.state}`,
    `bundle id: ${session.bundleId}`,
    `target: ${formatSessionListTarget(session.target)}`,
    `opened at: ${session.openedAt}`,
  ].join("\n")).join("\n\n")
}

const printSessionHealth = (health: SessionHealth, asJson: boolean) =>
  Effect.sync(() => {
    console.log(asJson ? JSON.stringify(health, null, 2) : formatSessionHealth(health))
  })

const formatSessionHealth = (health: SessionHealth): string => {
  const capabilityLines = health.capabilities.map(
    (capability) => `- ${capability.area} [${capability.status}] ${capability.summary}`,
  )
  const artifactLines = health.artifacts.map((artifact) => `- ${artifact.key}: ${artifact.absolutePath}`)

  const transportLines = isLiveRunnerTransport(health.transport)
    ? [
        `runner contract: ${health.transport.contract} via ${health.transport.bootstrapSource}`,
        `runner bootstrap: ${health.transport.bootstrapPath}`,
        `runner session: ${health.transport.sessionIdentifier}`,
        `runner ingress: ${health.transport.commandIngress}`,
        `runner egress: ${health.transport.eventEgress}`,
        `stdin probe: ${health.transport.stdinProbeStatus}`,
      ]
    : [
        `runner contract: ${health.transport.contract}`,
        `runner status: preflight-only (${health.transport.commandIngress}/${health.transport.eventEgress})`,
        `transport note: ${health.transport.note}`,
      ]

  const runnerLines = isLiveRunnerDetails(health.runner)
    ? [
        `wrapper running: ${health.healthCheck.wrapperRunning}`,
        `last ping rtt: ${health.healthCheck.pingRttMs ?? "n/a"}`,
        `runner capabilities: ${(health.runner.capabilities ?? []).join(", ") || "none"}`,
        `runner log: ${health.runner.logPath}`,
        `result bundle: ${health.runner.resultBundlePath}`,
      ]
    : [
        `wrapper running: ${health.healthCheck.wrapperRunning}`,
        `last health check: ${health.runner.lastCheckedAt}`,
        `device connection: ${health.runner.connectionStatus}`,
        `build log: ${health.runner.buildLogPath ?? "n/a"}`,
      ]

  return [
    `session id: ${health.sessionId}`,
    `state: ${health.state}`,
    `bundle id: ${health.target.bundleId}`,
    `target: ${health.target.deviceName} (${health.target.deviceId}) [${health.target.platform}]`,
    `connection: ${health.connection.status} - ${health.connection.summary}`,
    `opened at: ${health.openedAt}`,
    `last activity: ${health.updatedAt}`,
    `artifact root: ${health.artifactRoot}`,
    ...transportLines,
    ...runnerLines,
    "",
    "capabilities:",
    ...capabilityLines,
    "",
    "warnings:",
    ...health.warnings.map((warning) => `- ${warning}`),
    "",
    "artifacts:",
    ...artifactLines,
  ].join("\n")
}

const eventPrinter = (enabled: boolean) =>
  enabled
    ? (stage: string, message: string) => {
        console.error(`[${stage}] ${message}`)
      }
    : undefined

const formatSnapshot = (result: SessionSnapshotResult): string => {
  const warningLines = result.warnings.map((warning) => `- ${warning}`)
  const highlightLines = result.diff.highlights.map((highlight) => `- ${highlight.description}`)
  const previewLines = result.preview
    ? [
        `preview: ${result.preview.kind} (${result.preview.nodes.length}/${result.preview.totalNodes})`,
        JSON.stringify(result.preview, null, 2),
      ]
    : ["preview: omitted"]

  return [
    result.summary,
    `snapshot id: ${result.snapshotId}`,
    `captured at: ${result.capturedAt}`,
    `artifact: ${result.artifact.absolutePath}`,
    `retries: ${result.retryCount}`,
    `retry reasons: ${result.retryReasons.length > 0 ? result.retryReasons.join(" | ") : "none"}`,
    `nodes: ${result.metrics.nodeCount}`,
    `interactive nodes: ${result.metrics.interactiveNodeCount}`,
    `weak identity nodes: ${result.metrics.weakIdentityNodeCount}`,
    `diff: ${result.diff.kind}`,
    `diff counts: +${result.diff.summary.added} / -${result.diff.summary.removed} / ~${result.diff.summary.updated} / remapped ${result.diff.summary.remapped}`,
    "",
    "highlights:",
    ...(highlightLines.length > 0 ? highlightLines : ["- none"]),
    "",
    "warnings:",
    ...(warningLines.length > 0 ? warningLines : ["- none"]),
    "",
    ...previewLines,
  ].join("\n")
}

const formatActionResult = (result: SessionActionResult): string => {
  return [
    result.summary,
    `action: ${result.action}`,
    `resolved by: ${result.resolvedBy}`,
    `matched ref: ${result.matchedRef ?? "n/a"}`,
    `verdict: ${result.verdict ?? "n/a"}`,
    `status label: ${result.statusLabel ?? "n/a"}`,
    `latest snapshot: ${result.latestSnapshotId ?? "n/a"}`,
    `recorded steps: ${result.recordingLength}`,
    `retries: ${result.retryCount}`,
    `retry reasons: ${result.retryReasons.length > 0 ? result.retryReasons.join(" | ") : "none"}`,
    `waited ms: ${result.waitedMs ?? "n/a"}`,
    `polls: ${result.polledCount ?? "n/a"}`,
  ].join("\n")
}

const formatRecordingExport = (result: SessionRecordingExportResult): string => {
  return [
    result.summary,
    `steps: ${result.stepCount}`,
    `artifact: ${result.artifact.absolutePath}`,
  ].join("\n")
}

const formatReplayResult = (result: SessionReplayResult): string => {
  return [
    result.summary,
    `steps: ${result.stepCount}`,
    `retried steps: ${result.retriedStepCount}`,
    `semantic fallback recoveries: ${result.semanticFallbackCount}`,
    `final snapshot: ${result.finalSnapshotId ?? "n/a"}`,
    `artifact: ${result.artifact.absolutePath}`,
  ].join("\n")
}

type FlowV2CliResult = Extract<SessionFlowResult, { readonly contract: "probe.session-flow/report-v2" }>
type FlowV2CliStepResult = FlowV2CliResult["executedSteps"][number]

const isFlowV2CliResult = (result: SessionFlowResult): result is FlowV2CliResult =>
  result.contract === "probe.session-flow/report-v2"

const formatFlowV2SequenceChildFailure = (step: FlowV2CliStepResult): string => {
  if (step.kind !== "sequence") {
    return "n/a"
  }

  if (step.sequenceChildFailure === null) {
    return "none"
  }

  return `#${step.sequenceChildFailure.index} ${step.sequenceChildFailure.kind} — ${step.sequenceChildFailure.summary}`
}

const formatFlowV2StepResult = (step: FlowV2CliStepResult): string => {
  const lines = [
    `- [${step.index}] ${step.kind} [${step.verdict}] ${step.summary}`,
    `  execution profile: ${step.executionProfile}`,
    `  transport lane: ${step.transportLane}`,
    `  checkpoint: ${step.checkpoint ?? "n/a"}`,
    `  latest snapshot: ${step.latestSnapshotId ?? "n/a"}`,
    `  retries: ${step.retryCount}`,
    `  handled ms: ${step.handledMs ?? "n/a"}`,
  ]

  if (step.kind === "sequence") {
    lines.push(`  failure child: ${formatFlowV2SequenceChildFailure(step)}`)
  }

  return lines.join("\n")
}

const formatFlowV2Result = (result: FlowV2CliResult): string => {
  const stepLines = result.executedSteps.length === 0
    ? ["- none"]
    : result.executedSteps.flatMap((step) => [formatFlowV2StepResult(step)])

  return [
    result.summary,
    `verdict: ${result.verdict}`,
    `executed steps: ${result.executedSteps.length}`,
    `failed step: ${result.failedStep?.index ?? "n/a"}`,
    `retries: ${result.retries}`,
    `final snapshot: ${result.finalSnapshotId ?? "n/a"}`,
    `artifacts: ${result.artifacts.length}`,
    `warnings: ${result.warnings.length}`,
    "",
    "steps:",
    ...stepLines,
  ].join("\n")
}

const formatFlowResult = (result: SessionFlowResult): string => {
  if (isFlowV2CliResult(result)) {
    return formatFlowV2Result(result)
  }

  return [
    result.summary,
    `verdict: ${result.verdict}`,
    `executed steps: ${result.executedSteps.length}`,
    `failed step: ${result.failedStep?.index ?? "n/a"}`,
    `retries: ${result.retries}`,
    `final snapshot: ${result.finalSnapshotId ?? "n/a"}`,
    `artifacts: ${result.artifacts.length}`,
    `warnings: ${result.warnings.length}`,
  ].join("\n")
}

const formatSummaryArtifactResult = (result: SummaryArtifactResult): string => {
  return [
    result.summary,
    `artifact: ${result.artifact.absolutePath}`,
  ].join("\n")
}

const formatSessionResultReport = (result: SessionResultSummaryResult | SessionResultAttachmentsResult): string => {
  return [
    result.summary,
    `artifact: ${result.artifact.absolutePath}`,
  ].join("\n")
}

const formatScreenshotResult = (result: SessionScreenshotResult): string => {
  return [
    result.summary,
    `artifact: ${result.artifact.absolutePath}`,
    `retries: ${result.retryCount}`,
    `retry reasons: ${result.retryReasons.length > 0 ? result.retryReasons.join(" | ") : "none"}`,
  ].join("\n")
}

const formatLogDoctorReport = (report: SessionLogDoctorReport): string => {
  const sourceLines = report.sources.map((source) => [
    `- ${source.source}: ${source.available ? "available" : "unavailable"}`,
    `  reason: ${source.reason}`,
    `  artifact: ${source.artifactPath ?? "n/a"}`,
  ].join("\n"))

  return [
    report.summary,
    `session id: ${report.sessionId}`,
    `target platform: ${report.targetPlatform}`,
    "",
    "sources:",
    ...sourceLines,
  ].join("\n")
}

const runSessionResultCommand = (args: {
  readonly sessionId: string
  readonly view: "summary" | "attachments"
  readonly asJson: boolean
}) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient
    const result = yield* (args.view === "summary"
      ? client.getSessionResultSummary({
          sessionId: args.sessionId,
          onEvent: eventPrinter(!args.asJson),
        })
      : client.getSessionResultAttachments({
          sessionId: args.sessionId,
          onEvent: eventPrinter(!args.asJson),
        }))

    yield* Effect.sync(() => {
      if (args.asJson) {
        process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`)
        return
      }

      console.log(formatSessionResultReport(result))
    })
  })

const parseOutputMode = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const mode = yield* optionalOption(args, "--output")

    if (!mode) {
      return "auto" satisfies OutputMode
    }

    if (mode === "auto" || mode === "inline" || mode === "artifact") {
      return mode satisfies OutputMode
    }

    return yield* invalidOption(
      "--output",
      `invalid value ${mode}; expected auto, inline, or artifact.`,
      "Provide --output auto|inline|artifact and retry the command.",
    )
  })

const parsePositiveIntegerOption = (args: ReadonlyArray<string>, flag: string, fallback: number) =>
  Effect.gen(function* () {
    const value = yield* optionalOption(args, flag)

    if (!value) {
      return fallback
    }

    const parsed = Number(value)

    if (!Number.isInteger(parsed) || parsed <= 0) {
      return yield* invalidOption(
        flag,
        `invalid value ${value}; expected a positive integer.`,
        `Provide ${flag} <positive-integer> and retry the command.`,
      )
    }

    return parsed
  })

const parseLogSource = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const source = yield* optionalOption(args, "--source")

    if (!source) {
      return "runner" satisfies SessionLogSource
    }

    if (
      source === "runner"
      || source === "build"
      || source === "wrapper"
      || source === "stdout"
      || source === "simulator"
    ) {
      return source satisfies SessionLogSource
    }

    return yield* invalidOption(
      "--source",
      `invalid value ${source}; expected runner, build, wrapper, stdout, or simulator.`,
      "Provide --source runner|build|wrapper|stdout|simulator and retry the command.",
    )
  })

const readJsonFile = <T>(path: string, label: string, decode: (value: unknown) => T) =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (error) =>
        new UserInputError({
          code: "session-json-file-read",
          reason: `Could not read ${label} file ${path}: ${error instanceof Error ? error.message : String(error)}.`,
          nextStep: `Verify the ${label} file path and retry the command.`,
          details: [],
        }),
    })

    return yield* Effect.try({
      try: () => decode(JSON.parse(raw) as unknown),
      catch: (error) =>
        new UserInputError({
          code: "session-json-file-parse",
          reason: `Could not parse ${label} file ${path}: ${error instanceof Error ? error.message : String(error)}.`,
          nextStep: `Validate the ${label} JSON shape and retry the command.`,
          details: [],
        }),
    })
  })

const decodeInlineJson = <T>(raw: string, label: string, decode: (value: unknown) => T) =>
  Effect.try({
    try: () => decode(JSON.parse(raw) as unknown),
    catch: (error) =>
      new UserInputError({
        code: "session-json-inline-parse",
        reason: `Could not parse inline ${label} JSON: ${error instanceof Error ? error.message : String(error)}.`,
        nextStep: `Validate the inline ${label} JSON shape and retry the command.`,
        details: [],
      }),
  })

const defaultReadStdinText = () =>
  Effect.tryPromise({
    try: async () => {
      const chunks: Array<string> = []

      for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"))
      }

      return chunks.join("")
    },
    catch: (error) =>
      new UserInputError({
        code: "session-stdin-read",
        reason: `Could not read flow JSON from stdin: ${error instanceof Error ? error.message : String(error)}.`,
        nextStep: "Pipe valid flow JSON to stdin and retry the command.",
        details: [],
      }),
  })

const parseActionInvocation = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const filePath = yield* optionalOption(args, "--file")
    const explicitInlineJson = yield* optionalOption(args, "--input-json")
    let inlineJson = explicitInlineJson
    let outputAsJson = args.includes("--output-json")

    for (let index = 0; index < args.length; index += 1) {
      if (args[index] !== "--json") {
        continue
      }

      const next = args[index + 1]

      if (typeof next === "string" && !next.startsWith("--")) {
        inlineJson = next
        index += 1
        continue
      }

      outputAsJson = true
    }

    if ((filePath === null && inlineJson === null) || (filePath !== null && inlineJson !== null)) {
      return yield* invalidOption(
        filePath !== null ? "--json" : "--file",
        "provide exactly one of --file <path> or --json/--input-json <payload>.",
        "Pass either --file <action.json> or --json <action-json> and retry the command.",
      )
    }

    const action = filePath !== null
      ? yield* readJsonFile(filePath, "action", decodeSessionAction)
      : yield* decodeInlineJson(inlineJson!, "action", decodeSessionAction)

    return {
      action,
      outputAsJson,
    }
  })

const parseFlowInvocation = (
  args: ReadonlyArray<string>,
  deps?: SessionCommandDependencies,
) =>
  Effect.gen(function* () {
    const filePath = yield* optionalOption(args, "--file")
    const useStdin = args.includes("--stdin")

    if ((filePath === null && !useStdin) || (filePath !== null && useStdin)) {
      return yield* invalidOption(
        filePath !== null ? "--stdin" : "--file",
        "provide exactly one of --file <path> or --stdin.",
        "Pass either --file <flow.json> or --stdin and retry the command.",
      )
    }

    const flow = filePath !== null
      ? yield* readJsonFile<SessionFlowContract>(filePath, "flow", decodeSessionFlowContract)
      : yield* (deps?.readStdinText ?? defaultReadStdinText)().pipe(
          Effect.flatMap((raw) => decodeInlineJson(raw, "flow", decodeSessionFlowContract)),
        )

    return {
      flow,
      outputAsJson: args.includes("--json"),
    }
  })

const parseSessionOpenTarget = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const explicitTarget = yield* optionalOption(args, "--target")
    const simulatorUdid = yield* optionalOption(args, "--simulator-udid")
    const deviceId = yield* optionalOption(args, "--device-id")

    if (explicitTarget !== null && explicitTarget !== "simulator" && explicitTarget !== "device") {
      return yield* invalidOption(
        "--target",
        `invalid value ${explicitTarget}; expected simulator or device.`,
        "Provide --target simulator|device and retry the command.",
      )
    }

    const target = explicitTarget ?? (deviceId ? "device" : "simulator")

    if (target === "device" && simulatorUdid) {
      return yield* invalidOption(
        "--simulator-udid",
        "cannot be combined with --target device.",
        "Drop --simulator-udid when opening a real-device session.",
      )
    }

    if (target === "simulator" && deviceId) {
      return yield* invalidOption(
        "--device-id",
        "cannot be combined with --target simulator.",
        "Drop --device-id when opening a simulator session, or pass --target device.",
      )
    }

    return {
      target,
      simulatorUdid: target === "simulator" ? simulatorUdid : null,
      deviceId: target === "device" ? deviceId : null,
    } as const
  })

export const runSessionCommand = (args: ReadonlyArray<string>, deps?: SessionCommandDependencies) =>
  Effect.gen(function* () {
    const [subcommand, ...rest] = args
    const asJson = rest.includes("--json")

    switch (subcommand) {
      case "list": {
        const client = yield* DaemonClient
        const sessions = yield* client.listSessions({
          onEvent: eventPrinter(!asJson),
        })

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(sessions, null, 2) : formatSessionList(sessions))
        })
        return
      }

      case "open": {
        const bundleId = (yield* optionalOption(rest, "--bundle-id")) ?? defaultTestBundleId
        const openTarget = yield* parseSessionOpenTarget(rest)
        const sessionMode = openTarget.target === "simulator"
          ? inferSimulatorSessionMode(bundleId)
          : null
        const client = yield* DaemonClient
        const health = yield* client.openSession({
          target: openTarget.target,
          bundleId,
          sessionMode,
          simulatorUdid: openTarget.simulatorUdid,
          deviceId: openTarget.deviceId,
          onEvent: eventPrinter(!asJson),
        })

        yield* printSessionHealth(health, asJson)
        return
      }

      case "show": {
        const sessionId = yield* requireOption(rest, "--session-id")
        const client = yield* DaemonClient
        const health = yield* client.showSession({
          sessionId,
          onEvent: eventPrinter(!asJson),
        })

        yield* printSessionHealth(health, asJson)
        return
      }

      case "health": {
        const sessionId = yield* requireOption(rest, "--session-id")
        const client = yield* DaemonClient
        const health = yield* client.getSessionHealth({
          sessionId,
          onEvent: eventPrinter(!asJson),
        })

        yield* printSessionHealth(health, asJson)
        return
      }

      case "logs": {
        const [logsSubcommand, ...logsRest] = rest

        switch (logsSubcommand) {
          case "mark": {
            const sessionId = yield* requireOption(logsRest, "--session-id")
            const label = yield* requireOption(logsRest, "--label")
            const client = yield* DaemonClient
            const result = yield* client.markSessionLog({
              sessionId,
              label,
              onEvent: eventPrinter(!asJson),
            })

            yield* Effect.sync(() => {
              console.log(asJson ? JSON.stringify(result, null, 2) : formatSummaryArtifactResult(result))
            })
            return
          }

          case "capture": {
            const sessionId = yield* requireOption(logsRest, "--session-id")
            const captureSeconds = yield* parsePositiveIntegerOption(logsRest, "--seconds", 2)
            const client = yield* DaemonClient
            const result = yield* client.captureLogWindow({
              sessionId,
              captureSeconds,
              onEvent: eventPrinter(!asJson),
            })

            yield* Effect.sync(() => {
              console.log(asJson ? JSON.stringify(result, null, 2) : formatSummaryArtifactResult(result))
            })
            return
          }

          case "doctor": {
            const sessionId = yield* requireOption(logsRest, "--session-id")
            const client = yield* DaemonClient
            const result = yield* client.getLogDoctorReport({
              sessionId,
              onEvent: eventPrinter(!asJson),
            })

            yield* Effect.sync(() => {
              console.log(asJson ? JSON.stringify(result, null, 2) : formatLogDoctorReport(result))
            })
            return
          }

          default: {
            if (typeof logsSubcommand === "string" && !logsSubcommand.startsWith("--")) {
              return yield* unknownSubcommand("session logs", logsSubcommand)
            }

            const sessionId = yield* requireOption(rest, "--session-id")
            const source = yield* parseLogSource(rest)
            const lineCount = yield* parsePositiveIntegerOption(rest, "--lines", 80)
            const captureSeconds = yield* parsePositiveIntegerOption(rest, "--seconds", 2)
            const match = yield* optionalOption(rest, "--match")
            const predicate = yield* optionalOption(rest, "--predicate")
            const process = yield* optionalOption(rest, "--process")
            const subsystem = yield* optionalOption(rest, "--subsystem")
            const category = yield* optionalOption(rest, "--category")
            const outputMode = yield* parseOutputMode(rest)
            const client = yield* DaemonClient
            const result = yield* client.getSessionLogs({
              sessionId,
              source,
              lineCount,
              match,
              outputMode,
              captureSeconds,
              predicate,
              process,
              subsystem,
              category,
              onEvent: eventPrinter(!asJson),
            })

            yield* Effect.sync(() => {
              if (asJson) {
                console.log(JSON.stringify(result, null, 2))
                return
              }

              console.log(result.result.summary)
              console.log(`source: ${result.sourceArtifact.absolutePath}`)

              if (result.result.kind === "inline") {
                if (result.result.content.length > 0) {
                  console.log("")
                  console.log(result.result.content)
                }
                return
              }

              console.log(`artifact: ${result.result.artifact.absolutePath}`)
            })
            return
          }
        }
      }

      case "snapshot": {
        const sessionId = yield* requireOption(rest, "--session-id")
        const outputMode = yield* parseOutputMode(rest)
        const client = yield* DaemonClient
        const result = yield* client.captureSnapshot({
          sessionId,
          outputMode,
          onEvent: eventPrinter(!asJson),
        })

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(result, null, 2) : formatSnapshot(result))
        })
        return
      }

      case "run": {
        const sessionId = yield* requireOption(rest, "--session-id")
        const parsed = yield* parseFlowInvocation(rest, deps)
        const client = yield* DaemonClient
        const result = yield* client.runSessionFlow({
          sessionId,
          flow: parsed.flow,
          onEvent: eventPrinter(!parsed.outputAsJson),
        })

        yield* Effect.sync(() => {
          console.log(parsed.outputAsJson ? JSON.stringify(result, null, 2) : formatFlowResult(result))
        })
        return
      }

      case "action": {
        const sessionId = yield* requireOption(rest, "--session-id")
        const parsed = yield* parseActionInvocation(rest)
        const client = yield* DaemonClient
        const result = yield* client.performSessionAction({
          sessionId,
          action: parsed.action,
          onEvent: eventPrinter(!parsed.outputAsJson),
        })

        yield* Effect.sync(() => {
          console.log(parsed.outputAsJson ? JSON.stringify(result, null, 2) : formatActionResult(result))
        })
        return
      }

      case "recording": {
        const [recordingSubcommand, ...recordingRest] = rest
        const recordingAsJson = recordingRest.includes("--json")

        switch (recordingSubcommand) {
          case "export": {
            const sessionId = yield* requireOption(recordingRest, "--session-id")
            const label = yield* optionalOption(recordingRest, "--label")
            const client = yield* DaemonClient
            const result = yield* client.exportSessionRecording({
              sessionId,
              label,
              onEvent: eventPrinter(!recordingAsJson),
            })

            yield* Effect.sync(() => {
              console.log(recordingAsJson ? JSON.stringify(result, null, 2) : formatRecordingExport(result))
            })
            return
          }

          default:
            return yield* unknownSubcommand("session recording", recordingSubcommand)
        }
      }

      case "replay": {
        const sessionId = yield* requireOption(rest, "--session-id")
        const filePath = yield* requireOption(rest, "--file")
        const script = yield* readJsonFile<ActionRecordingScript>(filePath, "replay script", decodeActionRecordingScript)
        const client = yield* DaemonClient
        const result = yield* client.replaySessionRecording({
          sessionId,
          script,
          onEvent: eventPrinter(!asJson),
        })

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(result, null, 2) : formatReplayResult(result))
        })
        return
      }

      case "result": {
        const [resultSubcommand, ...resultRest] = rest

        switch (resultSubcommand) {
          case "summary": {
            const sessionId = yield* requireOption(resultRest, "--session-id")
            yield* runSessionResultCommand({
              sessionId,
              view: "summary",
              asJson,
            })
            return
          }

          case "attachments": {
            const sessionId = yield* requireOption(resultRest, "--session-id")
            yield* runSessionResultCommand({
              sessionId,
              view: "attachments",
              asJson,
            })
            return
          }

          default:
            return yield* unknownSubcommand("session result", resultSubcommand)
        }
      }

      case "screenshot": {
        const sessionId = yield* requireOption(rest, "--session-id")
        const label = yield* optionalOption(rest, "--label")
        const outputMode = yield* parseOutputMode(rest)
        const client = yield* DaemonClient
        const result = yield* client.captureScreenshot({
          sessionId,
          label,
          outputMode,
          onEvent: eventPrinter(!asJson),
        })

        yield* Effect.sync(() => {
          if (asJson) {
            console.log(JSON.stringify(result, null, 2))
            return
          }

          console.log(formatScreenshotResult(result))
        })
        return
      }

      case "video": {
        const sessionId = yield* requireOption(rest, "--session-id")
        const duration = yield* requireOption(rest, "--duration")
        const client = yield* DaemonClient
        const result = yield* client.recordVideo({
          sessionId,
          duration,
          onEvent: eventPrinter(!asJson),
        })

        yield* Effect.sync(() => {
          if (asJson) {
            console.log(JSON.stringify(result, null, 2))
            return
          }

          console.log(result.summary)
          console.log(result.artifact.absolutePath)
        })
        return
      }

      case "close": {
        const sessionId = yield* requireOption(rest, "--session-id")
        const client = yield* DaemonClient
        const result = yield* client.closeSession({
          sessionId,
          onEvent: eventPrinter(!asJson),
        })

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(result, null, 2) : `closed session ${result.sessionId} at ${result.closedAt}`)
        })
        return
      }

      default:
        return yield* unknownSubcommand("session", subcommand)
    }
  })
