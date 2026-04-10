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
import type { OutputMode, SessionLogSource } from "../../domain/output"
import {
  isLiveRunnerDetails,
  isLiveRunnerTransport,
  type SessionHealth,
} from "../../domain/session"
import type { SessionSnapshotResult } from "../../domain/snapshot"
import { DaemonClient } from "../../services/DaemonClient"
import { invalidOption, optionalOption, requireOption, unknownSubcommand } from "../options"

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
    `status label: ${result.statusLabel ?? "n/a"}`,
    `latest snapshot: ${result.latestSnapshotId ?? "n/a"}`,
    `recorded steps: ${result.recordingLength}`,
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

export const runSessionCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [subcommand, ...rest] = args
    const asJson = rest.includes("--json")

    switch (subcommand) {
      case "open": {
        const bundleId = (yield* optionalOption(rest, "--bundle-id")) ?? "dev.probe.fixture"
        const openTarget = yield* parseSessionOpenTarget(rest)
        const client = yield* DaemonClient
        const health = yield* client.openSession({
          target: openTarget.target,
          bundleId,
          simulatorUdid: openTarget.simulatorUdid,
          deviceId: openTarget.deviceId,
          onEvent: eventPrinter(!asJson),
        })

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(health, null, 2) : formatSessionHealth(health))
        })
        return
      }

      case "health": {
        const sessionId = yield* requireOption(rest, "--session-id")
        const client = yield* DaemonClient
        const health = yield* client.getSessionHealth({
          sessionId,
          onEvent: eventPrinter(!asJson),
        })

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(health, null, 2) : formatSessionHealth(health))
        })
        return
      }

      case "logs": {
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

      case "action": {
        const sessionId = yield* requireOption(rest, "--session-id")
        const filePath = yield* requireOption(rest, "--file")
        const action = yield* readJsonFile(filePath, "action", decodeSessionAction)
        const client = yield* DaemonClient
        const result = yield* client.performSessionAction({
          sessionId,
          action,
          onEvent: eventPrinter(!asJson),
        })

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(result, null, 2) : formatActionResult(result))
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
