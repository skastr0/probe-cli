import { Effect, Schema } from "effect"
import {
  decodeActionRecordingScript,
  decodeSessionAction,
  type SessionAction,
  type SessionActionResult,
  type SessionRecordingExportResult,
  type SessionReplayResult,
} from "../../domain/action"
import { defaultAgentMutationEvidencePolicy } from "../../domain/evidence"
import { recordingScriptToFlowV2, RecordingToFlowError } from "../../domain/recordingToFlow"
import { UserInputError } from "../../domain/errors"
import {
  decodeSessionFlowContract,
  type BoundedFlowV2Result,
  type FlowV2StepResult,
} from "../../domain/flow-v2"
import { OutputMode, SessionLogSource } from "../../domain/output"
import type {
  OutputMode as OutputModeType,
  SessionResultAttachmentsResult,
  SessionLogDoctorReport,
  SessionLogSource as SessionLogSourceType,
  SessionResultSummaryResult,
  SessionScreenshotResult,
  SummaryArtifactResult,
} from "../../domain/output"
import {
  isLiveRunnerDetails,
  isLiveRunnerTransport,
  SimulatorSessionMode as SimulatorSessionModeSchema,
  type SimulatorSessionMode,
  type BoundedSessionHealth,
  type BoundedSessionList,
  type SessionListEntry,
} from "../../domain/session"
import type { SessionSnapshotResult } from "../../domain/snapshot"
import { DaemonClient } from "../../services/DaemonClient"
import {
  failLegacyJsonInput,
  hasLegacyJsonInput,
  hasMachineJsonOutput,
  readOptionalJsonInput,
} from "../json"
import { invalidOption, optionalOption, requireOption, unknownSubcommand } from "../options"

const defaultTestBundleId = "dev.probe.fixture"
const NullableString = Schema.Union(Schema.String, Schema.Null)

const SessionOpenPayload = Schema.Struct({
  target: Schema.optional(Schema.Literal("simulator", "device")),
  bundleId: Schema.optional(Schema.String),
  sessionMode: Schema.optional(Schema.Union(SimulatorSessionModeSchema, Schema.Null)),
  simulatorUdid: Schema.optional(NullableString),
  deviceId: Schema.optional(NullableString),
  signingTeamId: Schema.optional(NullableString),
})

const SessionLogsPayload = Schema.Struct({
  sessionId: Schema.String,
  source: Schema.optional(SessionLogSource),
  lineCount: Schema.optional(Schema.Number),
  match: Schema.optional(NullableString),
  outputMode: Schema.optional(OutputMode),
  captureSeconds: Schema.optional(Schema.Number),
  predicate: Schema.optional(NullableString),
  process: Schema.optional(NullableString),
  subsystem: Schema.optional(NullableString),
  category: Schema.optional(NullableString),
})

const SessionLogsMarkPayload = Schema.Struct({
  sessionId: Schema.String,
  label: Schema.String,
})

const SessionLogsCapturePayload = Schema.Struct({
  sessionId: Schema.String,
  captureSeconds: Schema.optional(Schema.Number),
})

const SessionScopedPayload = Schema.Struct({
  sessionId: Schema.String,
})

const SessionActionPayload = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  action: Schema.optional(Schema.Unknown),
  // Agent fly path: one RPC-shaped batch of runner-backed mutations without
  // writing a full flow document. Converted to a fast v2 sequence on the host.
  actions: Schema.optional(Schema.Array(Schema.Unknown)),
})

const SessionRunPayload = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  flow: Schema.Unknown,
})

const SessionReplayPayload = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  script: Schema.Unknown,
})

const decodeSessionOpenPayload = Schema.decodeUnknownSync(SessionOpenPayload)
const decodeSessionLogsPayload = Schema.decodeUnknownSync(SessionLogsPayload)
const decodeSessionLogsMarkPayload = Schema.decodeUnknownSync(SessionLogsMarkPayload)
const decodeSessionLogsCapturePayload = Schema.decodeUnknownSync(SessionLogsCapturePayload)
const decodeSessionScopedPayload = Schema.decodeUnknownSync(SessionScopedPayload)
const decodeSessionActionPayloadEnvelope = Schema.decodeUnknownSync(SessionActionPayload)
const decodeSessionRunPayloadEnvelope = Schema.decodeUnknownSync(SessionRunPayload)
const decodeSessionReplayPayloadEnvelope = Schema.decodeUnknownSync(SessionReplayPayload)

export interface SessionCommandDependencies {
  readonly readStdinText?: () => Effect.Effect<string, UserInputError>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const decodeSessionActionPayload = (value: unknown) => {
  if (isRecord(value) && ("action" in value || "actions" in value)) {
    const payload = decodeSessionActionPayloadEnvelope(value)
    if (payload.actions !== undefined && payload.actions.length > 0) {
      if (payload.action !== undefined) {
        throw new Error("Provide either action or actions, not both.")
      }
      return {
        sessionId: payload.sessionId ?? null,
        action: null as ReturnType<typeof decodeSessionAction> | null,
        actions: payload.actions.map((entry) => decodeSessionAction(entry)),
      }
    }
    if (payload.action === undefined) {
      throw new Error("session action payload requires action or a non-empty actions array.")
    }
    return {
      sessionId: payload.sessionId ?? null,
      action: decodeSessionAction(payload.action),
      actions: null as ReturnType<typeof decodeSessionAction>[] | null,
    }
  }

  return {
    sessionId: null,
    action: decodeSessionAction(value),
    actions: null as ReturnType<typeof decodeSessionAction>[] | null,
  }
}

const decodeSessionRunPayload = (value: unknown) => {
  if (isRecord(value) && "flow" in value) {
    const payload = decodeSessionRunPayloadEnvelope(value)
    return {
      sessionId: payload.sessionId ?? null,
      flow: decodeSessionFlowContract(payload.flow),
    }
  }

  return {
    sessionId: null,
    flow: decodeSessionFlowContract(value),
  }
}

const decodeSessionReplayPayload = (value: unknown) => {
  if (isRecord(value) && "script" in value) {
    const payload = decodeSessionReplayPayloadEnvelope(value)
    return {
      sessionId: payload.sessionId ?? null,
      script: decodeActionRecordingScript(payload.script),
    }
  }

  return {
    sessionId: null,
    script: decodeActionRecordingScript(value),
  }
}

const inferSimulatorSessionMode = (bundleId: string): SimulatorSessionMode =>
  bundleId === defaultTestBundleId ? "build-and-install" : "attach-to-running"

const formatSessionListTarget = (target: SessionListEntry["target"]): string => {
  const runtimeSuffix = target.runtime ? ` @ ${target.runtime}` : ""
  return `${target.deviceName} (${target.deviceId}) [${target.platform}${runtimeSuffix}]`
}

// PRB-094 AC3 review fix: `sessions` is now a bounded collection (see
// domain/bounded.ts) -- `.shown` is the inline preview, `.omitted`/`.drill`
// surface how to reach the rest instead of the CLI ever iterating an
// unbounded array, same "N of total, M omitted -- drill <key>" idiom as
// `session health`'s artifacts/warnings formatter above.
const formatSessionList = (sessions: BoundedSessionList): string => {
  if (sessions.total === 0) {
    return "no active sessions"
  }

  const header = `sessions (${sessions.shown.length} of ${sessions.total}${
    sessions.omitted > 0
      ? `, ${sessions.omitted} omitted -- drill ${sessions.drill?.artifactKey}`
      : ""
  }):`

  return [
    header,
    "",
    sessions.shown.map((session) => [
      `session id: ${session.id}`,
      `state: ${session.state}`,
      `bundle id: ${session.bundleId}`,
      `target: ${formatSessionListTarget(session.target)}`,
      `opened at: ${session.openedAt}`,
    ].join("\n")).join("\n\n"),
  ].join("\n")
}

const printSessionHealth = (health: BoundedSessionHealth, asJson: boolean) =>
  Effect.sync(() => {
    console.log(asJson ? JSON.stringify(health, null, 2) : formatSessionHealth(health))
  })

const formatSessionHealth = (health: BoundedSessionHealth): string => {
  const capabilityLines = health.capabilities.map(
    (capability) => `- ${capability.area} [${capability.status}] ${capability.summary}`,
  )
  // PRB-094: `artifacts`/`warnings` are now bounded collections (see
  // domain/bounded.ts) -- `.shown` is the inline preview, `.omitted`/`.drill`
  // surface how to reach the rest instead of the CLI ever iterating an
  // unbounded array.
  const artifactLines = health.artifacts.shown.map((artifact) => `- ${artifact.key}: ${artifact.absolutePath}`)

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
    `warnings (${health.warnings.shown.length} of ${health.warnings.total}${health.warnings.omitted > 0 ? `, ${health.warnings.omitted} omitted -- drill ${health.warnings.drill?.artifactKey}` : ""}):`,
    ...health.warnings.shown.map((warning) => `- ${warning}`),
    "",
    `artifacts (${health.artifacts.shown.length} of ${health.artifacts.total}${health.artifacts.omitted > 0 ? `, ${health.artifacts.omitted} omitted -- drill ${health.artifacts.drill?.artifactKey}` : ""}):`,
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
  const agentLines = result.agentView.interactive.map(
    (item) =>
      `- ${item.ref} ${item.type}${item.identifier ? ` id=${item.identifier}` : ""}${item.label ? ` "${item.label}"` : ""}`,
  )
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
    `status: ${result.statusLabel ?? "n/a"}`,
    `artifact: ${result.artifact.absolutePath}`,
    `retries: ${result.retryCount}`,
    `retry reasons: ${result.retryReasons.length > 0 ? result.retryReasons.join(" | ") : "none"}`,
    `nodes: ${result.metrics.nodeCount}`,
    `interactive nodes: ${result.metrics.interactiveNodeCount}`,
    `weak identity nodes: ${result.metrics.weakIdentityNodeCount}`,
    `diff: ${result.diff.kind}`,
    `diff counts: +${result.diff.summary.added} / -${result.diff.summary.removed} / ~${result.diff.summary.updated} / remapped ${result.diff.summary.remapped}`,
    `agentView interactive: ${result.agentView.interactive.length}/${result.agentView.interactiveTotal}`
      + (result.agentView.omittedInteractiveCount > 0
        ? ` (omitted ${result.agentView.omittedInteractiveCount})`
        : ""),
    "",
    "agent interactive:",
    ...(agentLines.length > 0 ? agentLines : ["- none"]),
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
  const delta = result.uiDelta ?? null
  const deltaLines = delta === null
    ? ["uiDelta: none (sparse path or no post snapshot — snapshot when lost)"]
    : [
        `uiDelta: ${delta.kind} +${delta.summary.added}/-${delta.summary.removed}/~${delta.summary.updated} remapped ${delta.summary.remapped}`,
        `uiDelta interactive: ${delta.interactive.length}/${delta.interactiveTotal}`,
        ...delta.highlightLines.slice(0, 5).map((line) => `- ${line}`),
      ]

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
    ...deltaLines,
  ].join("\n")
}

const formatRecordingExport = (result: SessionRecordingExportResult): string => {
  return [
    result.summary,
    `steps: ${result.stepCount}`,
    `artifact: ${result.artifact.absolutePath}`,
  ].join("\n")
}

/** CLI agent fly default: mutations omit → sparse evidence (not domain end). */
const applyAgentSparseEvidenceDefault = (action: SessionAction): SessionAction => {
  if (
    action.kind !== "tap"
    && action.kind !== "multiTap"
    && action.kind !== "press"
    && action.kind !== "swipe"
    && action.kind !== "type"
    && action.kind !== "scroll"
  ) {
    return action
  }

  if (action.evidencePolicy !== undefined) {
    return action
  }

  return {
    ...action,
    evidencePolicy: defaultAgentMutationEvidencePolicy,
  }
}

const formatReplayResult = (result: SessionReplayResult): string => {
  return [
    result.summary,
    `steps: ${result.stepCount}`,
    `retried steps: ${result.retriedStepCount}`,
    `semantic fallback recoveries: ${result.semanticFallbackCount}`,
    `final snapshot: ${result.finalSnapshotId ?? "n/a"}`,
    // PRB-093 review finding: mirrors formatFlowV2StepResult's evidence
    // line below -- an aggregate across every replayed step rather than
    // requiring the caller to open the replay report artifact.
    `evidence: policy success=${result.evidence.requested.success} failure=${result.evidence.requested.failure}, ${result.evidence.captures.length} capture(s), ${result.evidence.evidenceMs}ms`,
    `artifact: ${result.artifact.absolutePath}`,
  ].join("\n")
}

type FlowV2CliResult = Extract<BoundedFlowV2Result, { readonly contract: "probe.session-flow/report-v2" }>
// PRB-094: named directly from flow-v2's own step-result type rather than
// indexed through `executedSteps["shown"][number]` -- same type, shallower
// indirection for readers and static analysis alike.
type FlowV2CliStepResult = FlowV2StepResult

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
    `  evidence: policy success=${step.evidence.requested.success} failure=${step.evidence.requested.failure}, ${step.evidence.captures.length} capture(s), ${step.evidence.evidenceMs}ms`,
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
  const stepLines = result.executedSteps.shown.length === 0
    ? ["- none"]
    : result.executedSteps.shown.flatMap((step) => [formatFlowV2StepResult(step)])
  const executedStepsOmittedNote = result.executedSteps.omitted > 0
    ? `, ${result.executedSteps.omitted} omitted -- drill ${result.executedSteps.drill?.artifactKey}`
    : ""

  return [
    result.summary,
    `verdict: ${result.verdict}`,
    `executed steps: ${result.executedSteps.shown.length} of ${result.executedSteps.total}${executedStepsOmittedNote}`,
    `failed step: ${result.failedStep?.index ?? "n/a"}`,
    `retries: ${result.retries}`,
    `final snapshot: ${result.finalSnapshotId ?? "n/a"}`,
    `artifacts: ${result.artifacts.total}`,
    `warnings: ${result.warnings.total}`,
    "",
    "steps:",
    ...stepLines,
  ].join("\n")
}

// BoundedFlowV2Result has a single canonical shape (probe.session-flow/report-v2)
// since PRB-082 removed the v1 result contract, so this always formats as v2.
const formatFlowResult = (result: BoundedFlowV2Result): string => formatFlowV2Result(result)

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
      return "auto" satisfies OutputModeType
    }

    if (mode === "auto" || mode === "inline" || mode === "artifact") {
      return mode satisfies OutputModeType
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
      return "runner" satisfies SessionLogSourceType
    }

    if (
      source === "runner"
      || source === "build"
      || source === "wrapper"
      || source === "stdout"
      || source === "simulator"
    ) {
      return source satisfies SessionLogSourceType
    }

    return yield* invalidOption(
      "--source",
      `invalid value ${source}; expected runner, build, wrapper, stdout, or simulator.`,
      "Provide --source runner|build|wrapper|stdout|simulator and retry the command.",
    )
  })

const parseActionInvocation = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (hasLegacyJsonInput(args)) {
      return yield* failLegacyJsonInput("probe session action")
    }

    const payload = yield* readOptionalJsonInput(args, "session action payload", decodeSessionActionPayload)

    if (payload === null) {
      return yield* invalidOption(
        "--input-json",
        "missing action payload.",
        "Pass --input-json <payload>, --file <action.json>, or --stdin and retry the command.",
      )
    }

    return {
      sessionId: payload.sessionId,
      action: payload.action,
      actions: payload.actions,
      outputAsJson: hasMachineJsonOutput(args),
    }
  })

const parseFlowInvocation = (
  args: ReadonlyArray<string>,
  deps?: SessionCommandDependencies,
) =>
  Effect.gen(function* () {
    const payload = yield* readOptionalJsonInput(args, "session run payload", decodeSessionRunPayload, deps)

    if (payload === null) {
      return yield* invalidOption(
        "--input-json",
        "missing flow payload.",
        "Pass --input-json <payload>, --file <flow.json>, or --stdin and retry the command.",
      )
    }

    return {
      sessionId: payload.sessionId,
      flow: payload.flow,
      outputAsJson: hasMachineJsonOutput(args),
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
    const asJson = hasMachineJsonOutput(rest)

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
        const payload = yield* readOptionalJsonInput(rest, "session open payload", decodeSessionOpenPayload, undefined, {
          allowFile: false,
          allowStdin: false,
        })
        const bundleId = payload?.bundleId ?? (yield* optionalOption(rest, "--bundle-id")) ?? defaultTestBundleId
        const openTarget = yield* parseSessionOpenTarget([
          ...(payload?.target ? ["--target", payload.target] : []),
          ...(payload?.simulatorUdid ? ["--simulator-udid", payload.simulatorUdid] : []),
          ...(payload?.deviceId ? ["--device-id", payload.deviceId] : []),
          ...rest,
        ])
        const sessionMode = openTarget.target === "simulator"
          ? payload?.sessionMode ?? inferSimulatorSessionMode(bundleId)
          : null
        const signingTeamId = payload?.signingTeamId ?? (yield* optionalOption(rest, "--team-id"))
        const client = yield* DaemonClient
        const health = yield* client.openSession({
          target: openTarget.target,
          bundleId,
          sessionMode,
          simulatorUdid: openTarget.simulatorUdid,
          deviceId: openTarget.deviceId,
          signingTeamId,
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
            const payload = yield* readOptionalJsonInput(logsRest, "session logs mark payload", decodeSessionLogsMarkPayload, undefined, {
              allowFile: false,
              allowStdin: false,
            })
            const sessionId = payload?.sessionId ?? (yield* requireOption(logsRest, "--session-id"))
            const label = payload?.label ?? (yield* requireOption(logsRest, "--label"))
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
            const payload = yield* readOptionalJsonInput(logsRest, "session logs capture payload", decodeSessionLogsCapturePayload, undefined, {
              allowFile: false,
              allowStdin: false,
            })
            const sessionId = payload?.sessionId ?? (yield* requireOption(logsRest, "--session-id"))
            const captureSeconds = payload?.captureSeconds ?? (yield* parsePositiveIntegerOption(logsRest, "--seconds", 2))
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
            const payload = yield* readOptionalJsonInput(logsRest, "session logs doctor payload", decodeSessionScopedPayload, undefined, {
              allowFile: false,
              allowStdin: false,
            })
            const sessionId = payload?.sessionId ?? (yield* requireOption(logsRest, "--session-id"))
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

            const payload = yield* readOptionalJsonInput(rest, "session logs payload", decodeSessionLogsPayload, undefined, {
              allowFile: false,
              allowStdin: false,
            })
            const sessionId = payload?.sessionId ?? (yield* requireOption(rest, "--session-id"))
            const source = payload?.source ?? (yield* parseLogSource(rest))
            const lineCount = payload?.lineCount ?? (yield* parsePositiveIntegerOption(rest, "--lines", 80))
            const captureSeconds = payload?.captureSeconds ?? (yield* parsePositiveIntegerOption(rest, "--seconds", 2))
            const match = payload?.match ?? (yield* optionalOption(rest, "--match"))
            const predicate = payload?.predicate ?? (yield* optionalOption(rest, "--predicate"))
            const process = payload?.process ?? (yield* optionalOption(rest, "--process"))
            const subsystem = payload?.subsystem ?? (yield* optionalOption(rest, "--subsystem"))
            const category = payload?.category ?? (yield* optionalOption(rest, "--category"))
            const outputMode = payload?.outputMode ?? (yield* parseOutputMode(rest))
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
        const parsed = yield* parseFlowInvocation(rest, deps)
        const sessionId = parsed.sessionId ?? (yield* requireOption(rest, "--session-id"))
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
        const parsed = yield* parseActionInvocation(rest)
        const sessionId = parsed.sessionId ?? (yield* requireOption(rest, "--session-id"))
        const client = yield* DaemonClient

        // Agent fly path: `actions: [...]` becomes one fast sequence flow so the
        // runner can batch mutations in a single uiActionBatch instead of N
        // host RPCs with optional host snapshots between each.
        if (parsed.actions !== null && parsed.actions.length > 0) {
          const sequenceActions = []
          for (const action of parsed.actions) {
            if (
              action.kind !== "tap"
              && action.kind !== "multiTap"
              && action.kind !== "press"
              && action.kind !== "swipe"
              && action.kind !== "type"
              && action.kind !== "scroll"
              && action.kind !== "wait"
            ) {
              return yield* new UserInputError({
                code: "session-action-batch-invalid",
                reason: `actions[] only supports runner-backed mutation kinds; received ${action.kind}.`,
                nextStep: "Use tap/multiTap/press/swipe/type/scroll/wait children, or call session run with a full flow.",
                details: [],
              })
            }
            sequenceActions.push(action)
          }

          // Build as plain JSON then let the flow decoder normalize/validate
          // sequence child shapes (SessionAction vs FlowSequenceAction differ
          // slightly on wait variants). Sparse evidence is the agent default
          // (defaultAgentMutationEvidencePolicy) — not domain omit→end.
          const flow = decodeSessionFlowContract({
            contract: "probe.session-flow/v2",
            steps: [
              {
                kind: "sequence",
                execution: "fast",
                evidencePolicy: defaultAgentMutationEvidencePolicy,
                actions: sequenceActions,
              },
            ],
          })
          const result = yield* client.runSessionFlow({
            sessionId,
            flow,
            onEvent: eventPrinter(!parsed.outputAsJson),
          })
          yield* Effect.sync(() => {
            console.log(parsed.outputAsJson ? JSON.stringify(result, null, 2) : formatFlowResult(result))
          })
          return
        }

        if (parsed.action === null) {
          return yield* new UserInputError({
            code: "session-action-missing",
            reason: "session action payload requires action or a non-empty actions array.",
            nextStep: "Pass { sessionId, action } or { sessionId, actions: [...] }.",
            details: [],
          })
        }

        // CLI agent fly path: when the caller omits evidencePolicy on a
        // mutation, inject the sparse agent default so each tap does not pay
        // a host AX post-snapshot. Explicit end/around still pass through.
        // Domain resolveEvidencePolicy and investigate/verified paths keep
        // omit→end (PRB-093).
        const action = applyAgentSparseEvidenceDefault(parsed.action)
        const result = yield* client.performSessionAction({
          sessionId,
          action,
          onEvent: eventPrinter(!parsed.outputAsJson),
        })

        yield* Effect.sync(() => {
          console.log(parsed.outputAsJson ? JSON.stringify(result, null, 2) : formatActionResult(result))
        })
        return
      }

      case "recording": {
        const [recordingSubcommand, ...recordingRest] = rest
        const recordingAsJson = hasMachineJsonOutput(recordingRest)

        switch (recordingSubcommand) {
          case "export": {
            const sessionId = yield* requireOption(recordingRest, "--session-id")
            const label = yield* optionalOption(recordingRest, "--label")
            const format = (yield* optionalOption(recordingRest, "--format")) ?? "script"
            if (format !== "script" && format !== "flow-v2") {
              return yield* new UserInputError({
                code: "session-recording-export-format-invalid",
                reason: `Unknown recording export format "${format}".`,
                nextStep: "Use --format script (default, probe.action-recording/script-v1) or --format flow-v2 (probe.session-flow/v2 for session run).",
                details: [],
              })
            }

            const client = yield* DaemonClient
            const result = yield* client.exportSessionRecording({
              sessionId,
              label,
              onEvent: eventPrinter(!recordingAsJson),
            })

            if (format === "script") {
              yield* Effect.sync(() => {
                console.log(recordingAsJson ? JSON.stringify(result, null, 2) : formatRecordingExport(result))
              })
              return
            }

            // flow-v2: convert the exported script-v1 artifact into a durable
            // session-flow contract agents can re-run via `session run --file`.
            const flowExport = yield* Effect.tryPromise({
              try: async () => {
                const { readFile, writeFile } = await import("node:fs/promises")
                const raw = JSON.parse(await readFile(result.artifact.absolutePath, "utf8")) as unknown
                const script = decodeActionRecordingScript(raw)
                const flow = recordingScriptToFlowV2(script)
                const siblingPath = result.artifact.absolutePath.replace(/\.json$/i, ".flow-v2.json")
                const outPath = siblingPath === result.artifact.absolutePath
                  ? `${result.artifact.absolutePath}.flow-v2.json`
                  : siblingPath
                await writeFile(outPath, `${JSON.stringify(flow, null, 2)}\n`, "utf8")
                return {
                  summary: `Exported ${result.stepCount} recorded actions as session-flow/v2 to ${outPath}.`,
                  scriptArtifact: result.artifact,
                  flowPath: outPath,
                  stepCount: result.stepCount,
                  flow,
                }
              },
              catch: (error) => {
                // Script artifact was already written by session.recording.export
                // before conversion — always name it so partial success is honest.
                const scriptPathDetail = `script artifact (already written): ${result.artifact.absolutePath}`
                if (error instanceof RecordingToFlowError) {
                  return new UserInputError({
                    code: "session-recording-flow-export-failed",
                    reason: error.reason,
                    nextStep: `${error.nextStep} The script-v1 artifact is already at ${result.artifact.absolutePath}; fix selectors and re-export, or use session replay on the script.`,
                    details: error.stepIndex === undefined
                      ? [scriptPathDetail]
                      : [scriptPathDetail, `stepIndex: ${error.stepIndex}`],
                  })
                }
                return new UserInputError({
                  code: "session-recording-flow-export-failed",
                  reason: error instanceof Error ? error.message : String(error),
                  nextStep: `Script-v1 is already at ${result.artifact.absolutePath}. Inspect it, fix selectors, then retry --format flow-v2 (or use session replay on the script).`,
                  details: [scriptPathDetail],
                })
              },
            })

            yield* Effect.sync(() => {
              console.log(recordingAsJson ? JSON.stringify(flowExport, null, 2) : [
                flowExport.summary,
                `steps: ${flowExport.stepCount}`,
                `script artifact: ${flowExport.scriptArtifact.absolutePath}`,
                `flow: ${flowExport.flowPath}`,
              ].join("\n"))
            })
            return
          }

          default:
            return yield* unknownSubcommand("session recording", recordingSubcommand)
        }
      }

      case "replay": {
        const payload = yield* readOptionalJsonInput(rest, "session replay payload", decodeSessionReplayPayload)
        const sessionId = payload?.sessionId ?? (yield* requireOption(rest, "--session-id"))
        const script = payload?.script ?? (yield* invalidOption(
          "--input-json",
          "missing replay script payload.",
          "Pass --input-json <payload>, --file <recording.json>, or --stdin and retry the command.",
        ))
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
            const payload = yield* readOptionalJsonInput(resultRest, "session result payload", decodeSessionScopedPayload, undefined, {
              allowFile: false,
              allowStdin: false,
            })
            const sessionId = payload?.sessionId ?? (yield* requireOption(resultRest, "--session-id"))
            yield* runSessionResultCommand({
              sessionId,
              view: "summary",
              asJson,
            })
            return
          }

          case "attachments": {
            const payload = yield* readOptionalJsonInput(resultRest, "session result payload", decodeSessionScopedPayload, undefined, {
              allowFile: false,
              allowStdin: false,
            })
            const sessionId = payload?.sessionId ?? (yield* requireOption(resultRest, "--session-id"))
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
