import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit, Fiber } from "effect"
import { ArtifactNotFoundError } from "../domain/errors"
import type { ArtifactRecord } from "../domain/output"
import { createPerfService, runCommandToFile } from "./PerfService"

// PRB-103: path-specific fault tests for the lazy exportSchema/analyzeTrace
// pipeline. Every existing fault-behavior receipt for this cleanup/kill
// machinery (AppleProcessSupervisor.test.ts) proves it generically against
// an arbitrary spawned command -- never against PerfService's own
// exportSchema/analyzeTrace call sites. These tests wire a `commandRunner`
// whose `exportToFile` substitutes a real spawned shell process (not the
// PerfCommandRunner Promise-mock every other PerfService.test.ts case uses,
// which never threads the abort signal through to a real child at all) in
// place of `xcrun xctrace export`, so the interruption/cleanup path
// PerfService actually depends on is exercised end to end through the real
// `runCommandToFile` -> `runAppleProcess` -> `AppleProcessSupervisor` chain.

const genericTocXml = `<?xml version="1.0"?>
<trace-toc>
  <run number="1"/>
</trace-toc>`

const buildGenericPerfExportXml = (schema: string) => `<?xml version="1.0"?>
<trace-query-result>
  <node xpath='//trace-toc[1]/run[1]/data[1]/table[1]'>
    <schema name="${schema}">
      <col><mnemonic>value</mnemonic></col>
    </schema>
    <row><value fmt="example">example</value></row>
  </node>
</trace-query-result>`

const partialXmlChunk = "<row>partial</row>"

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "perf-analyze-faults-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

/** Every pid currently alive in the process group led by `pgid` (mirrors AppleProcessSupervisor.test.ts's helper -- best-effort, macOS/Linux `ps`). */
const processGroupMembers = (pgid: number): ReadonlyArray<number> => {
  try {
    const output = execFileSync("ps", ["-o", "pid=", "-g", String(pgid)], { encoding: "utf8" })
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(Number)
  } catch {
    return []
  }
}

const waitUntil = async (
  check: () => Promise<boolean> | boolean,
  options: { readonly timeoutMs: number; readonly intervalMs?: number; readonly description: string },
): Promise<number> => {
  const intervalMs = options.intervalMs ?? 20
  const startedAt = Date.now()
  const deadline = startedAt + options.timeoutMs

  while (Date.now() < deadline) {
    if (await check()) {
      return Date.now() - startedAt
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(`Timed out after ${options.timeoutMs}ms waiting for: ${options.description}`)
}

const readPidFile = async (path: string): Promise<number> => {
  const contents = await readFile(path, "utf8")
  const pid = Number(contents.trim())

  if (!Number.isInteger(pid)) {
    throw new Error(`Expected an integer pid in ${path}, got ${JSON.stringify(contents)}`)
  }

  return pid
}

const findExportFile = async (tracesDirectory: string, schema: string): Promise<string | null> => {
  const entries = await readdir(tracesDirectory)
  const match = entries.find((name) => name.startsWith(`export-${schema}-`) && name.endsWith(".xml"))
  return match ? join(tracesDirectory, match) : null
}

const withTempRoot = async <T>(run: (root: string) => Promise<T>) => {
  const root = await mkdtemp(join(tmpdir(), "probe-perf-analyze-faults-"))

  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const createArtifactStore = () => {
  const artifacts: Array<ArtifactRecord> = []

  return {
    artifacts,
    service: {
      registerArtifact: (_sessionId: string, record: ArtifactRecord) =>
        Effect.sync(() => {
          artifacts.push(record)
          return record
        }),
      getArtifact: (sessionId: string, artifactKey: string) => {
        const artifact = artifacts.find((entry) => entry.key === artifactKey)

        return artifact
          ? Effect.succeed(artifact)
          : Effect.fail(new ArtifactNotFoundError({ sessionId, artifactKey, nextStep: "none" }))
      },
    },
  }
}

const createSessionRegistryMock = () => ({
  getSessionHealth: () => Effect.die("unexpected getSessionHealth call"),
  sendRunnerKeepalive: () => Effect.die("unexpected sendRunnerKeepalive call"),
  peekSessionHealth: () => Effect.die("unexpected peekSessionHealth call"),
  beginTraceLease: () => Effect.die("unexpected beginTraceLease call"),
  endTraceLease: () => Effect.void,
})

// PRB-097: exportSchema()/analyzeTrace() start from an already-registered
// trace artifact key, never a live trace lease -- registers the trace
// bundle directory plus a sibling `-toc` artifact (a real file on disk, so
// resolveTocForTrace's fast "reuse the sibling TOC" path is used and no
// `xctrace export --toc` subprocess is needed) advertising no schemas,
// which skips the "does the TOC expose this schema" pre-flight check
// entirely -- the same shape PerfService.test.ts's own default `tocXml`
// fixture uses.
const registerTraceFixture = async (args: {
  readonly artifactStore: ReturnType<typeof createArtifactStore>
  readonly root: string
  readonly slug: string
}) => {
  const tracesDirectory = join(args.root, "traces")
  const tracePath = join(tracesDirectory, `${args.slug}.trace`)
  const tocPath = join(tracesDirectory, `${args.slug}.toc.xml`)
  await mkdir(tracePath, { recursive: true })
  await writeFile(tocPath, genericTocXml, "utf8")

  const traceArtifact = await Effect.runPromise(
    args.artifactStore.service.registerArtifact("session-1", {
      key: `${args.slug}-trace`,
      label: `${args.slug}-trace`,
      kind: "directory",
      summary: `${args.slug} trace`,
      absolutePath: tracePath,
      relativePath: `traces/${args.slug}.trace`,
      external: false,
      createdAt: "2026-04-14T00:00:00.000Z",
    }),
  )

  await Effect.runPromise(
    args.artifactStore.service.registerArtifact("session-1", {
      key: `${args.slug}-toc`,
      label: `${args.slug}-toc`,
      kind: "xml",
      summary: `${args.slug} TOC`,
      absolutePath: tocPath,
      relativePath: `traces/${args.slug}.toc.xml`,
      external: false,
      createdAt: "2026-04-14T00:00:00.000Z",
    }),
  )

  return { traceArtifact, tracesDirectory }
}

const versionCapture = async (args: { readonly commandArgs: ReadonlyArray<string> }) => {
  if (args.commandArgs[0] === "xctrace" && args.commandArgs[1] === "version") {
    return { stdout: "xctrace 26.0 (17C529)\n", stderr: "", exitCode: 0 }
  }

  throw new Error(`Unexpected capture invocation: ${args.commandArgs.join(" ")}`)
}

// Stands in for a stalled `xcrun xctrace export`: writes a recognizable
// partial chunk to `outputPath` immediately (proving real output reached
// disk before interruption), records its own pid to `pidFilePath` (so the
// test can assert on the real process-group it leads), then forks two
// descendants and blocks on them -- the same "leader + descendants" shape
// AppleProcessSupervisor.test.ts's generic descendant fault tests use,
// driven here through PerfService's actual `exportToFile` call site instead
// of the supervisor directly. Never exits on its own; only TERM/KILL ends it.
const buildHangingExportInvocation = (pidFilePath: string) => ({
  command: "/bin/sh",
  commandArgs: [
    "-c",
    `echo $$ > '${pidFilePath}'; printf '%s' '${partialXmlChunk}'; sleep 30 & sleep 30 & wait`,
  ],
})

describe("PerfService lazy export/analyze path-specific fault tests", () => {
  test(
    "exportSchema interrupted mid-export removes the partial XML and leaves zero surviving process-group descendants within the grace window",
    async () => {
      await withTempRoot(async (root) => {
        await withTempDir(async (pidDir) => {
          const pidFilePath = join(pidDir, "leader.pid")
          const artifactStore = createArtifactStore()
          const { traceArtifact, tracesDirectory } = await registerTraceFixture({
            artifactStore,
            root,
            slug: "time-profiler",
          })

          const perfService = createPerfService({
            artifactStore: artifactStore.service,
            sessionRegistry: createSessionRegistryMock(),
            commandRunner: {
              capture: versionCapture,
              exportToFile: (args: {
                readonly timeoutMs: number
                readonly gracePeriodMs?: number
                readonly outputPath: string
                readonly budget: { readonly maxBytes: number; readonly maxRows: number }
                readonly signal: AbortSignal
              }) =>
                runCommandToFile({
                  ...buildHangingExportInvocation(pidFilePath),
                  timeoutMs: args.timeoutMs,
                  gracePeriodMs: args.gracePeriodMs,
                  outputPath: args.outputPath,
                  budget: args.budget,
                  signal: args.signal,
                }),
            },
          })

          const runFiber = Effect.runFork(
            perfService.exportSchema({
              sessionId: "session-1",
              artifactKey: traceArtifact.key,
              schema: "time-sample",
              emitProgress: () => undefined,
            }),
          )

          await waitUntil(async () => (await findExportFile(tracesDirectory, "time-sample")) !== null, {
            timeoutMs: 3_000,
            description: "the partial time-sample export file to appear",
          })

          const exportPath = await findExportFile(tracesDirectory, "time-sample")
          expect(exportPath).not.toBeNull()
          expect(await readFile(exportPath!, "utf8")).toBe(partialXmlChunk)

          await waitUntil(() => readPidFile(pidFilePath).then(() => true, () => false), {
            timeoutMs: 3_000,
            description: "the fake exporter to record its own pid",
          })
          const leaderPid = await readPidFile(pidFilePath)
          expect(processGroupMembers(leaderPid).length).toBeGreaterThan(0)

          const interruptedAt = Date.now()
          const exit = await Effect.runPromise(Fiber.interrupt(runFiber))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(Cause.isInterrupted(exit.cause)).toBe(true)
          }

          // AC: "exporter descendants dead within 2s" -- the default
          // gracePeriodMs (PerfService never overrides it for exportToFile,
          // see PerfService.ts's exportSchemaWithCache) is 2000ms, and
          // neither `sleep` background job traps TERM, so the whole process
          // group should be gone well inside that window plus test/host
          // scheduling slack.
          const teardownMs = await waitUntil(() => processGroupMembers(leaderPid).length === 0, {
            timeoutMs: 2_500,
            description: "zero surviving process-group descendants after interruption",
          })
          expect(teardownMs).toBeLessThan(2_500)
          expect(Date.now() - interruptedAt).toBeLessThan(2_500)

          // AC: "interrupted export removes partial XML" -- the same
          // interruption that kills the process group also removes the
          // partial output file (PerfService.ts's runCommandToFile cleanup).
          await waitUntil(async () => (await findExportFile(tracesDirectory, "time-sample")) === null, {
            timeoutMs: 2_500,
            description: "the partial time-sample export file to be removed",
          })
          expect(await findExportFile(tracesDirectory, "time-sample")).toBeNull()
        })
      })
    },
    10_000,
  )

  test(
    "analyzeTrace interrupted mid-analysis cleans up only the in-flight export -- the already-completed export and the trace bundle both survive",
    async () => {
      await withTempRoot(async (root) => {
        await withTempDir(async (pidDir) => {
          const pidFilePath = join(pidDir, "leader.pid")
          const artifactStore = createArtifactStore()
          const { traceArtifact, tracesDirectory } = await registerTraceFixture({
            artifactStore,
            root,
            slug: "swift-concurrency",
          })

          const perfService = createPerfService({
            artifactStore: artifactStore.service,
            sessionRegistry: createSessionRegistryMock(),
            commandRunner: {
              capture: versionCapture,
              // `swift-concurrency`'s export schemas run in declared order --
              // swift-task-state, then swift-task-lifetime, then the
              // optional swift-actor-execution. The first completes for
              // real (a genuine exported+parsed artifact); the second is
              // the hanging real-process invocation this test interrupts;
              // the third must never be reached.
              exportToFile: (args: {
                readonly commandArgs: ReadonlyArray<string>
                readonly timeoutMs: number
                readonly gracePeriodMs?: number
                readonly outputPath: string
                readonly budget: { readonly maxBytes: number; readonly maxRows: number }
                readonly signal: AbortSignal
              }) => {
                const xpathIndex = args.commandArgs.indexOf("--xpath")
                const xpath = args.commandArgs[xpathIndex + 1] ?? ""
                const schemaMatch = xpath.match(/@schema="([^"]+)"\]/)
                const schema = schemaMatch?.[1]

                if (schema === "swift-task-state") {
                  const xml = buildGenericPerfExportXml(schema)
                  return writeFile(args.outputPath, xml, "utf8").then(() => ({
                    stdout: "",
                    stderr: "",
                    exitCode: 0,
                    bytesWritten: Buffer.byteLength(xml, "utf8"),
                    rowCount: 1,
                  }))
                }

                if (schema === "swift-task-lifetime") {
                  return runCommandToFile({
                    ...buildHangingExportInvocation(pidFilePath),
                    timeoutMs: args.timeoutMs,
                    gracePeriodMs: args.gracePeriodMs,
                    outputPath: args.outputPath,
                    budget: args.budget,
                    signal: args.signal,
                  })
                }

                throw new Error(`Unexpected export invocation for schema ${String(schema)} (xpath ${xpath})`)
              },
            },
          })

          const runFiber = Effect.runFork(
            perfService.analyzeTrace({
              sessionId: "session-1",
              artifactKey: traceArtifact.key,
              analyzer: "swift-concurrency",
              emitProgress: () => undefined,
            }),
          )

          await waitUntil(
            () => artifactStore.artifacts.some((artifact) => artifact.label === "swift-task-state-export"),
            { timeoutMs: 3_000, description: "the swift-task-state export to be registered" },
          )
          await waitUntil(
            async () => (await findExportFile(tracesDirectory, "swift-task-state")) !== null,
            { timeoutMs: 3_000, description: "the completed swift-task-state export file to appear" },
          )
          const completedExportPath = await findExportFile(tracesDirectory, "swift-task-state")
          expect(completedExportPath).not.toBeNull()

          await waitUntil(async () => (await findExportFile(tracesDirectory, "swift-task-lifetime")) !== null, {
            timeoutMs: 3_000,
            description: "the partial swift-task-lifetime export file to appear",
          })

          await Effect.runPromise(Fiber.interrupt(runFiber))

          await waitUntil(async () => (await findExportFile(tracesDirectory, "swift-task-lifetime")) === null, {
            timeoutMs: 2_500,
            description: "the partial swift-task-lifetime export file to be removed",
          })

          // The in-flight (second) export's partial file is gone...
          expect(await findExportFile(tracesDirectory, "swift-task-lifetime")).toBeNull()
          // ...but the already-completed (first) export survives untouched -- cleanup
          // is scoped to the export that was actually interrupted, not every export
          // this analysis touched.
          expect(await readFile(completedExportPath!, "utf8")).toBe(buildGenericPerfExportXml("swift-task-state"))
          // ...and the trace bundle itself -- never touched by export cleanup at all -- survives.
          expect((await stat(traceArtifact.absolutePath)).isDirectory()).toBe(true)
          // The optional third schema was never reached.
          expect(await findExportFile(tracesDirectory, "swift-actor-execution")).toBeNull()
        })
      })
    },
    10_000,
  )
})
