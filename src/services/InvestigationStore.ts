import { Context, Effect, Layer, Schema } from "effect"
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  InvestigationEvent,
  InvestigationRecipeEnvelope,
  InvestigationReport,
  InvestigationStatus,
  type InvestigationExecutionPlan,
  type InvestigationRecipe,
} from "../domain/investigation"
import { PerfEvidenceComparison, PerfEvidenceReport } from "../domain/perf-evidence"
import { EnvironmentError } from "../domain/errors"

// PRB-099: durable, host-visible persistence for one investigation's run
// state and event feed -- the counterpart, for investigations, of what
// `ArtifactStore`'s session manifest is for sessions. Deliberately its own
// small store rather than folded into `ArtifactStore`: an investigation's
// state document is mutated repeatedly across a run (once per stage
// transition) where every existing `ArtifactStore.writeDerivedOutput` call
// mints a brand-new timestamped artifact key per write (see that method's
// header) -- exactly wrong for a single mutable "current state" document
// that `investigate inspect`/`wait`/`events`/`cancel` all need to find at a
// stable path. Immutable per-repetition/report evidence still goes through
// `ArtifactStore.writeDerivedOutput` (see InvestigationController.ts) so it
// stays drillable via the existing `probe drill` machinery.
//
// Root: `${PROBE_ARTIFACT_ROOT ?? ~/.probe}/investigations/<id>/` -- read
// live (not cached at import time), matching `ArtifactStore`'s own
// `PROBE_ARTIFACT_ROOT` convention, so tests can point this at a scratch
// directory.

export const InvestigationState = Schema.Struct({
  investigationId: Schema.String,
  recipeHash: Schema.String,
  // Persisted verbatim so a `run` call that resumes an interrupted (not yet
  // terminal) investigation can replay its remaining declared stages
  // without the caller re-supplying the recipe -- "read/resume semantics"
  // (AC). A *terminal* (completed/failed/cancelled) investigation is never
  // resumed from this regardless (see InvestigationController#run):
  // "never silently reopens/reroutes" applies to the state machine, not
  // just to this field's presence.
  // Schema'd as the permissive envelope (`measuredFlow`/`setup`/`warmup`
  // typed `unknown` at the schema level) rather than re-validating the
  // fully-normalized `InvestigationRecipe` shape on every disk read --
  // `create` below always writes an already-normalized recipe, so this is
  // purely "decode whatever JSON is on disk back into a plain object",
  // never a second strict re-validation. Every consumer (see
  // `InvestigationController.ts`) casts the result to `InvestigationRecipe`,
  // exactly as it casts the rest of this document's domain-shaped fields.
  recipe: InvestigationRecipeEnvelope,
  status: InvestigationStatus,
  stages: Schema.Array(Schema.String),
  currentStageIndex: Schema.Number,
  cancelRequested: Schema.Boolean,
  sessionId: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  report: Schema.Union(InvestigationReport, Schema.Null),
  // Full (unbounded) merged evidence across every repetition -- kept here
  // rather than truncated, so a later standalone `investigate compare` can
  // still see every sample. The terminal `report` above only ever carries
  // PRB-098's already-bounded comparison shape; this is the "bulk evidence
  // stays artifacts" half of the AC, using this state document itself as
  // the artifact rather than minting a second one through `ArtifactStore`.
  mergedEvidenceReport: Schema.Union(PerfEvidenceReport, Schema.Null),
  // Set by the "compare" stage, consumed by the "report" stage when
  // assembling the final `InvestigationReport.comparison` field. Kept as
  // its own field (never smuggled into the not-yet-assembled `report`
  // field below, which only ever holds a *complete*
  // `InvestigationReport` once one exists) so every intermediate state
  // this document can be in still round-trips through
  // `InvestigationState`'s own schema decode.
  comparisonResult: Schema.Union(PerfEvidenceComparison, Schema.Null),
  // Repetitions completed so far, in order -- checked on resume so a `run`
  // that continues an interrupted "capture" stage restarts at
  // `capturedRepetitions.length`, never re-captures a repetition whose
  // artifact was already verified and persisted (AC #5's "preserving
  // verified completed artifacts" applies to a resumed run exactly as it
  // does to a cancelled one).
  capturedRepetitions: Schema.Array(Schema.Struct({
    index: Schema.Number,
    traceArtifactKey: Schema.String,
    evidenceReport: PerfEvidenceReport,
  })),
  failureReason: Schema.Union(Schema.String, Schema.Null),
})
export type InvestigationState = typeof InvestigationState.Type

const decodeInvestigationStateSync = Schema.decodeUnknownSync(InvestigationState)
const decodeInvestigationEventsSync = Schema.decodeUnknownSync(Schema.Array(InvestigationEvent))

const investigationsRoot = (): string =>
  join(process.env.PROBE_ARTIFACT_ROOT ?? join(homedir(), ".probe"), "investigations")

const investigationDirectory = (investigationId: string): string =>
  join(investigationsRoot(), investigationId)

const statePath = (investigationId: string): string => join(investigationDirectory(investigationId), "state.json")

const eventsPath = (investigationId: string): string => join(investigationDirectory(investigationId), "events.jsonl")

// Same atomic-write primitive as `ArtifactStore.atomicWriteFile` /
// `DeviceSigningConfig.atomicWriteConfigFile`: write to a sibling temp file,
// fsync, then rename over the target. A crash between the two steps leaves
// only an orphaned `.tmp` file, never a truncated state document.
const atomicWriteFile = async (targetPath: string, content: string): Promise<void> => {
  await mkdir(dirname(targetPath), { recursive: true })
  const tempPath = `${targetPath}.tmp`
  const handle = await open(tempPath, "w")

  try {
    await handle.writeFile(content, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }

  await rename(tempPath, targetPath)
}

const environmentError = (code: string, reason: string, nextStep: string) =>
  new EnvironmentError({ code, reason, nextStep, details: [] })

export class InvestigationStore extends Context.Tag("@probe/InvestigationStore")<
  InvestigationStore,
  {
    readonly create: (args: {
      readonly investigationId: string
      readonly sessionId: string
      readonly recipe: InvestigationRecipe
      readonly recipeHash: string
      readonly plan: InvestigationExecutionPlan
      readonly createdAt: string
    }) => Effect.Effect<InvestigationState, EnvironmentError>
    readonly read: (investigationId: string) => Effect.Effect<InvestigationState | null, EnvironmentError>
    readonly update: (
      investigationId: string,
      mutate: (current: InvestigationState) => InvestigationState,
    ) => Effect.Effect<InvestigationState, EnvironmentError>
    readonly appendEvent: (
      investigationId: string,
      buildEvent: (nextSequence: number) => Schema.Schema.Type<typeof InvestigationEvent>,
    ) => Effect.Effect<void, EnvironmentError>
    readonly readEvents: (investigationId: string) => Effect.Effect<ReadonlyArray<Schema.Schema.Type<typeof InvestigationEvent>>, EnvironmentError>
    readonly requestCancel: (investigationId: string) => Effect.Effect<InvestigationState, EnvironmentError>
  }
>() {}

export const InvestigationStoreLive = Layer.succeed(
  InvestigationStore,
  InvestigationStore.of({
    create: ({ investigationId, sessionId, recipe, recipeHash, plan, createdAt }) =>
      Effect.gen(function* () {
        const state: InvestigationState = {
          investigationId,
          recipe,
          recipeHash,
          status: "pending",
          stages: [...plan.stages],
          currentStageIndex: -1,
          cancelRequested: false,
          sessionId,
          createdAt,
          updatedAt: createdAt,
          report: null,
          mergedEvidenceReport: null,
          comparisonResult: null,
          capturedRepetitions: [],
          failureReason: null,
        }

        yield* Effect.tryPromise({
          try: () => atomicWriteFile(statePath(investigationId), `${JSON.stringify(state, null, 2)}\n`),
          catch: (error) =>
            environmentError(
              "investigation-state-write",
              `Could not create investigation state for ${investigationId}: ${error instanceof Error ? error.message : String(error)}.`,
              "Verify PROBE_ARTIFACT_ROOT (or ~/.probe) is writable and retry.",
            ),
        })

        return state
      }),

    read: (investigationId) =>
      Effect.tryPromise({
        try: async () => {
          try {
            const raw = await readFile(statePath(investigationId), "utf8")
            return decodeInvestigationStateSync(JSON.parse(raw) as unknown)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              return null
            }

            throw error
          }
        },
        catch: (error) =>
          environmentError(
            "investigation-state-read",
            `Could not read investigation state for ${investigationId}: ${error instanceof Error ? error.message : String(error)}.`,
            "Verify the investigation id and retry `probe investigate inspect`.",
          ),
      }),

    update: (investigationId, mutate) =>
      Effect.gen(function* () {
        const raw = yield* Effect.tryPromise({
          try: () => readFile(statePath(investigationId), "utf8"),
          catch: (error) =>
            environmentError(
              "investigation-state-read",
              `Could not read investigation state for ${investigationId}: ${error instanceof Error ? error.message : String(error)}.`,
              "Verify the investigation id and retry.",
            ),
        })
        const current = decodeInvestigationStateSync(JSON.parse(raw) as unknown)
        const next = mutate(current)

        yield* Effect.tryPromise({
          try: () => atomicWriteFile(statePath(investigationId), `${JSON.stringify(next, null, 2)}\n`),
          catch: (error) =>
            environmentError(
              "investigation-state-write",
              `Could not update investigation state for ${investigationId}: ${error instanceof Error ? error.message : String(error)}.`,
              "Verify PROBE_ARTIFACT_ROOT (or ~/.probe) is writable and retry.",
            ),
        })

        return next
      }),

    appendEvent: (investigationId, buildEvent) =>
      Effect.gen(function* () {
        const existing = yield* Effect.tryPromise({
          try: async () => {
            try {
              return await readFile(eventsPath(investigationId), "utf8")
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return ""
              }

              throw error
            }
          },
          catch: (error) =>
            environmentError(
              "investigation-events-read",
              `Could not read investigation events for ${investigationId}: ${error instanceof Error ? error.message : String(error)}.`,
              "Verify the investigation id and retry.",
            ),
        })

        const lineCount = existing.split("\n").filter((line) => line.trim().length > 0).length
        const event = buildEvent(lineCount + 1)
        const nextContent = `${existing}${JSON.stringify(event)}\n`

        yield* Effect.tryPromise({
          try: () => atomicWriteFile(eventsPath(investigationId), nextContent),
          catch: (error) =>
            environmentError(
              "investigation-events-write",
              `Could not append investigation event for ${investigationId}: ${error instanceof Error ? error.message : String(error)}.`,
              "Verify PROBE_ARTIFACT_ROOT (or ~/.probe) is writable and retry.",
            ),
        })
      }),

    readEvents: (investigationId) =>
      Effect.tryPromise({
        try: async () => {
          let raw: string

          try {
            raw = await readFile(eventsPath(investigationId), "utf8")
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              return []
            }

            throw error
          }

          const lines = raw.split("\n").filter((line) => line.trim().length > 0)
          return decodeInvestigationEventsSync(lines.map((line) => JSON.parse(line) as unknown))
        },
        catch: (error) =>
          environmentError(
            "investigation-events-read",
            `Could not read investigation events: ${error instanceof Error ? error.message : String(error)}.`,
            "Verify the investigation id and retry.",
          ),
      }),

    requestCancel: (investigationId) =>
      Effect.gen(function* () {
        const raw = yield* Effect.tryPromise({
          try: () => readFile(statePath(investigationId), "utf8"),
          catch: (error) =>
            environmentError(
              "investigation-state-read",
              `Could not read investigation state for ${investigationId}: ${error instanceof Error ? error.message : String(error)}.`,
              "Verify the investigation id and retry.",
            ),
        })
        const current = decodeInvestigationStateSync(JSON.parse(raw) as unknown)
        const next: InvestigationState = { ...current, cancelRequested: true, updatedAt: new Date().toISOString() }

        yield* Effect.tryPromise({
          try: () => atomicWriteFile(statePath(investigationId), `${JSON.stringify(next, null, 2)}\n`),
          catch: (error) =>
            environmentError(
              "investigation-state-write",
              `Could not request cancellation for ${investigationId}: ${error instanceof Error ? error.message : String(error)}.`,
              "Verify PROBE_ARTIFACT_ROOT (or ~/.probe) is writable and retry.",
            ),
        })

        return next
      }),
  }),
)

/** Exposed for `probe doctor`/tests that need to sweep orphaned investigation directories; not part of the core contract. */
export const listInvestigationIds = async (): Promise<ReadonlyArray<string>> => {
  try {
    return await readdir(investigationsRoot())
  } catch {
    return []
  }
}

export const removeInvestigationTempSiblings = async (investigationId: string): Promise<void> => {
  await unlink(`${statePath(investigationId)}.tmp`).catch(() => undefined)
  await unlink(`${eventsPath(investigationId)}.tmp`).catch(() => undefined)
}
