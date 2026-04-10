import { Effect } from "effect"
import type { DiagnosticReport, KnownWall } from "../../domain/diagnostics"
import type { WorkspaceStatus } from "../../domain/workspace"
import { ProbeKernel } from "../../services/ProbeKernel"

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

export const runDoctorCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const kernel = yield* ProbeKernel
    const status = yield* kernel.getWorkspaceStatus()
    const asJson = args.includes("--json")

    yield* Effect.sync(() => {
      const output = asJson ? JSON.stringify(status, null, 2) : formatWorkspaceStatus(status)
      console.log(output)
    })
  })
