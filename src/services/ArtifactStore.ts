import { Context, Effect, Layer } from "effect"
import { access, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, extname, join, relative } from "node:path"
import net from "node:net"
import { ArtifactNotFoundError, EnvironmentError } from "../domain/errors"
import type { ArtifactKind, ArtifactRecord } from "../domain/output"

const PROBE_PROTOCOL_VERSION_DIRECTORY = "v1"
const daemonDirectoryName = "daemon"
const sessionsDirectoryName = "sessions"
const artifactIndexFileName = "artifact-index.json"
const sessionManifestFileName = "session-manifest.json"
const defaultArtifactRetentionMs = Number(
  process.env.PROBE_ARTIFACT_RETENTION_MS ?? 7 * 24 * 60 * 60 * 1000,
)

const nowIso = (): string => new Date().toISOString()

const timestampForFile = (): string =>
  nowIso().replace(/[:.]/g, "-")

const ensureDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true })
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const safeJsonParse = <T>(content: string, fallback: T): T => {
  try {
    return JSON.parse(content) as T
  } catch {
    return fallback
  }
}

const ensureParentDirectory = async (path: string): Promise<void> => {
  await ensureDirectory(dirname(path))
}

const createArtifactRecord = (
  probeRoot: string,
  key: string,
  label: string,
  kind: ArtifactKind,
  absolutePath: string,
  summary: string,
): ArtifactRecord => ({
  key,
  label,
  kind,
  summary,
  absolutePath,
  relativePath: absolutePath.startsWith(probeRoot) ? relative(probeRoot, absolutePath) : null,
  external: !absolutePath.startsWith(probeRoot),
  createdAt: nowIso(),
})

const socketReachable = async (socketPath: string): Promise<boolean> =>
  await new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath)

    socket.once("connect", () => {
      socket.end()
      resolve(true)
    })

    socket.once("error", () => {
      resolve(false)
    })
  })

export interface SessionLayout {
  readonly sessionId: string
  readonly root: string
  readonly metaDirectory: string
  readonly logsDirectory: string
  readonly logStreamsDirectory: string
  readonly logTailsDirectory: string
  readonly runnerDirectory: string
  readonly outputsDirectory: string
  readonly snapshotsDirectory: string
  readonly tracesDirectory: string
  readonly screenshotsDirectory: string
  readonly debugDirectory: string
  readonly manifestPath: string
  readonly artifactIndexPath: string
}

export interface DaemonSessionMetadata {
  readonly sessionId: string
  readonly state: string
  readonly bundleId: string
  readonly simulatorUdid: string | null
  readonly artifactRoot: string | null
  readonly updatedAt: string
}

export interface PersistedSessionRecord {
  readonly sessionId: string
  readonly state: string | null
  readonly openedAt: string | null
  readonly updatedAt: string | null
  readonly artifactRoot: string
  readonly manifestPath: string
  readonly bundleId: string | null
  readonly warnings: ReadonlyArray<string>
  readonly runner: {
    readonly wrapperProcessId: number | null
    readonly runtimeControlDirectory: string | null
    readonly observerControlDirectory: string | null
  }
  readonly transport: {
    readonly bootstrapPath: string | null
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const readOptionalString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key]
  return typeof value === "string" ? value : null
}

const readOptionalNumber = (record: Record<string, unknown>, key: string): number | null => {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

const readStringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []

const toPersistedSessionRecord = (
  sessionsRoot: string,
  sessionId: string,
  manifestPath: string,
  manifest: Record<string, unknown>,
): PersistedSessionRecord => {
  const runner = isRecord(manifest.runner) ? manifest.runner : {}
  const transport = isRecord(manifest.transport) ? manifest.transport : {}
  const target = isRecord(manifest.target) ? manifest.target : {}

  return {
    sessionId,
    state: readOptionalString(manifest, "state"),
    openedAt: readOptionalString(manifest, "openedAt"),
    updatedAt: readOptionalString(manifest, "updatedAt"),
    artifactRoot: readOptionalString(manifest, "artifactRoot") ?? join(sessionsRoot, sessionId),
    manifestPath,
    bundleId: readOptionalString(target, "bundleId") ?? readOptionalString(manifest, "bundleId"),
    warnings: readStringArray(manifest.warnings),
    runner: {
      wrapperProcessId: readOptionalNumber(runner, "wrapperProcessId"),
      runtimeControlDirectory: readOptionalString(runner, "runtimeControlDirectory"),
      observerControlDirectory: readOptionalString(runner, "observerControlDirectory"),
    },
    transport: {
      bootstrapPath: readOptionalString(transport, "bootstrapPath"),
    },
  }
}

export class ArtifactStore extends Context.Tag("@probe/ArtifactStore")<
  ArtifactStore,
  {
    readonly getRootDirectory: () => Effect.Effect<string>
    readonly getArtifactRetentionMs: () => number
    readonly getDaemonSocketPath: () => Effect.Effect<string>
    readonly getDaemonMetadataPath: () => Effect.Effect<string>
    readonly ensureDaemonDirectories: () => Effect.Effect<void, EnvironmentError>
    readonly isDaemonRunning: () => Effect.Effect<boolean>
    readonly readDaemonMetadata: () => Effect.Effect<Record<string, unknown> | null, EnvironmentError>
    readonly createSessionLayout: (sessionId: string) => Effect.Effect<SessionLayout, EnvironmentError>
    readonly removeSessionLayout: (sessionId: string) => Effect.Effect<void>
    readonly readSessionManifest: (sessionId: string) => Effect.Effect<Record<string, unknown> | null, EnvironmentError>
    readonly listPersistedSessions: () => Effect.Effect<ReadonlyArray<PersistedSessionRecord>, EnvironmentError>
    readonly writeSessionManifest: (
      sessionId: string,
      value: Record<string, unknown>,
    ) => Effect.Effect<void, EnvironmentError>
    readonly registerArtifact: (
      sessionId: string,
      record: ArtifactRecord,
    ) => Effect.Effect<ArtifactRecord, EnvironmentError>
    readonly listArtifacts: (sessionId: string) => Effect.Effect<ReadonlyArray<ArtifactRecord>, EnvironmentError>
    readonly getArtifact: (
      sessionId: string,
      artifactKey: string,
    ) => Effect.Effect<ArtifactRecord, EnvironmentError | ArtifactNotFoundError>
    readonly writeDerivedOutput: (args: {
      readonly sessionId: string
      readonly label: string
      readonly format: "json" | "text"
      readonly content: string
      readonly summary: string
    }) => Effect.Effect<ArtifactRecord, EnvironmentError>
    readonly removeDaemonMetadata: () => Effect.Effect<void>
    readonly writeDaemonMetadata: (
      value: Record<string, unknown>,
    ) => Effect.Effect<void, EnvironmentError>
    readonly syncDaemonSessionMetadata: (
      sessions: ReadonlyArray<DaemonSessionMetadata>,
    ) => Effect.Effect<void>
    readonly pruneExpiredSessions: () => Effect.Effect<void>
  }
>() {}

export const ArtifactStoreLive = Layer.effect(
  ArtifactStore,
  Effect.gen(function* () {
    const probeRoot = join(homedir(), ".probe")
    const sessionsRoot = join(probeRoot, sessionsDirectoryName)
    const daemonRoot = join(probeRoot, daemonDirectoryName, PROBE_PROTOCOL_VERSION_DIRECTORY)
    const daemonSocketPath = join(daemonRoot, "probe.sock")
    const daemonMetadataPath = join(daemonRoot, "daemon.json")

    const ensureProbeRoots = Effect.tryPromise({
      try: async () => {
        await ensureDirectory(sessionsRoot)
        await ensureDirectory(daemonRoot)
      },
      catch: (error) =>
        new EnvironmentError({
          code: "artifact-root-init",
          reason: error instanceof Error ? error.message : String(error),
          nextStep: "Check filesystem permissions for ~/.probe and retry.",
          details: [],
        }),
    })

    const readArtifactIndex = (sessionId: string) =>
      Effect.tryPromise({
        try: async (): Promise<Array<ArtifactRecord>> => {
          const indexPath = join(sessionsRoot, sessionId, "meta", artifactIndexFileName)

          if (!(await fileExists(indexPath))) {
            return []
          }

          const content = await readFile(indexPath, "utf8")
          return safeJsonParse<Array<ArtifactRecord>>(content, [])
        },
        catch: (error) =>
          new EnvironmentError({
            code: "artifact-index-read",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Inspect the session artifact root for manual edits or corruption.",
            details: [],
          }),
      })

    const writeArtifactIndex = (sessionId: string, records: ReadonlyArray<ArtifactRecord>) =>
      Effect.tryPromise({
        try: async () => {
          const indexPath = join(sessionsRoot, sessionId, "meta", artifactIndexFileName)
          await ensureParentDirectory(indexPath)
          await writeFile(indexPath, `${JSON.stringify(records, null, 2)}\n`, "utf8")
        },
        catch: (error) =>
          new EnvironmentError({
            code: "artifact-index-write",
            reason: error instanceof Error ? error.message : String(error),
            nextStep: "Check write access to the session artifact root and retry.",
            details: [],
          }),
      })

    const readDaemonMetadataUnsafe = async (): Promise<Record<string, unknown> | null> => {
      if (!(await fileExists(daemonMetadataPath))) {
        return null
      }

      const content = await readFile(daemonMetadataPath, "utf8")
      return safeJsonParse<Record<string, unknown> | null>(content, null)
    }

    const readSessionManifestUnsafe = async (sessionId: string): Promise<Record<string, unknown> | null> => {
      const manifestPath = join(sessionsRoot, sessionId, "meta", sessionManifestFileName)

      if (!(await fileExists(manifestPath))) {
        return null
      }

      const content = await readFile(manifestPath, "utf8")
      return safeJsonParse<Record<string, unknown> | null>(content, null)
    }

    const pruneExpiredSessions = Effect.tryPromise({
      try: async () => {
        await ensureProbeRoots.pipe(Effect.runPromise)
        const entries = await readdir(sessionsRoot, { withFileTypes: true })
        const cutoff = Date.now() - defaultArtifactRetentionMs

        await Promise.all(
          entries
            .filter((entry) => entry.isDirectory())
            .map(async (entry) => {
              const path = join(sessionsRoot, entry.name)
              const info = await stat(path)

              if (info.mtimeMs < cutoff) {
                await rm(path, { recursive: true, force: true })
              }
            }),
        )
      },
      catch: (error) =>
        new EnvironmentError({
          code: "session-prune",
          reason: error instanceof Error ? error.message : String(error),
          nextStep: "Inspect the session artifact root and retry pruning expired sessions.",
          details: [],
        }),
    }).pipe(Effect.catchAll(() => Effect.void), Effect.asVoid)

    yield* ensureProbeRoots
    yield* pruneExpiredSessions

    return ArtifactStore.of({
      getRootDirectory: () => Effect.succeed(sessionsRoot),
      getArtifactRetentionMs: () => defaultArtifactRetentionMs,
      getDaemonSocketPath: () => Effect.succeed(daemonSocketPath),
      getDaemonMetadataPath: () => Effect.succeed(daemonMetadataPath),
      ensureDaemonDirectories: () => ensureProbeRoots,
      isDaemonRunning: () =>
        Effect.tryPromise({
          try: async () => socketReachable(daemonSocketPath),
          catch: (error) =>
            new EnvironmentError({
              code: "daemon-running-check",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect the daemon socket path and retry the check.",
              details: [],
            }),
        }).pipe(Effect.catchAll(() => Effect.succeed(false))),
      readDaemonMetadata: () =>
        Effect.tryPromise({
          try: readDaemonMetadataUnsafe,
          catch: (error) =>
            new EnvironmentError({
              code: "daemon-metadata-read",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect the daemon metadata file and retry the diagnostics request.",
              details: [],
            }),
        }),
      createSessionLayout: (sessionId) =>
        Effect.tryPromise({
          try: async () => {
            await ensureProbeRoots.pipe(Effect.runPromise)

            const root = join(sessionsRoot, sessionId)
            const metaDirectory = join(root, "meta")
            const logsDirectory = join(root, "logs")
            const logStreamsDirectory = join(logsDirectory, "streams")
            const logTailsDirectory = join(logsDirectory, "tails")
            const runnerDirectory = join(root, "runner")
            const outputsDirectory = join(root, "outputs")
            const snapshotsDirectory = join(root, "snapshots")
            const tracesDirectory = join(root, "traces")
            const screenshotsDirectory = join(root, "screenshots")
            const debugDirectory = join(root, "debug")

            await Promise.all([
              metaDirectory,
              logsDirectory,
              logStreamsDirectory,
              logTailsDirectory,
              runnerDirectory,
              outputsDirectory,
              snapshotsDirectory,
              tracesDirectory,
              screenshotsDirectory,
              debugDirectory,
            ].map(ensureDirectory))

            const manifestPath = join(metaDirectory, sessionManifestFileName)
            const artifactIndexPath = join(metaDirectory, artifactIndexFileName)

            if (!(await fileExists(artifactIndexPath))) {
              await writeFile(artifactIndexPath, "[]\n", "utf8")
            }

            return {
              sessionId,
              root,
              metaDirectory,
              logsDirectory,
              logStreamsDirectory,
              logTailsDirectory,
              runnerDirectory,
              outputsDirectory,
              snapshotsDirectory,
              tracesDirectory,
              screenshotsDirectory,
              debugDirectory,
              manifestPath,
              artifactIndexPath,
            }
          },
          catch: (error) =>
            new EnvironmentError({
              code: "session-layout-create",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Check write access to ~/.probe/sessions and retry opening the session.",
              details: [],
            }),
        }),
      removeSessionLayout: (sessionId) =>
        Effect.tryPromise({
          try: async () => {
            await rm(join(sessionsRoot, sessionId), { recursive: true, force: true })
          },
          catch: (error) =>
            new EnvironmentError({
              code: "session-layout-remove",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect the session artifact root and retry removing the failed session layout.",
              details: [],
            }),
        }).pipe(Effect.catchAll(() => Effect.void), Effect.asVoid),
      readSessionManifest: (sessionId) =>
        Effect.tryPromise({
          try: () => readSessionManifestUnsafe(sessionId),
          catch: (error) =>
            new EnvironmentError({
              code: "session-manifest-read",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect the session manifest and retry the diagnostics request.",
              details: [],
            }),
        }),
      listPersistedSessions: () =>
        Effect.tryPromise({
          try: async () => {
            await ensureProbeRoots.pipe(Effect.runPromise)
            const entries = await readdir(sessionsRoot, { withFileTypes: true })

            const manifests = await Promise.all(
              entries
                .filter((entry) => entry.isDirectory())
                .map(async (entry) => {
                  const sessionId = entry.name
                  const manifestPath = join(sessionsRoot, sessionId, "meta", sessionManifestFileName)
                  const manifest = await readSessionManifestUnsafe(sessionId)

                  if (!manifest) {
                    return null
                  }

                  return toPersistedSessionRecord(sessionsRoot, sessionId, manifestPath, manifest)
                }),
            )

            return manifests
              .filter((entry): entry is PersistedSessionRecord => entry !== null)
              .sort((left, right) => Date.parse(right.updatedAt ?? "") - Date.parse(left.updatedAt ?? ""))
          },
          catch: (error) =>
            new EnvironmentError({
              code: "persisted-session-list",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect the Probe session artifact root and retry the diagnostics request.",
              details: [],
            }),
        }),
      writeSessionManifest: (sessionId, value) =>
        Effect.tryPromise({
          try: async () => {
            const manifestPath = join(sessionsRoot, sessionId, "meta", sessionManifestFileName)
            await ensureParentDirectory(manifestPath)
            await writeFile(manifestPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
          },
          catch: (error) =>
            new EnvironmentError({
              code: "session-manifest-write",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Check filesystem permissions for the session artifact root and retry.",
              details: [],
            }),
        }),
      registerArtifact: (sessionId, record) =>
        Effect.gen(function* () {
          const existing = yield* readArtifactIndex(sessionId)
          const next = [...existing.filter((entry) => entry.key !== record.key), record]
          yield* writeArtifactIndex(sessionId, next)
          return record
        }),
      listArtifacts: (sessionId) => readArtifactIndex(sessionId),
      getArtifact: (sessionId, artifactKey) =>
        Effect.gen(function* () {
          const artifacts = yield* readArtifactIndex(sessionId)
          const artifact = artifacts.find((entry) => entry.key === artifactKey)

          if (!artifact) {
            return yield* new ArtifactNotFoundError({
              sessionId,
              artifactKey,
              nextStep: "List session artifacts first, then drill using one of the returned artifact keys.",
            })
          }

          return artifact
        }),
      writeDerivedOutput: ({ sessionId, label, format, content, summary }) =>
        Effect.tryPromise({
          try: async () => {
            const extension = format === "json" ? ".json" : ".txt"
            const root = join(sessionsRoot, sessionId)
            const outputsDirectory = join(root, "outputs")
            await ensureDirectory(outputsDirectory)

            const fileName = `${timestampForFile()}-${label}${extension}`
            const absolutePath = join(outputsDirectory, fileName)
            await writeFile(absolutePath, content, "utf8")

            const record = createArtifactRecord(
              probeRoot,
              `derived-${fileName}`,
              label,
              format,
              absolutePath,
              summary,
            )

            const existing = await Effect.runPromise(readArtifactIndex(sessionId))
            await Effect.runPromise(writeArtifactIndex(sessionId, [...existing, record]))
            return record
          },
          catch: (error) =>
            new EnvironmentError({
              code: "derived-output-write",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Check write access to the session outputs directory and retry.",
              details: [],
            }),
        }),
      removeDaemonMetadata: () =>
        Effect.tryPromise({
          try: async () => {
            await unlink(daemonMetadataPath).catch(() => undefined)
          },
          catch: (error) =>
            new EnvironmentError({
              code: "daemon-metadata-remove",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect the daemon metadata path and retry removing it.",
              details: [],
            }),
        }).pipe(Effect.catchAll(() => Effect.void), Effect.asVoid),
      writeDaemonMetadata: (value) =>
        Effect.tryPromise({
          try: async () => {
            await ensureProbeRoots.pipe(Effect.runPromise)
            await writeFile(daemonMetadataPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
          },
          catch: (error) =>
            new EnvironmentError({
              code: "daemon-metadata-write",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Check write access to the daemon metadata directory and retry.",
              details: [],
            }),
        }),
      syncDaemonSessionMetadata: (sessions) =>
        Effect.tryPromise({
          try: async () => {
            if (!(await fileExists(daemonMetadataPath))) {
              return
            }

            const current = safeJsonParse<Record<string, unknown>>(
              await readFile(daemonMetadataPath, "utf8"),
              {},
            )

            await writeFile(
              daemonMetadataPath,
              `${JSON.stringify(
                {
                  ...current,
                  activeSessions: sessions.length,
                  sessions,
                  updatedAt: nowIso(),
                },
                null,
                2,
              )}\n`,
              "utf8",
            )
          },
          catch: (error) =>
            new EnvironmentError({
              code: "daemon-session-metadata-sync",
              reason: error instanceof Error ? error.message : String(error),
              nextStep: "Inspect daemon.json and retry the session lifecycle operation.",
              details: [],
            }),
        }).pipe(Effect.catchAll(() => Effect.void), Effect.asVoid),
      pruneExpiredSessions: () => pruneExpiredSessions,
    })
  }),
)
