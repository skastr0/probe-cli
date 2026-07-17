import { Context, Effect, Either, Layer, Schema } from "effect"
import { access, copyFile, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, extname, join, relative } from "node:path"
import net from "node:net"
import { ArtifactNotFoundError, EnvironmentError } from "../domain/errors"
import { ArtifactRecord } from "../domain/output"
import type { ArtifactKind } from "../domain/output"

const decodeArtifactIndex = Schema.decodeUnknownSync(Schema.Array(ArtifactRecord))
const decodeArtifactRecordSync = Schema.decodeUnknownSync(ArtifactRecord)

const PROBE_PROTOCOL_VERSION_DIRECTORY = "v1"
const daemonDirectoryName = "daemon"
const sessionsDirectoryName = "sessions"
const artifactIndexFileName = "artifact-index.json"
const sessionManifestFileName = "session-manifest.json"
const catalogTempSuffix = ".tmp"
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

const ensureParentDirectory = async (path: string): Promise<void> => {
  await ensureDirectory(dirname(path))
}

// A catalog file (session manifest, artifact index, daemon metadata) is either
// legitimately absent (never written yet - not corruption), holds a decodable
// value, or exists but failed to decode (corruption). Callers must not collapse
// "corrupt" into "absent" - that is exactly the silent-empty-fallback this type
// exists to prevent.
type CatalogReadOutcome<T> =
  | { readonly kind: "absent" }
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "corrupt"; readonly detail: string }

const readCatalogFile = async <T>(path: string): Promise<CatalogReadOutcome<T>> => {
  let content: string

  try {
    content = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" }
    }

    return { kind: "corrupt", detail: error instanceof Error ? error.message : String(error) }
  }

  try {
    return { kind: "value", value: JSON.parse(content) as T }
  } catch (error) {
    return { kind: "corrupt", detail: error instanceof Error ? error.message : String(error) }
  }
}

// The single atomic-write primitive shared by the session manifest, the
// artifact index, and daemon metadata: write to a deterministically-named
// sibling temp file, fsync it, then rename it over the target. POSIX rename
// within the same directory is atomic, so a concurrent reader always sees
// either the fully-old or fully-new content, never a partial write, and a
// crash between the temp write and the rename leaves only an orphaned temp
// file behind - never a truncated catalog.
const atomicWriteFile = async (targetPath: string, content: string): Promise<void> => {
  await ensureParentDirectory(targetPath)
  const tempPath = `${targetPath}${catalogTempSuffix}`
  const handle = await open(tempPath, "w")

  try {
    await handle.writeFile(content, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }

  await rename(tempPath, targetPath)

  // rename() makes the new name visible to concurrent readers atomically, but
  // on most POSIX filesystems the directory-entry change itself is not
  // guaranteed durable across a hard crash (power loss) until the containing
  // directory's own fd is fsynced too - otherwise an unclean remount can
  // resurrect the pre-rename directory entry even though every reader during
  // normal operation already saw the new content.
  const directoryHandle = await open(dirname(targetPath), "r")
  try {
    await directoryHandle.sync()
  } finally {
    await directoryHandle.close()
  }
}

// Removes the deterministic temp sibling for a catalog path, if any. Safe to
// call unconditionally: a leftover temp file only ever means a previous write
// crashed between the temp write and the atomic rename, so the real catalog
// file (if any) already holds the last successfully committed state.
const sweepOrphanCatalogTempFile = async (targetPath: string): Promise<void> => {
  await unlink(`${targetPath}${catalogTempSuffix}`).catch(() => undefined)
}

const createArtifactRecord = (
  probeRoot: string,
  key: string,
  label: string,
  kind: ArtifactKind,
  absolutePath: string,
  summary: string,
  sizeBytes?: number,
): ArtifactRecord => ({
  key,
  label,
  kind,
  summary,
  absolutePath,
  relativePath: absolutePath.startsWith(probeRoot) ? relative(probeRoot, absolutePath) : null,
  ...(sizeBytes === undefined ? {} : { sizeBytes }),
  external: !absolutePath.startsWith(probeRoot),
  createdAt: nowIso(),
})

const readFileSize = async (absolutePath: string): Promise<number | undefined> => {
  try {
    const fileStat = await stat(absolutePath)
    return fileStat.isFile() ? fileStat.size : undefined
  } catch {
    return undefined
  }
}

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

// A session directory whose manifest failed to decode. Surfaced per-entry
// instead of failing listPersistedSessions() outright, so one corrupt session
// never poisons startup recovery or `probe sessions list`/`probe doctor` for
// every other (valid) session.
export interface PersistedSessionReadFailure {
  readonly sessionId: string
  readonly code: string
  readonly reason: string
}

export interface PersistedSessionListing {
  readonly sessions: ReadonlyArray<PersistedSessionRecord>
  readonly failures: ReadonlyArray<PersistedSessionReadFailure>
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
    readonly listPersistedSessions: () => Effect.Effect<PersistedSessionListing, EnvironmentError>
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
    readonly writeDerivedFile: (args: {
      readonly sessionId: string
      readonly label: string
      readonly kind: ArtifactKind
      readonly sourceAbsolutePath: string
      readonly sourceFileName: string
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
    const probeRoot = process.env.PROBE_ARTIFACT_ROOT ?? join(homedir(), ".probe")
    const sessionsRoot = join(probeRoot, sessionsDirectoryName)
    const daemonRoot = join(probeRoot, daemonDirectoryName, PROBE_PROTOCOL_VERSION_DIRECTORY)
    const daemonSocketPath = join(daemonRoot, "probe.sock")
    const daemonMetadataPath = join(daemonRoot, "daemon.json")

    // One in-process lock per catalog file path: the daemon owns exactly one
    // ArtifactStoreLive instance, so this map is the daemon-owned serialized
    // writer for every session catalog (manifest, artifact index) plus daemon
    // metadata. Readers stay lock-free (atomic rename already makes a read
    // race-free); only read-modify-write and overwrite critical sections take
    // the lock, keyed by the exact file they touch so unrelated sessions never
    // contend with each other.
    const catalogLocks = new Map<string, Effect.Semaphore>()

    const catalogLockFor = (path: string): Effect.Semaphore => {
      const existing = catalogLocks.get(path)

      if (existing) {
        return existing
      }

      const created = Effect.unsafeMakeSemaphore(1)
      catalogLocks.set(path, created)
      return created
    }

    const withCatalogLock = <A, E>(path: string, effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      catalogLockFor(path).withPermits(1)(effect)

    // Unlocked write primitive - callers that need read-modify-write take the
    // lock themselves around a read + this write so the whole cycle is one
    // critical section; callers that only ever overwrite (writeSessionManifest,
    // writeDaemonMetadata) go through writeCatalogFile below instead.
    const atomicWriteCatalogEffect = (path: string, content: string, code: string, nextStep: string) =>
      Effect.tryPromise({
        try: () => atomicWriteFile(path, content),
        catch: (error) =>
          new EnvironmentError({
            code,
            reason: error instanceof Error ? error.message : String(error),
            nextStep,
            details: [],
          }),
      })

    const writeCatalogFile = (path: string, content: string, code: string, nextStep: string) =>
      withCatalogLock(path, atomicWriteCatalogEffect(path, content, code, nextStep))

    const readArtifactIndexAt = (indexPath: string) =>
      Effect.tryPromise({
        try: async (): Promise<ReadonlyArray<ArtifactRecord>> => {
          const outcome = await readCatalogFile<unknown>(indexPath)

          if (outcome.kind === "absent") {
            return []
          }

          if (outcome.kind === "corrupt") {
            throw new EnvironmentError({
              code: "artifact-index-corrupt",
              reason: `${indexPath} exists but is not valid JSON: ${outcome.detail}`,
              nextStep: "Inspect the session artifact index for manual edits or corruption; repair or remove the file, then re-open the session.",
              details: [],
            })
          }

          try {
            // Full schema decode, not just an array-shape check: every entry
            // must actually satisfy ArtifactRecord, so a truncated or
            // hand-edited entry surfaces as corruption too.
            return decodeArtifactIndex(outcome.value)
          } catch (error) {
            throw new EnvironmentError({
              code: "artifact-index-corrupt",
              reason: `${indexPath} exists but did not decode as a valid artifact index: ${error instanceof Error ? error.message : String(error)}`,
              nextStep: "Inspect the session artifact index for manual edits or corruption; repair or remove the file, then re-open the session.",
              details: [],
            })
          }
        },
        catch: (error) =>
          error instanceof EnvironmentError
            ? error
            : new EnvironmentError({
                code: "artifact-index-read",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Inspect the session artifact root for manual edits or corruption.",
                details: [],
              }),
      })

    const mutateArtifactIndex = (
      sessionId: string,
      mutate: (existing: ReadonlyArray<ArtifactRecord>) => ReadonlyArray<ArtifactRecord>,
    ) => {
      const indexPath = join(sessionsRoot, sessionId, "meta", artifactIndexFileName)

      return withCatalogLock(
        indexPath,
        Effect.gen(function* () {
          const existing = yield* readArtifactIndexAt(indexPath)
          const next = mutate(existing)
          yield* atomicWriteCatalogEffect(
            indexPath,
            `${JSON.stringify(next, null, 2)}\n`,
            "artifact-index-write",
            "Check write access to the session artifact root and retry.",
          )
          return next
        }),
      )
    }

    const readObjectCatalogAt = (path: string, corruptCode: string, ioCode: string, nextStep: string) =>
      Effect.tryPromise({
        try: async (): Promise<Record<string, unknown> | null> => {
          const outcome = await readCatalogFile<unknown>(path)

          if (outcome.kind === "absent") {
            return null
          }

          if (outcome.kind === "value" && isRecord(outcome.value)) {
            return outcome.value
          }

          const detail = outcome.kind === "value" ? "decoded JSON is not an object" : outcome.detail
          throw new EnvironmentError({
            code: corruptCode,
            reason: `${path} exists but did not decode as a valid JSON object: ${detail}`,
            nextStep,
            details: [],
          })
        },
        catch: (error) =>
          error instanceof EnvironmentError
            ? error
            : new EnvironmentError({
                code: ioCode,
                reason: error instanceof Error ? error.message : String(error),
                nextStep,
                details: [],
              }),
      })

    const readDaemonMetadataStrict = () =>
      readObjectCatalogAt(
        daemonMetadataPath,
        "daemon-metadata-corrupt",
        "daemon-metadata-read",
        "Inspect the daemon metadata file; if it is corrupt, stop the daemon and remove or repair daemon.json before restarting.",
      )

    const readSessionManifestStrict = (sessionId: string) =>
      readObjectCatalogAt(
        join(sessionsRoot, sessionId, "meta", sessionManifestFileName),
        "session-manifest-corrupt",
        "session-manifest-read",
        "Inspect the session manifest for manual edits or corruption; remove the session directory and re-open the session if it cannot be repaired.",
      )

    const sweepOrphanCatalogTempFiles = Effect.tryPromise({
      try: async () => {
        await sweepOrphanCatalogTempFile(daemonMetadataPath)

        const entries = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])

        await Promise.all(
          entries
            .filter((entry) => entry.isDirectory())
            .flatMap((entry) => {
              const metaDirectory = join(sessionsRoot, entry.name, "meta")
              return [
                sweepOrphanCatalogTempFile(join(metaDirectory, sessionManifestFileName)),
                sweepOrphanCatalogTempFile(join(metaDirectory, artifactIndexFileName)),
              ]
            }),
        )
      },
      catch: (error) =>
        new EnvironmentError({
          code: "catalog-temp-sweep",
          reason: error instanceof Error ? error.message : String(error),
          nextStep: "Inspect ~/.probe for orphaned .tmp catalog files and remove them manually, then restart the daemon.",
          details: [],
        }),
    }).pipe(Effect.catchAll(() => Effect.void), Effect.asVoid)

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

    const pruneExpiredSessions = Effect.gen(function* () {
      yield* ensureProbeRoots
      yield* Effect.tryPromise({
        try: async () => {
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
      })
    }).pipe(Effect.catchAll(() => Effect.void), Effect.asVoid)

    yield* ensureProbeRoots
    yield* sweepOrphanCatalogTempFiles
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
      readDaemonMetadata: () => readDaemonMetadataStrict(),
      createSessionLayout: (sessionId) =>
        Effect.gen(function* () {
          yield* ensureProbeRoots

          return yield* Effect.tryPromise({
            try: async () => {
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
                await atomicWriteFile(artifactIndexPath, "[]\n")
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
          })
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
      readSessionManifest: (sessionId) => readSessionManifestStrict(sessionId),
      listPersistedSessions: () =>
        Effect.gen(function* () {
          yield* ensureProbeRoots
          const entries = yield* Effect.tryPromise({
            try: () => readdir(sessionsRoot, { withFileTypes: true }),
            catch: (error) =>
              new EnvironmentError({
                code: "persisted-session-list",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Inspect the Probe session artifact root and retry the diagnostics request.",
                details: [],
              }),
          })

          // A single corrupt session manifest must not fail the whole listing -
          // Effect.either captures it as a per-entry outcome instead of letting
          // Effect.forEach short-circuit the entire call, so one bad session
          // directory never poisons startup recovery or `probe sessions
          // list`/`probe doctor` for every other (valid) session.
          const outcomes = yield* Effect.forEach(
            entries.filter((entry) => entry.isDirectory()),
            (entry) =>
              Effect.gen(function* () {
                const sessionId = entry.name
                const manifestPath = join(sessionsRoot, sessionId, "meta", sessionManifestFileName)
                const manifest = yield* readSessionManifestStrict(sessionId)

                return manifest === null
                  ? null
                  : toPersistedSessionRecord(sessionsRoot, sessionId, manifestPath, manifest)
              }).pipe(
                Effect.either,
                Effect.map((result) => ({ sessionId: entry.name, result })),
              ),
          )

          const sessions: Array<PersistedSessionRecord> = []
          const failures: Array<PersistedSessionReadFailure> = []

          for (const outcome of outcomes) {
            if (Either.isLeft(outcome.result)) {
              failures.push({
                sessionId: outcome.sessionId,
                code: outcome.result.left.code,
                reason: outcome.result.left.reason,
              })
              continue
            }

            if (outcome.result.right !== null) {
              sessions.push(outcome.result.right)
            }
          }

          sessions.sort((left, right) => Date.parse(right.updatedAt ?? "") - Date.parse(left.updatedAt ?? ""))

          return { sessions, failures }
        }),
      writeSessionManifest: (sessionId, value) =>
        writeCatalogFile(
          join(sessionsRoot, sessionId, "meta", sessionManifestFileName),
          `${JSON.stringify(value, null, 2)}\n`,
          "session-manifest-write",
          "Check filesystem permissions for the session artifact root and retry.",
        ),
      registerArtifact: (sessionId, record) =>
        Effect.gen(function* () {
          // Validate metadata and existence before commit - a record that
          // fails to decode or whose absolutePath is not actually on disk
          // must never reach the atomic write. A bad write here would corrupt
          // the whole catalog for the session, since reads use a strict full
          // ArtifactRecord decode.
          const validatedRecord = yield* Effect.try({
            try: () => decodeArtifactRecordSync(record),
            catch: (error) =>
              new EnvironmentError({
                code: "artifact-registration-invalid",
                reason: `Artifact record for key "${record.key}" failed schema validation: ${error instanceof Error ? error.message : String(error)}`,
                nextStep: "Fix the artifact record fields before registering it; every field must satisfy ArtifactRecord.",
                details: [],
              }),
          })

          const fileInfo = yield* Effect.tryPromise({
            try: () => stat(validatedRecord.absolutePath),
            catch: (error) =>
              new EnvironmentError({
                code: "artifact-registration-missing-file",
                reason: (error as NodeJS.ErrnoException).code === "ENOENT"
                  ? `Artifact "${validatedRecord.key}" points at ${validatedRecord.absolutePath}, which does not exist on disk.`
                  : `Could not stat ${validatedRecord.absolutePath} for artifact "${validatedRecord.key}": ${error instanceof Error ? error.message : String(error)}`,
                nextStep: "Write the artifact file to disk before registering it, then retry registration.",
                details: [],
              }),
          })

          const sizeBytes = validatedRecord.sizeBytes ?? (fileInfo.isFile() ? fileInfo.size : undefined)
          const normalizedRecord = sizeBytes === undefined ? validatedRecord : { ...validatedRecord, sizeBytes }

          yield* mutateArtifactIndex(sessionId, (existing) => [
            ...existing.filter((entry) => entry.key !== normalizedRecord.key),
            normalizedRecord,
          ])
          return normalizedRecord
        }),
      listArtifacts: (sessionId) => readArtifactIndexAt(join(sessionsRoot, sessionId, "meta", artifactIndexFileName)),
      getArtifact: (sessionId, artifactKey) =>
        Effect.gen(function* () {
          const artifacts = yield* readArtifactIndexAt(join(sessionsRoot, sessionId, "meta", artifactIndexFileName))
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
        Effect.gen(function* () {
          const record = yield* Effect.tryPromise({
            try: async () => {
              const extension = format === "json" ? ".json" : ".txt"
              const root = join(sessionsRoot, sessionId)
              const outputsDirectory = join(root, "outputs")
              await ensureDirectory(outputsDirectory)

              const fileName = `${timestampForFile()}-${label}${extension}`
              const absolutePath = join(outputsDirectory, fileName)
              await writeFile(absolutePath, content, "utf8")

              return createArtifactRecord(
                probeRoot,
                `derived-${fileName}`,
                label,
                format,
                absolutePath,
                summary,
                Buffer.byteLength(content, "utf8"),
              )
            },
            catch: (error) =>
              new EnvironmentError({
                code: "derived-output-write",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Check write access to the session outputs directory and retry.",
                details: [],
              }),
          })

          yield* mutateArtifactIndex(sessionId, (existing) => [...existing, record])
          return record
        }),
      writeDerivedFile: ({ sessionId, label, kind, sourceAbsolutePath, sourceFileName, summary }) =>
        Effect.gen(function* () {
          const record = yield* Effect.tryPromise({
            try: async () => {
              const extension = extname(sourceFileName) || extname(sourceAbsolutePath)
              const root = join(sessionsRoot, sessionId)
              const outputsDirectory = join(root, "outputs")
              await ensureDirectory(outputsDirectory)

              const fileName = `${timestampForFile()}-${label}${extension}`
              const absolutePath = join(outputsDirectory, fileName)
              await copyFile(sourceAbsolutePath, absolutePath)

              return createArtifactRecord(
                probeRoot,
                `derived-${fileName}`,
                label,
                kind,
                absolutePath,
                summary,
                await readFileSize(absolutePath),
              )
            },
            catch: (error) =>
              new EnvironmentError({
                code: "derived-file-write",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Check write access to the session outputs directory and retry.",
                details: [],
              }),
          })

          yield* mutateArtifactIndex(sessionId, (existing) => [...existing, record])
          return record
        }),
      removeDaemonMetadata: () =>
        withCatalogLock(
          daemonMetadataPath,
          Effect.tryPromise({
            try: async () => {
              await unlink(daemonMetadataPath).catch(() => undefined)
              await sweepOrphanCatalogTempFile(daemonMetadataPath)
            },
            catch: (error) =>
              new EnvironmentError({
                code: "daemon-metadata-remove",
                reason: error instanceof Error ? error.message : String(error),
                nextStep: "Inspect the daemon metadata path and retry removing it.",
                details: [],
              }),
          }),
        ).pipe(Effect.catchAll(() => Effect.void), Effect.asVoid),
      writeDaemonMetadata: (value) =>
        Effect.gen(function* () {
          yield* ensureProbeRoots
          yield* writeCatalogFile(
            daemonMetadataPath,
            `${JSON.stringify(value, null, 2)}\n`,
            "daemon-metadata-write",
            "Check write access to the daemon metadata directory and retry.",
          )
        }),
      // Best-effort by design (public signature carries no error channel): if
      // daemon.json is absent there is nothing to sync into yet, and if it is
      // corrupt this intentionally skips the write rather than overwriting the
      // corrupt file with a freshly-derived {} - that would destroy the
      // evidence readDaemonMetadata() needs to surface the corruption loudly.
      syncDaemonSessionMetadata: (sessions) =>
        withCatalogLock(
          daemonMetadataPath,
          Effect.gen(function* () {
            const current = yield* readObjectCatalogAt(
              daemonMetadataPath,
              "daemon-metadata-corrupt",
              "daemon-metadata-read",
              "Inspect daemon.json and retry the session lifecycle operation.",
            )

            if (current === null) {
              return
            }

            yield* atomicWriteCatalogEffect(
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
              "daemon-session-metadata-sync",
              "Inspect daemon.json and retry the session lifecycle operation.",
            )
          }),
        ).pipe(Effect.catchAll(() => Effect.void), Effect.asVoid),
      pruneExpiredSessions: () => pruneExpiredSessions,
    })
  }),
)
