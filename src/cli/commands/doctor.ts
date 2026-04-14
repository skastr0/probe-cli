import { Effect } from "effect"
import type { AccessibilityDoctorReport } from "../../domain/accessibility"
import type { CommerceDoctorReport, CommerceProvider, CommerceValidationMode } from "../../domain/commerce"
import type {
  DiagnosticCaptureKind,
  DiagnosticCaptureTarget,
  DiagnosticReport,
  KnownWall,
} from "../../domain/diagnostics"
import type { SummaryArtifactResult } from "../../domain/output"
import type { WorkspaceStatus } from "../../domain/workspace"
import { AccessibilityService } from "../../services/AccessibilityService"
import { CommerceService } from "../../services/CommerceService"
import { DaemonClient } from "../../services/DaemonClient"
import { ProbeKernel } from "../../services/ProbeKernel"
import { invalidOption, optionalOption, requireOption, unknownSubcommand } from "../options"

const formatDiagnostic = (diagnostic: DiagnosticReport): Array<string> => [
  `- ${diagnostic.key} [${diagnostic.status}] ${diagnostic.summary}`,
  ...diagnostic.details.map((detail) => `  - ${detail}`),
]

const formatKnownWall = (wall: KnownWall): Array<string> => [
  `- ${wall.key}: ${wall.summary}`,
  ...wall.details.map((detail) => `  - ${detail}`),
]

const formatWorkspaceStatus = (status: WorkspaceStatus): string => {
  const capabilityLines = status.capabilities.map(
    (capability) => `- ${capability.area} [${capability.status}] ${capability.summary}`,
  )
  const diagnosticLines = status.diagnostics.flatMap(formatDiagnostic)
  const wallLines = status.knownWalls.flatMap(formatKnownWall)

  return [
    "Probe control plane",
    `workspace root: ${status.workspaceRoot}`,
    `artifact root: ${status.artifactRoot}`,
    `inline threshold: ${status.outputThreshold.maxInlineBytes} bytes / ${status.outputThreshold.maxInlineLines} lines`,
    `daemon running: ${status.daemon.running}`,
    `daemon socket: ${status.daemon.socketPath}`,
    `daemon metadata: ${status.daemon.metadataPath}`,
    `protocol version: ${status.daemon.protocolVersion}`,
    `session ttl: ${status.daemon.sessionTtlMs} ms`,
    `artifact retention: ${status.daemon.artifactRetentionMs} ms`,
    "",
    "commands:",
    ...status.commands.map((command) => `- ${command}`),
    "",
    "capabilities:",
    ...capabilityLines,
    "",
    "diagnostics:",
    ...diagnosticLines,
    "",
    "known walls:",
    ...wallLines,
    "",
    "notes:",
    ...status.notes.map((note) => `- ${note}`),
  ].join("\n")
}

const parseCommerceMode = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const mode = yield* optionalOption(args, "--mode")

    if (mode === null) {
      return null
    }

    if (mode === "local-storekit" || mode === "sandbox" || mode === "testflight") {
      return mode satisfies CommerceValidationMode
    }

    return yield* invalidOption(
      "--mode",
      `invalid value ${mode}; expected local-storekit, sandbox, or testflight.`,
      "Provide --mode local-storekit|sandbox|testflight and retry the command.",
    )
  })

const parseCommerceProvider = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const provider = yield* optionalOption(args, "--provider")

    if (provider === null) {
      return null
    }

    if (provider === "revenuecat") {
      return provider satisfies CommerceProvider
    }

    return yield* invalidOption(
      "--provider",
      `invalid value ${provider}; expected revenuecat.`,
      "Provide --provider revenuecat and retry the command.",
    )
  })

const formatCommerceDoctorReport = (report: CommerceDoctorReport): string => [
  report.summary,
  `verdict: ${report.verdict}`,
  `bundle id: ${report.bundleId}`,
  `mode: ${report.mode ?? "n/a"}`,
  `provider: ${report.provider ?? "n/a"}`,
  "",
  "checks:",
  ...report.checks.flatMap((check) => [
    `- ${check.key} [${check.verdict}${check.stub ? "/stub" : ""}] (${check.boundary}, ${check.verification}) ${check.summary}`,
    ...check.details.map((detail) => `  - ${detail}`),
  ]),
  ...(report.timingFacts.length > 0 ? ["", "timing facts:", ...report.timingFacts.map((fact) => `- ${fact}`)] : []),
  ...(report.warnings.length > 0 ? ["", "warnings:", ...report.warnings.map((warning) => `- ${warning}`)] : []),
].join("\n")

const formatAccessibilityDoctorReport = (report: AccessibilityDoctorReport): string => [
  report.summary,
  `verdict: ${report.verdict}`,
  `session id: ${report.sessionId}`,
  `snapshot artifact: ${report.snapshotArtifact?.absolutePath ?? "n/a"}`,
  `screenshot artifact: ${report.screenshotArtifact?.absolutePath ?? "n/a"}`,
  "",
  "checks:",
  ...report.checks.flatMap((check) => [
    `- ${check.key} [${check.verdict}] ${check.summary}`,
    ...check.details.map((detail) => `  - ${detail}`),
  ]),
  ...(report.warnings.length > 0 ? ["", "warnings:", ...report.warnings.map((warning) => `- ${warning}`)] : []),
].join("\n")

const formatSummaryArtifactResult = (result: SummaryArtifactResult): string => [
  result.summary,
  `artifact: ${result.artifact.absolutePath}`,
].join("\n")

const parseDiagnosticCaptureTarget = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const target = yield* requireOption(args, "--target")

    if (target === "simulator" || target === "device") {
      return target satisfies DiagnosticCaptureTarget
    }

    return yield* invalidOption(
      "--target",
      `invalid value ${target}; expected simulator or device.`,
      "Provide --target simulator|device and retry the command.",
    )
  })

const parseDiagnosticCaptureKind = (args: ReadonlyArray<string>, target: DiagnosticCaptureTarget) =>
  Effect.gen(function* () {
    const kind = yield* optionalOption(args, "--kind")

    if (kind === null) {
      return null
    }

    if (target !== "device") {
      return yield* invalidOption(
        "--kind",
        "--kind is only supported for device diagnostic capture.",
        "Omit --kind for simulator capture, or retry with --target device.",
      )
    }

    if (kind === "sysdiagnose") {
      return kind satisfies DiagnosticCaptureKind
    }

    return yield* invalidOption(
      "--kind",
      `invalid value ${kind}; expected sysdiagnose.`,
      "Provide --kind sysdiagnose and retry the command.",
    )
  })

export const runDoctorCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [subcommand, ...rest] = args

    if (subcommand === undefined || subcommand.startsWith("--")) {
      const kernel = yield* ProbeKernel
      const status = yield* kernel.getWorkspaceStatus()
      const asJson = args.includes("--json")

      yield* Effect.sync(() => {
        const output = asJson ? JSON.stringify(status, null, 2) : formatWorkspaceStatus(status)
        console.log(output)
      })
      return
    }

    switch (subcommand) {
      case "accessibility": {
        const sessionId = yield* requireOption(rest, "--session-id")
        const asJson = rest.includes("--json")
        const accessibility = yield* AccessibilityService
        const report = yield* accessibility.doctor({ sessionId })

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(report, null, 2) : formatAccessibilityDoctorReport(report))
        })
        return
      }

      case "commerce": {
        const bundleId = yield* requireOption(rest, "--bundle-id")
        const mode = yield* parseCommerceMode(rest)
        const provider = yield* parseCommerceProvider(rest)
        const storekitConfigPath = yield* optionalOption(rest, "--config")
        const asJson = rest.includes("--json")
        const commerce = yield* CommerceService
        const report = yield* commerce.doctor({
          bundleId,
          mode,
          provider,
          storekitConfigPath,
        })

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(report, null, 2) : formatCommerceDoctorReport(report))
        })
        return
      }

      case "capture": {
        const target = yield* parseDiagnosticCaptureTarget(rest)
        const sessionId = yield* requireOption(rest, "--session-id")
        const kind = yield* parseDiagnosticCaptureKind(rest, target)
        const asJson = rest.includes("--json")
        const client = yield* DaemonClient
        const result = yield* client.captureDiagnosticBundle({
          sessionId,
          target,
          kind,
          onEvent: asJson
            ? undefined
            : (stage, message) => {
                console.error(`[${stage}] ${message}`)
              },
        })

        yield* Effect.sync(() => {
          console.log(asJson ? JSON.stringify(result, null, 2) : formatSummaryArtifactResult(result))
        })
        return
      }

      default:
        return yield* unknownSubcommand("doctor", subcommand)
    }
  })
