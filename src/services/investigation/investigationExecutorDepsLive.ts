import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { Context, Effect } from "effect"
import { SessionConflictError, UserInputError } from "../../domain/errors"
import { buildEvidenceReport, type PerfEvidenceChannelTables } from "../../domain/perf-evidence"
import { parsePerfTableExport, type ParsedPerfTable } from "../../domain/perf"
import type { DaemonClient } from "../DaemonClient"
import { runProbeKernelHostCommand } from "../ProbeKernel"
import { InvestigationStore, listInvestigationIds } from "../InvestigationStore"
import type { InvestigationExecutorDeps, InvestigationRpcError } from "./investigationExecutorDeps"

// PRB-099: production wiring of `InvestigationExecutorDeps`, using the same
// `DaemonClient` RPC surface every other CLI command already talks to (no
// new RPC methods, per the wave-4 handoff note: PRB-098's evidence engine
// was deliberately left unwired for this glyph to wire, not to extend the
// RPC protocol itself).
//
// Capture fusion has two lanes:
//   - preset template  -> `perf.around` (`DaemonClient.recordPerfAroundFlow`),
//     the existing proven concurrent capture+flow fusion.
//   - custom template  -> `perf.record` and `session.run` issued
//     concurrently (`Effect.all`, unbounded concurrency) over two ordinary
//     RPC round-trips. This is the deliberately looser lane: `perf.around`
//     stops recording the instant the flow completes, where this lane
//     blocks for the full declared `timeLimit` regardless of how long the
//     flow took. Extending `perf.around` itself to accept a custom
//     template was considered and deferred -- it would touch PRB-097's
//     already-shipped, already-tested lazy-export RPC surface, which is a
//     larger blast radius than this glyph's scope justifies; tracked as a
//     follow-up rather than attempted here.
//
// Channel tables for `buildEvidenceReport` are filled in by lazily exporting
// each of PRB-098's six known schemas from the just-recorded trace
// (`perf.export`, PRB-097's cached lazy-export lane) and parsing the result
// XML locally (`domain/perf.ts#parsePerfTableExport`) -- the same file the
// daemon's own `perf.analyze` reads, just invoked from the CLI process
// instead. A template that never produced a given schema (e.g. a
// time-profiler trace has no GPU/thermal/signpost tables) fails export;
// that failure is treated as "channel not present in this recording" and
// folded into `buildEvidenceReport`'s existing "unavailable" handling
// rather than propagated, since by the time export runs the daemon is
// already known reachable (the capture that preceded it already succeeded).

const perfChannelSchemas: ReadonlyArray<{
  readonly key: keyof PerfEvidenceChannelTables
  readonly schema: string
}> = [
  { key: "cpuSamples", schema: "time-sample" },
  { key: "mainThreadState", schema: "thread-state" },
  { key: "hangs", schema: "potential-hangs" },
  { key: "gpuIntervals", schema: "metal-gpu-intervals" },
  { key: "signposts", schema: "os-signpost-interval" },
  { key: "thermalState", schema: "device-thermal-state-intervals" },
]

// Review fix (AC#10, major): "Reference custom-template run performs zero
// eager schema exports." A custom `.tracetemplate`'s schema set is unknown
// to Probe ahead of time -- the exact reason `perf record --custom-template`
// already ships zero eager schema exports of its own
// (`buildCustomTemplateSpec`'s `exportSchemas: []`, PerfService.ts, PRB-097).
// Looping PRB-098's six known preset schemas against an arbitrary custom
// trace was performing exactly the eager, speculative probing PRB-097
// deliberately avoided at record time. A preset template's known schemas are
// still exported eagerly here (unchanged) since Probe knows in advance which
// of the six a given preset template can produce; a custom capture instead
// returns an evidence report with every channel "unavailable" (the same
// `buildEvidenceReport` fallback an absent table already produces) --
// `probe drill` against the preserved raw trace artifact is the documented
// path for custom-template insight (see the "custom-template-no-analysis"
// diagnosis, PerfService.ts).
const eagerlyExportedChannelSchemas = (
  capture: { readonly kind: "preset" | "custom" },
): ReadonlyArray<{ readonly key: keyof PerfEvidenceChannelTables; readonly schema: string }> =>
  capture.kind === "preset" ? perfChannelSchemas : []

let cachedXcodeVersion: string | null = null

const resolveXcodeVersion = async (): Promise<string> => {
  if (cachedXcodeVersion) {
    return cachedXcodeVersion
  }

  const result = await runProbeKernelHostCommand("/usr/bin/xcodebuild", ["-version"])
  cachedXcodeVersion = result.exitCode === 0 ? result.stdout.trim().split(/\r?\n/)[0] ?? "unknown" : "unknown"
  return cachedXcodeVersion
}

const defaultCustomCaptureTimeLimit = "30s"

export const makeInvestigationExecutorDepsLive = (daemonClient: Context.Tag.Service<typeof DaemonClient>, store: Context.Tag.Service<typeof InvestigationStore>): InvestigationExecutorDeps => ({
  nowIso: () => new Date().toISOString(),
  newInvestigationId: () => randomUUID(),

  checkSessionReady: (sessionId) =>
    Effect.map(daemonClient.getSessionHealth({ sessionId }), (health) => ({ state: health.state })),

  reserveRecorder: ({ sessionId, investigationId }) =>
    Effect.gen(function* () {
      const ids = yield* Effect.promise(() => listInvestigationIds())

      for (const otherId of ids) {
        if (otherId === investigationId) {
          continue
        }

        const other = yield* store.read(otherId).pipe(Effect.catchAll(() => Effect.succeed(null)))

        if (!other || other.sessionId !== sessionId || other.status !== "running") {
          continue
        }

        const captureIndex = other.stages.indexOf("capture")
        const pastPreflight = other.currentStageIndex >= captureIndex - 1

        if (captureIndex >= 0 && pastPreflight) {
          return yield* new SessionConflictError({
            reason: `Session ${sessionId} already has an active recorder: investigation ${otherId} is running and has reached its capture stage.`,
            nextStep: `Wait for investigation ${otherId} to finish, or cancel it with \`probe investigate cancel\`, before starting a new investigation against the same session.`,
          })
        }
      }
    }),

  releaseRecorder: () => Effect.void,

  runFlow: ({ sessionId, flow }) =>
    Effect.gen(function* () {
      const result = yield* daemonClient.runSessionFlow({ sessionId, flow })

      if (result.verdict !== "passed") {
        return yield* new UserInputError({
          code: "investigation-flow-failed",
          reason: `Flow failed with verdict "${result.verdict}": ${result.summary}`,
          nextStep: "Fix the declared setup/warmup/measured flow (see the flow's failedStep) and retry `probe investigate run`.",
          details: [],
        })
      }

      return { verdict: result.verdict, summary: result.summary }
    }),

  captureRepetition: ({ sessionId, capture, measuredFlow, recipeHash }) =>
    Effect.gen(function* () {
      const health = yield* daemonClient.getSessionHealth({ sessionId })

      const { traceArtifactKey, xctraceVersion, recordedAt } = capture.kind === "preset"
        ? yield* Effect.gen(function* () {
            const around = yield* daemonClient.recordPerfAroundFlow({ sessionId, template: capture.template, flow: measuredFlow })

            if (around.flow.verdict !== "passed") {
              return yield* new UserInputError({
                code: "investigation-measured-flow-failed",
                reason: `Measured flow failed with verdict "${around.flow.verdict}" during capture: ${around.flow.summary}`,
                nextStep: "Fix the declared measured flow (see the flow's failedStep) and retry `probe investigate run`.",
                details: [],
              })
            }

            return {
              traceArtifactKey: around.artifacts.trace.key,
              xctraceVersion: around.xctraceVersion,
              recordedAt: around.recordedAt,
            }
          })
        : yield* Effect.gen(function* () {
            const [recordResult, flowResult] = yield* Effect.all(
              [
                daemonClient.recordPerf({
                  sessionId,
                  customTemplatePath: capture.customTemplatePath,
                  timeLimit: capture.timeLimit ?? defaultCustomCaptureTimeLimit,
                }),
                daemonClient.runSessionFlow({ sessionId, flow: measuredFlow }),
              ],
              { concurrency: "unbounded" },
            )

            if (flowResult.verdict !== "passed") {
              return yield* new UserInputError({
                code: "investigation-measured-flow-failed",
                reason: `Measured flow failed with verdict "${flowResult.verdict}" during custom-template capture: ${flowResult.summary}`,
                nextStep: "Fix the declared measured flow (see the flow's failedStep) and retry `probe investigate run`.",
                details: [],
              })
            }

            return {
              traceArtifactKey: recordResult.artifacts.trace.key,
              xctraceVersion: recordResult.xctraceVersion,
              recordedAt: recordResult.recordedAt,
            }
          })

      const tables: Record<string, ParsedPerfTable | undefined> = {}

      for (const { key, schema } of eagerlyExportedChannelSchemas(capture)) {
        const exported = yield* daemonClient
          .exportPerfSchema({ sessionId, artifactKey: traceArtifactKey, schema })
          .pipe(Effect.either)

        if (exported._tag === "Left") {
          continue
        }

        const xml = yield* Effect.tryPromise({
          try: () => readFile(exported.right.artifacts.export.absolutePath, "utf8"),
          catch: () => null,
        }).pipe(Effect.catchAll(() => Effect.succeed(null)))

        if (xml === null) {
          continue
        }

        tables[key] = yield* Effect.try({ try: () => parsePerfTableExport(xml), catch: () => undefined }).pipe(
          Effect.catchAll(() => Effect.succeed(undefined)),
        )
      }

      const xcodeVersion = yield* Effect.promise(() => resolveXcodeVersion())

      const evidenceReport = buildEvidenceReport({
        provenance: {
          recipeHash,
          // Probe's current perf RPC surface does not expose the running
          // app's build number to the CLI client (only an internal target
          // process identity the daemon resolves for its own diagnoses,
          // see `PerfService.ts`'s "perf-target-identity-verified"
          // diagnosis) -- `bundleId` is the best available stable
          // identifier of *which app* recorded this evidence until that
          // surface is extended.
          appBuild: health.target.bundleId,
          processIdentity: { name: health.target.bundleId, pid: 0 },
          device: {
            name: health.target.deviceName,
            udid: health.target.deviceId,
            osVersion: health.target.runtime ?? "unknown",
          },
          xcodeVersion,
          xctraceVersion,
          templateDigest: capture.kind === "preset" ? `preset:${capture.template}` : `custom:${capture.customTemplatePath}`,
          generatedAt: recordedAt,
        },
        tables: tables as PerfEvidenceChannelTables,
      })

      return { evidenceReport, traceArtifactKey }
    }),

  sleep: (ms) => Effect.sleep(ms),
})
