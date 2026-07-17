import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

// Faithful mirror of the read-modify-write shape in src/services/ArtifactStore.ts.
// readArtifactIndex: ArtifactStore.ts:258-277. writeArtifactIndex: ArtifactStore.ts:279-293.
// registerArtifact:  ArtifactStore.ts:509-517 (sizeBytes lookup omitted here — it does
// not participate in the read-modify-write window this scenario measures).
// ArtifactStoreLive itself roots every session under `join(homedir(), ".probe")`
// (ArtifactStore.ts:238) with no injection point, and Bun's `os.homedir()` does not
// honor a HOME override at call time (verified empirically against this repo's Bun
// 1.3.14), so this scenario exercises the identical algorithm against a temp
// directory rather than the real singleton service to avoid touching the operator's
// real ~/.probe artifact root during an automated benchmark run.
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

const writeArtifactIndexMirror = async (
  sessionsRoot: string,
  sessionId: string,
  records: ReadonlyArray<FixtureArtifactRecord>,
): Promise<void> => {
  const indexPath = join(sessionsRoot, sessionId, "meta", "artifact-index.json")
  await mkdir(dirname(indexPath), { recursive: true })
  await writeFile(indexPath, `${JSON.stringify(records, null, 2)}\n`, "utf8")
}

const registerArtifactMirror = async (
  sessionsRoot: string,
  sessionId: string,
  record: FixtureArtifactRecord,
): Promise<FixtureArtifactRecord> => {
  const existing = await readArtifactIndexMirror(sessionsRoot, sessionId)
  const next = [...existing.filter((entry) => entry.key !== record.key), record]
  await writeArtifactIndexMirror(sessionsRoot, sessionId, next)
  return record
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
        : `Concurrent artifact registrations only lost data in ${lostTrials.length}/${trialCount} trials, below the ${Math.round(reproductionThreshold * 100)}% reproduction threshold.`,
      evidence: [
        "src/services/ArtifactStore.ts:509-517 — registerArtifact does `const existing = yield* readArtifactIndex(sessionId)`, appends in memory, then `yield* writeArtifactIndex(sessionId, next)` with no lock, version check, or atomic append.",
        "src/services/ArtifactStore.ts:258-293 — readArtifactIndex/writeArtifactIndex operate on the same JSON file with no compare-and-swap.",
        `reproduction: ${lostTrials.length}/${trialCount} trials lost a registration (${(raceRate * 100).toFixed(0)}%).`,
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
        : `Every trial with data loss also surfaced a thrown error, so callers were not misled by an eager success in this run.`,
      evidence: [
        "src/services/ArtifactStore.ts:509-517 — registerArtifact always resolves with `normalizedRecord` on the happy path; it never re-reads the index after writing to confirm its own entry survived a concurrent writer.",
        "src/services/SessionRegistry.ts:5949-5999 (exportRecording) delegates to the shared writeJsonArtifact helper (SessionRegistry.ts:2215-2254), which resolves on a single registerArtifact call (line 2252); src/services/ArtifactStore.ts:534-558 (writeDerivedOutput) duplicates registerArtifact's own read-modify-write index update inline (readArtifactIndex then writeArtifactIndex at lines 556-557). Both return their artifact record to the RPC caller as export success without a post-write verification read.",
        `reproduction: ${eagerLossTrials.length}/${trialCount} trials returned success for a registration that did not survive (${(eagerRate * 100).toFixed(0)}%).`,
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
