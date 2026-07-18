import { mkdir, open, readFile, rename } from "node:fs/promises"
import { dirname, join } from "node:path"
import { probeRootPath } from "./ProjectRoot"

/**
 * PRB-095: resolves which Apple development team signs the real-device
 * runner build, and persists an operator-chosen default across sessions.
 *
 * Before this module, the only input was `PROBE_DEVELOPMENT_TEAM` read
 * directly out of the *daemon's* environment at preflight time (see
 * `RealDeviceHarness`'s prior implementation). Probe's daemon is a
 * long-lived process started once and reused by many short-lived CLI
 * invocations; an environment variable set for one of those invocations'
 * shells never reaches the already-running daemon process, so "just export
 * the variable and retry" silently did nothing without a daemon restart.
 *
 * The fix: resolve precedence once, on the client/CLI side that actually has
 * the command-scoped environment, and carry only the *resolved* (non-secret)
 * team id through the session-open RPC. The daemon never reads its own
 * environment for this again.
 */

export const developmentTeamEnvKey = "PROBE_DEVELOPMENT_TEAM"

/**
 * `PROBE_CONFIG_ROOT` mirrors the override already used by `ArtifactStore`
 * (`PROBE_ARTIFACT_ROOT`) -- read live rather than cached at import time so
 * tests can point this at a scratch directory instead of the real `~/.probe`.
 */
export const resolveProbeConfigPath = (): string =>
  join(process.env.PROBE_CONFIG_ROOT ?? probeRootPath, "config.json")

export interface PersistedDeviceSigningConfig {
  readonly developmentTeam: string | null
}

const emptyPersistedConfig: PersistedDeviceSigningConfig = { developmentTeam: null }

interface ProbeConfigFile {
  readonly device?: {
    readonly developmentTeam?: string | null
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const parsePersistedConfig = (raw: string): PersistedDeviceSigningConfig => {
  const parsed = JSON.parse(raw) as ProbeConfigFile
  const team = parsed.device?.developmentTeam

  return { developmentTeam: typeof team === "string" && team.trim().length > 0 ? team.trim() : null }
}

/**
 * Never throws: a missing or corrupt config file is treated the same as "no
 * persisted team configured" so a broken/hand-edited config file degrades to
 * the next precedence tier (environment) instead of blocking session open.
 */
export const readPersistedDeviceSigningConfig = async (): Promise<PersistedDeviceSigningConfig> => {
  try {
    const raw = await readFile(resolveProbeConfigPath(), "utf8")
    return parsePersistedConfig(raw)
  } catch {
    return emptyPersistedConfig
  }
}

const readWholeConfigFile = async (): Promise<Record<string, unknown>> => {
  try {
    const raw = await readFile(resolveProbeConfigPath(), "utf8")
    const parsed = JSON.parse(raw) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Atomic write (temp file + rename), matching the pattern already used for
 * Probe's other host-visible catalog files (see `ArtifactStore`'s
 * `atomicWriteFile`) -- a crash between the write and the rename leaves only
 * an orphaned `.tmp` sibling, never a truncated config file.
 */
const atomicWriteConfigFile = async (content: string): Promise<void> => {
  const configPath = resolveProbeConfigPath()
  await mkdir(dirname(configPath), { recursive: true })
  const tempPath = `${configPath}.tmp`
  const handle = await open(tempPath, "w")

  try {
    await handle.writeFile(content, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }

  await rename(tempPath, configPath)
}

/** Sets or clears (`developmentTeam: null`) the persisted default team, preserving any other config keys already on disk. */
export const writePersistedDeviceSigningConfig = async (args: PersistedDeviceSigningConfig): Promise<void> => {
  const existing = await readWholeConfigFile()
  const existingDevice = isRecord(existing.device) ? existing.device : {}

  const next = {
    ...existing,
    device: {
      ...existingDevice,
      developmentTeam: args.developmentTeam,
    },
  }

  await atomicWriteConfigFile(`${JSON.stringify(next, null, 2)}\n`)
}

export type DevelopmentTeamSource = "explicit-payload" | "persisted-config" | "environment"

export interface ResolvedDevelopmentTeam {
  readonly developmentTeam: string
  readonly source: DevelopmentTeamSource
}

const normalize = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? ""
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Pure precedence resolver: explicit payload (e.g. `--team-id` or a session-
 * open JSON payload field) wins over the persisted config default, which
 * wins over the environment variable. Returns `null` only when none of the
 * three tiers supplied a non-empty value.
 */
export const resolveDevelopmentTeam = (args: {
  readonly explicitTeamId?: string | null
  readonly persistedTeamId?: string | null
  readonly environmentTeamId?: string | null
}): ResolvedDevelopmentTeam | null => {
  const explicit = normalize(args.explicitTeamId)
  if (explicit) {
    return { developmentTeam: explicit, source: "explicit-payload" }
  }

  const persisted = normalize(args.persistedTeamId)
  if (persisted) {
    return { developmentTeam: persisted, source: "persisted-config" }
  }

  const environment = normalize(args.environmentTeamId)
  if (environment) {
    return { developmentTeam: environment, source: "environment" }
  }

  return null
}

/**
 * Convenience wrapper for the common call site: reads the persisted config
 * and the current process's environment, then resolves precedence against an
 * explicit (caller-supplied) team id. This is the seam `DaemonClient.openSession`
 * calls -- always on the client/CLI process, never inside the daemon.
 */
export const resolveDevelopmentTeamFromHost = async (
  explicitTeamId: string | null | undefined,
): Promise<ResolvedDevelopmentTeam | null> => {
  const persisted = await readPersistedDeviceSigningConfig()

  return resolveDevelopmentTeam({
    explicitTeamId,
    persistedTeamId: persisted.developmentTeam,
    environmentTeamId: process.env[developmentTeamEnvKey] ?? null,
  })
}
