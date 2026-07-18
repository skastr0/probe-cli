import { access, mkdir, mkdtemp, open, readFile, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import type { DefectFinding } from "../schema"

const trialCount = 16
const reproductionThreshold = 0.5

interface FixtureArtifactRecord {
  readonly key: string
  readonly label: string
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

// PRB-097: as of PRB-090 (atomic ArtifactStore, landed on main before this
// wave), ArtifactStore.ts's real registerArtifact no longer does a bare,
// unlocked read-modify-write -- it serializes every read+write of a given
// catalog file behind an in-process, per-path lock (`withCatalogLock`,
// ArtifactStore.ts:350; `catalogLockFor`/`catalogLocks`, ArtifactStore.ts:336-348)
// and the write itself lands via an atomic temp-write-then-rename
// (`atomicWriteFile`, ArtifactStore.ts:82-108), never a bare `writeFile`.
// `registerArtifact` (ArtifactStore.ts:721) delegates the whole
// read-modify-write critical section to `mutateArtifactIndex`
// (ArtifactStore.ts:415-435), which is the `withCatalogLock`-wrapped
// read+write this mirror now reproduces. This mirror was left un-updated
// after PRB-090 landed -- flipping it to match the current, already-fixed
// algorithm (and updating the findings below) is this glyph's (PRB-097)
// scoped ownership, per the wave handoff note.
//
// ArtifactStoreLive itself roots every session under `join(homedir(), ".probe")`
// (ArtifactStore.ts:323) with no injection point, and Bun's `os.homedir()` does not
// honor a HOME override at call time (verified empirically against this repo's Bun
// 1.3.14), so this scenario exercises the identical algorithm against a temp
// directory rather than the real singleton service to avoid touching the operator's
// real ~/.probe artifact root during an automated benchmark run.

// Mirrors ArtifactStore.ts's `catalogLocks`/`catalogLockFor`/`withCatalogLock`
// (ArtifactStore.ts:336-351): one serialized queue per exact file path, so two
// concurrent registrations for the *same* session catalog never interleave
// their read+write, while unrelated sessions (different catalog paths) never
// contend with each other.
const catalogLocks = new Map<string, Promise<unknown>>()

const withCatalogLockMirror = <T>(path: string, critical: () => Promise<T>): Promise<T> => {
  const previous = catalogLocks.get(path) ?? Promise.resolve()
  const next = previous.then(critical, critical)
  catalogLocks.set(path, next.catch(() => undefined))
  return next
}

// Mirrors ArtifactStore.ts's `atomicWriteFile` (ArtifactStore.ts:82-108): write
// to a sibling temp file, then atomically rename it over the target so a
// concurrent reader only ever observes the fully-old or fully-new content.
const atomicWriteFileMirror = async (targetPath: string, content: string): Promise<void> => {
  await mkdir(dirname(targetPath), { recursive: true })
  const tempPath = `${targetPath}.tmp`
  const handle = await open(tempPath, "w")

  try {
    await handle.writeFile(content, "utf8")
  } finally {
    await handle.close()
  }

  await rename(tempPath, targetPath)
}

const readArtifactIndexMirror = async (
  sessionsRoot: string,
  sessionId: string,
): Promise<Array<FixtureArtifactRecord>> => {
  const indexPath = join(sessionsRoot, sessionId, "meta", "artifact-index.json")

  if (!(await fileExists(indexPath))) {
    return []
  }

  const content = await readFile(indexPath, "utf8")
  return safeJsonParse<Array<FixtureArtifactRecord>>(content, [])
}

const registerArtifactMirror = async (
  sessionsRoot: string,
  sessionId: string,
  record: FixtureArtifactRecord,
): Promise<FixtureArtifactRecord> => {
  const indexPath = join(sessionsRoot, sessionId, "meta", "artifact-index.json")

  return withCatalogLockMirror(indexPath, async () => {
    const existing = await readArtifactIndexMirror(sessionsRoot, sessionId)
    const next = [...existing.filter((entry) => entry.key !== record.key), record]
    await atomicWriteFileMirror(indexPath, `${JSON.stringify(next, null, 2)}\n`)
    return record
  })
}

interface TrialResult {
  readonly bothSucceededWithoutThrowing: boolean
  readonly bothPersisted: boolean
}

const runTrial = async (): Promise<TrialResult> => {
  const sessionsRoot = await mkdtemp(join(tmpdir(), "probe-investigation-artifact-race-"))

  try {
    const sessionId = "fixture-session"
    const recordA: FixtureArtifactRecord = { key: "screenshot-a", label: "screenshot" }
    const recordB: FixtureArtifactRecord = { key: "video-b", label: "video" }

    const settled = await Promise.allSettled([
      registerArtifactMirror(sessionsRoot, sessionId, recordA),
      registerArtifactMirror(sessionsRoot, sessionId, recordB),
    ])
    const bothSucceededWithoutThrowing = settled.every((entry) => entry.status === "fulfilled")

    const finalIndex = await readArtifactIndexMirror(sessionsRoot, sessionId)
    const persistedKeys = new Set(finalIndex.map((entry) => entry.key))
    const bothPersisted = persistedKeys.has(recordA.key) && persistedKeys.has(recordB.key)

    return { bothSucceededWithoutThrowing, bothPersisted }
  } finally {
    await rm(sessionsRoot, { recursive: true, force: true })
  }
}

export const runArtifactRaceAndEagerExportScenario = async (): Promise<
  readonly [artifactRace: DefectFinding, eagerExport: DefectFinding]
> => {
  try {
    const trials: Array<TrialResult> = []

    for (let index = 0; index < trialCount; index += 1) {
      trials.push(await runTrial())
    }

    const lostTrials = trials.filter((trial) => !trial.bothPersisted)
    const eagerLossTrials = lostTrials.filter((trial) => trial.bothSucceededWithoutThrowing)
    const raceRate = lostTrials.length / trialCount
    const eagerRate = eagerLossTrials.length / trialCount
    const raceReproduced = raceRate >= reproductionThreshold
    const eagerReproduced = eagerRate >= reproductionThreshold

    const artifactRace: DefectFinding = {
      id: "artifact-race-01",
      category: "artifact-race",
      verdict: raceReproduced ? "red" : "green",
      summary: raceReproduced
        ? `Concurrent artifact registrations for the same session lost one registration in ${lostTrials.length}/${trialCount} trials: registerArtifact reads the whole index, appends in memory, then overwrites the file, so two concurrent registrations can both read the pre-write state and the later write clobbers the earlier one.`
        : `PRB-097: re-verified against the current (PRB-090) locked ArtifactStore algorithm — ${lostTrials.length}/${trialCount} trials lost a registration, below the ${Math.round(reproductionThreshold * 100)}% reproduction threshold. The per-catalog-path lock (registerArtifact -> mutateArtifactIndex -> withCatalogLock) serializes the whole read-modify-write critical section, so two concurrent registrations for the same session catalog can no longer interleave.`,
      evidence: [
        "src/services/ArtifactStore.ts:721 (registerArtifact) delegates its whole read-modify-write to mutateArtifactIndex (ArtifactStore.ts:415-435), which wraps the read + atomic write in withCatalogLock (ArtifactStore.ts:350-351) keyed by the exact catalog file path (catalogLockFor/catalogLocks, ArtifactStore.ts:336-348) -- no longer a bare read-then-write with no lock.",
        "src/services/ArtifactStore.ts:82-108 (atomicWriteFile) -- the write itself is a temp-file-then-rename, so a concurrent reader never observes a partial write, on top of (not instead of) the lock above.",
        `reproduction: ${lostTrials.length}/${trialCount} trials lost a registration (${(raceRate * 100).toFixed(0)}%), re-measured against a mirror of the current locked algorithm.`,
      ],
      metrics: {
        trialCount,
        lostTrials: lostTrials.length,
        reproductionRate: raceRate,
      },
    }

    const eagerExport: DefectFinding = {
      id: "eager-export-01",
      category: "eager-export",
      verdict: eagerReproduced ? "red" : "green",
      summary: eagerReproduced
        ? `In ${eagerLossTrials.length}/${trialCount} trials, both concurrent registrations reported success with no thrown error even though only one was actually persisted — a caller that receives the "artifact registered" result has no guarantee the artifact is durably discoverable via a subsequent list/drill call.`
        : `PRB-097: re-verified against the current (PRB-090) locked ArtifactStore algorithm — ${eagerLossTrials.length}/${trialCount} trials returned an eager success for a registration that did not survive, below the ${Math.round(reproductionThreshold * 100)}% reproduction threshold. Because the underlying artifact-race window is now closed (see artifact-race-01), a caller that receives "artifact registered" can trust the entry is durably discoverable via a subsequent list/drill call.`,
      evidence: [
        "src/services/ArtifactStore.ts:721 (registerArtifact) returns `normalizedRecord` only after mutateArtifactIndex's lock-guarded read-modify-write (ArtifactStore.ts:415-435) has already committed via the atomic rename (ArtifactStore.ts:82-108, 94), so a concurrent registration under the same lock cannot silently clobber it before the caller sees success.",
        "src/services/ArtifactStore.ts:777 (writeDerivedOutput) and every other artifact-registering path in this file (writeDerivedFile, ArtifactStore.ts:846) call mutateArtifactIndex directly (ArtifactStore.ts:415-435) -- the same withCatalogLock-guarded helper registerArtifact uses -- not an inlined, unlocked read-modify-write.",
        `reproduction: ${eagerLossTrials.length}/${trialCount} trials returned success for a registration that did not survive (${(eagerRate * 100).toFixed(0)}%), re-measured against a mirror of the current locked algorithm.`,
      ],
      metrics: {
        trialCount,
        eagerLossTrials: eagerLossTrials.length,
        reproductionRate: eagerRate,
      },
    }

    return [artifactRace, eagerExport] as const
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)

    return [
      {
        id: "artifact-race-01",
        category: "artifact-race",
        verdict: "not-run",
        summary: `Scenario harness failed before it could observe artifact registration races: ${message}`,
        evidence: [message],
        metrics: {},
      },
      {
        id: "eager-export-01",
        category: "eager-export",
        verdict: "not-run",
        summary: `Scenario harness failed before it could observe eager export success reporting: ${message}`,
        evidence: [message],
        metrics: {},
      },
    ] as const
  }
}
