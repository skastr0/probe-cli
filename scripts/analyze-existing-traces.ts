/**
 * Offline harness: rehydrate registered perf trace artifacts from a closed
 * session directory and run analyzeTrace with the live xctrace exporter.
 * Used to prove record → analyze after a daemon restart kills the live session.
 */
import { writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { createPerfService } from "../src/services/PerfService"
import { ArtifactNotFoundError } from "../src/domain/errors"
import type { ArtifactRecord } from "../src/domain/output"

const SID = process.env.PROBE_SESSION_ID ?? "07afc2e8-3509-4dd2-9667-e92fc0f02ad2"
const ROOT = join(process.env.HOME ?? "", ".probe/sessions", SID)
const TRACE_DIR = join(ROOT, "traces")
const OUT = join(process.cwd(), "knowledge/ripple-qa-perf-2026-07-28")

const metalKey = "2026-07-28T05-49-19-569Z-metal-system-trace-trace"
const cpuKey = "2026-07-28T05-52-40-123Z-time-profiler-trace"

const artifacts = new Map<string, ArtifactRecord>()

const seed = (
  key: string,
  label: string,
  kind: ArtifactRecord["kind"],
  absolutePath: string,
  summary: string,
) => {
  const record: ArtifactRecord = {
    key,
    label,
    kind,
    summary,
    absolutePath,
    relativePath: absolutePath.replace(`${ROOT}/`, ""),
    external: false,
    createdAt: new Date().toISOString(),
  }
  artifacts.set(key, record)
  return record
}

seed(
  metalKey,
  "metal-system-trace-trace",
  "directory",
  join(TRACE_DIR, "2026-07-28T05-49-19-569Z-metal-system-trace.trace"),
  "Metal System Trace raw .trace bundle.",
)
seed(
  "2026-07-28T05-49-19-569Z-metal-system-trace-toc",
  "metal-system-trace-toc",
  "xml",
  join(TRACE_DIR, "2026-07-28T05-49-19-569Z-metal-system-trace.toc.xml"),
  "Metal System Trace TOC export.",
)
seed(
  cpuKey,
  "time-profiler-trace",
  "directory",
  join(TRACE_DIR, "2026-07-28T05-52-40-123Z-time-profiler.trace"),
  "Time Profiler raw .trace bundle.",
)
seed(
  "2026-07-28T05-52-40-123Z-time-profiler-toc",
  "time-profiler-toc",
  "xml",
  join(TRACE_DIR, "2026-07-28T05-52-40-123Z-time-profiler.toc.xml"),
  "Time Profiler TOC export.",
)

const metalMeta = JSON.parse(
  readFileSync(join(TRACE_DIR, "2026-07-28T05-49-19-569Z-metal-system-trace.perf-meta.json"), "utf8"),
)
const cpuMeta = JSON.parse(
  readFileSync(join(TRACE_DIR, "2026-07-28T05-52-40-123Z-time-profiler.perf-meta.json"), "utf8"),
)
console.log("metal meta", metalMeta)
console.log("cpu meta", cpuMeta)

const artifactStore = {
  registerArtifact: (_sessionId: string, record: ArtifactRecord) =>
    Effect.sync(() => {
      artifacts.set(record.key, record)
      return record
    }),
  getArtifact: (_sessionId: string, key: string) => {
    const found = artifacts.get(key)
    if (!found) {
      return Effect.fail(
        new ArtifactNotFoundError({
          sessionId: SID,
          artifactKey: key,
          nextStep: "Register the artifact or use a live session.",
        }),
      )
    }
    return Effect.succeed(found)
  },
}

const sessionRegistry = {
  getSessionHealth: () => Effect.succeed({ state: "ready", sessionId: SID } as never),
  sendRunnerKeepalive: () => Effect.void,
  peekSessionHealth: () => Effect.succeed({ state: "ready", sessionId: SID } as never),
  beginTraceLease: () => Effect.die("not needed"),
  endTraceLease: () => Effect.void,
}

const perf = createPerfService({
  artifactStore,
  sessionRegistry: sessionRegistry as never,
})

const progress = (stage: string, message: string) => console.error(`[${stage}] ${message}`)

const printResult = (label: string, result: {
  summary: { headline: string; metrics: ReadonlyArray<{ label: string; value: string }> }
  diagnoses: ReadonlyArray<{ code: string; severity: string; summary: string; details: ReadonlyArray<string> }>
  artifacts: { exports: ReadonlyArray<unknown> }
}) => {
  console.log(`\n=== ${label} ===`)
  console.log("HEADLINE:", result.summary.headline)
  for (const metric of result.summary.metrics) {
    console.log(`  ${metric.label}: ${metric.value}`)
  }
  console.log("DIAGNOSES:")
  for (const diagnosis of result.diagnoses) {
    console.log(`  [${diagnosis.severity}] ${diagnosis.code}: ${diagnosis.summary}`)
    for (const detail of diagnosis.details.slice(0, 4)) {
      console.log(`   - ${detail}`)
    }
  }
  console.log("exports:", result.artifacts.exports.length)
}

console.log("\n=== ANALYZE METAL 60s ===")
const metalStarted = Date.now()
const metal = await Effect.runPromise(
  perf.analyzeTrace({
    sessionId: SID,
    artifactKey: metalKey,
    analyzer: "metal-system-trace",
    emitProgress: progress,
  }),
)
console.log("metal ms", Date.now() - metalStarted)
printResult("METAL", metal)
writeFileSync(join(OUT, "50-metal-analyze-60s.json"), `${JSON.stringify(metal, null, 2)}\n`)

console.log("\n=== ANALYZE CPU 60s ===")
const cpuStarted = Date.now()
const cpu = await Effect.runPromise(
  perf.analyzeTrace({
    sessionId: SID,
    artifactKey: cpuKey,
    analyzer: "time-profiler",
    emitProgress: progress,
  }),
)
console.log("cpu ms", Date.now() - cpuStarted)
printResult("CPU", cpu)
writeFileSync(join(OUT, "51-cpu-analyze-60s.json"), `${JSON.stringify(cpu, null, 2)}\n`)

console.log("\nDONE")
