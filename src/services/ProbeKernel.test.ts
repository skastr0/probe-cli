import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer, ManagedRuntime } from "effect"
import { UserInputError } from "../domain/errors"
import { PROBE_PROTOCOL_VERSION } from "../rpc/protocol"
import { ArtifactStore } from "./ArtifactStore"
import { OutputPolicy } from "./OutputPolicy"
import { PerfService } from "./PerfService"
import { ProbeKernel, ProbeKernelLive } from "./ProbeKernel"
import { SessionRegistry } from "./SessionRegistry"
import { SimulatorHarness } from "./SimulatorHarness"

describe("ProbeKernel", () => {
  test("includes associated log markers in artifact drill output", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-kernel-test-"))

    try {
      const sessionId = "session-1"
      const logPath = join(root, "logs", "xcodebuild-session.log")
      const markPath = join(root, "logs", "marks", "2026-04-14T03-30-00-before-submit.json")

      await mkdir(join(root, "logs", "marks"), { recursive: true })
      await writeFile(logPath, "session ok\n", "utf8")
      await writeFile(
        markPath,
        `${JSON.stringify({
          timestamp: "2026-04-14T03:30:00.000Z",
          label: "before-submit",
          sessionId,
        }, null, 2)}\n`,
        "utf8",
      )

      const artifact = {
        key: "xcodebuild-session-log",
        label: "xcodebuild-session-log",
        kind: "text" as const,
        summary: "runner log",
        absolutePath: logPath,
        relativePath: "logs/xcodebuild-session.log",
        external: false,
        createdAt: "2026-04-14T03:30:00.000Z",
      }

      const baseLayer = Layer.mergeAll(
        Layer.succeed(
          ArtifactStore,
          ArtifactStore.of({
            getRootDirectory: () => Effect.succeed(root),
            getArtifactRetentionMs: () => 60_000,
            getDaemonSocketPath: () => Effect.succeed(join(root, "probe.sock")),
            getDaemonMetadataPath: () => Effect.succeed(join(root, "daemon.json")),
            ensureDaemonDirectories: () => Effect.void,
            isDaemonRunning: () => Effect.succeed(false),
            readDaemonMetadata: () => Effect.succeed(null),
            createSessionLayout: () => Effect.die("unused createSessionLayout"),
            removeSessionLayout: () => Effect.void,
            readSessionManifest: () => Effect.succeed({ sessionId, artifactRoot: root }),
            listPersistedSessions: () => Effect.succeed([]),
            writeSessionManifest: () => Effect.void,
            registerArtifact: (_sessionId: string, record: any) => Effect.succeed(record),
            listArtifacts: () => Effect.succeed([artifact]),
            getArtifact: () => Effect.succeed(artifact),
            writeDerivedOutput: () => Effect.die("unused writeDerivedOutput"),
            writeDerivedFile: () => Effect.die("unused writeDerivedFile"),
            removeDaemonMetadata: () => Effect.void,
            writeDaemonMetadata: () => Effect.void,
            syncDaemonSessionMetadata: () => Effect.void,
            pruneExpiredSessions: () => Effect.void,
          } as any),
        ),
        Layer.succeed(
          OutputPolicy,
          OutputPolicy.of({
            getDefaultInlineThreshold: () => ({ maxInlineBytes: 4 * 1024, maxInlineLines: 100 }),
            shouldInline: () => true,
            shouldInlineBinary: () => false,
          }),
        ),
        Layer.succeed(PerfService, PerfService.of({ record: () => Effect.die("unused perf.record") } as any)),
        Layer.succeed(SessionRegistry, SessionRegistry.of({} as any)),
        Layer.succeed(SimulatorHarness, SimulatorHarness.of({} as any)),
      )

      const runtime = ManagedRuntime.make(Layer.mergeAll(baseLayer, ProbeKernelLive.pipe(Layer.provide(baseLayer))))

      try {
        const kernel = await runtime.runPromise(Effect.gen(function* () {
          return yield* ProbeKernel
        }))
        const response = await runtime.runPromise(kernel.handleRpcRequest({
          kind: "request",
          protocolVersion: PROBE_PROTOCOL_VERSION,
          requestId: "req-1",
          method: "artifact.drill",
          params: {
            sessionId,
            artifactKey: artifact.key,
            outputMode: "inline",
            query: {
              kind: "text",
              startLine: 1,
              endLine: 10,
              match: null,
              contextLines: 0,
            },
          },
        }, () => {})) as any

        expect(response.result.kind).toBe("inline")

        if (response.result.kind === "inline") {
          expect(response.result.content).toContain("session ok")
          expect(response.result.content).toContain("probe log markers:")
          expect(response.result.content).toContain("before-submit")
          expect(response.result.content).toContain("2026-04-14T03:30:00.000Z")
        }
      } finally {
        await runtime.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("fails session result summary when no xcresult bundle is registered", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-kernel-test-"))

    try {
      const sessionId = "session-1"

      const baseLayer = Layer.mergeAll(
        Layer.succeed(
          ArtifactStore,
          ArtifactStore.of({
            getRootDirectory: () => Effect.succeed(root),
            getArtifactRetentionMs: () => 60_000,
            getDaemonSocketPath: () => Effect.succeed(join(root, "probe.sock")),
            getDaemonMetadataPath: () => Effect.succeed(join(root, "daemon.json")),
            ensureDaemonDirectories: () => Effect.void,
            isDaemonRunning: () => Effect.succeed(false),
            readDaemonMetadata: () => Effect.succeed(null),
            createSessionLayout: () => Effect.die("unused createSessionLayout"),
            removeSessionLayout: () => Effect.void,
            readSessionManifest: () => Effect.succeed({ sessionId, artifactRoot: root }),
            listPersistedSessions: () => Effect.succeed([]),
            writeSessionManifest: () => Effect.void,
            registerArtifact: (_sessionId: string, record: any) => Effect.succeed(record),
            listArtifacts: () => Effect.succeed([]),
            getArtifact: () => Effect.die("unused getArtifact"),
            writeDerivedOutput: () => Effect.die("unused writeDerivedOutput"),
            writeDerivedFile: () => Effect.die("unused writeDerivedFile"),
            removeDaemonMetadata: () => Effect.void,
            writeDaemonMetadata: () => Effect.void,
            syncDaemonSessionMetadata: () => Effect.void,
            pruneExpiredSessions: () => Effect.void,
          } as any),
        ),
        Layer.succeed(
          OutputPolicy,
          OutputPolicy.of({
            getDefaultInlineThreshold: () => ({ maxInlineBytes: 4 * 1024, maxInlineLines: 100 }),
            shouldInline: () => true,
            shouldInlineBinary: () => false,
          }),
        ),
        Layer.succeed(PerfService, PerfService.of({ record: () => Effect.die("unused perf.record") } as any)),
        Layer.succeed(
          SessionRegistry,
          SessionRegistry.of({
            getSessionHealth: () => Effect.succeed({
              sessionId,
              runner: {
                resultBundlePath: null,
              },
              artifacts: [],
            }),
          } as any),
        ),
        Layer.succeed(SimulatorHarness, SimulatorHarness.of({} as any)),
      )

      const runtime = ManagedRuntime.make(Layer.mergeAll(baseLayer, ProbeKernelLive.pipe(Layer.provide(baseLayer))))

      try {
        const kernel = await runtime.runPromise(Effect.gen(function* () {
          return yield* ProbeKernel
        }))
        const response = await runtime.runPromise(
          Effect.either(
            kernel.handleRpcRequest({
              kind: "request",
              protocolVersion: PROBE_PROTOCOL_VERSION,
              requestId: "req-2",
              method: "session.result.summary",
              params: {
                sessionId,
              },
            }, () => {}),
          ),
        )

        expect(Either.isLeft(response)).toBe(true)

        if (!Either.isLeft(response)) {
          throw new Error("Expected session result summary to fail without a result bundle")
        }

        expect(response.left).toBeInstanceOf(UserInputError)

        if (!(response.left instanceof UserInputError)) {
          throw new Error(`Expected UserInputError, received ${String(response.left)}`)
        }

        expect(response.left.code).toBe("session-result-bundle-missing")
      } finally {
        await runtime.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("returns binary artifacts directly from drill requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-kernel-test-"))

    try {
      const sessionId = "session-1"
      const bundlePath = join(root, "diagnostics", "capture.tar.gz")

      await mkdir(join(root, "diagnostics"), { recursive: true })
      await writeFile(bundlePath, "fake diagnostic bundle\n", "utf8")

      const artifact = {
        key: "diagnostic-simulator-capture",
        label: "simulator-diagnostic",
        kind: "binary" as const,
        summary: "diagnostic bundle",
        absolutePath: bundlePath,
        relativePath: "diagnostics/capture.tar.gz",
        external: false,
        createdAt: "2026-04-14T03:30:00.000Z",
      }

      const baseLayer = Layer.mergeAll(
        Layer.succeed(
          ArtifactStore,
          ArtifactStore.of({
            getRootDirectory: () => Effect.succeed(root),
            getArtifactRetentionMs: () => 60_000,
            getDaemonSocketPath: () => Effect.succeed(join(root, "probe.sock")),
            getDaemonMetadataPath: () => Effect.succeed(join(root, "daemon.json")),
            ensureDaemonDirectories: () => Effect.void,
            isDaemonRunning: () => Effect.succeed(false),
            readDaemonMetadata: () => Effect.succeed(null),
            createSessionLayout: () => Effect.die("unused createSessionLayout"),
            removeSessionLayout: () => Effect.void,
            readSessionManifest: () => Effect.succeed({ sessionId, artifactRoot: root }),
            listPersistedSessions: () => Effect.succeed([]),
            writeSessionManifest: () => Effect.void,
            registerArtifact: (_sessionId: string, record: any) => Effect.succeed(record),
            listArtifacts: () => Effect.succeed([artifact]),
            getArtifact: () => Effect.succeed(artifact),
            writeDerivedOutput: () => Effect.die("unused writeDerivedOutput"),
            writeDerivedFile: () => Effect.die("unused writeDerivedFile"),
            removeDaemonMetadata: () => Effect.void,
            writeDaemonMetadata: () => Effect.void,
            syncDaemonSessionMetadata: () => Effect.void,
            pruneExpiredSessions: () => Effect.void,
          } as any),
        ),
        Layer.succeed(
          OutputPolicy,
          OutputPolicy.of({
            getDefaultInlineThreshold: () => ({ maxInlineBytes: 4 * 1024, maxInlineLines: 100 }),
            shouldInline: () => true,
            shouldInlineBinary: () => false,
          }),
        ),
        Layer.succeed(PerfService, PerfService.of({ record: () => Effect.die("unused perf.record") } as any)),
        Layer.succeed(SessionRegistry, SessionRegistry.of({} as any)),
        Layer.succeed(SimulatorHarness, SimulatorHarness.of({} as any)),
      )

      const runtime = ManagedRuntime.make(Layer.mergeAll(baseLayer, ProbeKernelLive.pipe(Layer.provide(baseLayer))))

      try {
        const kernel = await runtime.runPromise(Effect.gen(function* () {
          return yield* ProbeKernel
        }))
        const response = await runtime.runPromise(kernel.handleRpcRequest({
          kind: "request",
          protocolVersion: PROBE_PROTOCOL_VERSION,
          requestId: "req-3",
          method: "artifact.drill",
          params: {
            sessionId,
            artifactKey: artifact.key,
            outputMode: "inline",
            query: {
              kind: "text",
              startLine: 1,
              endLine: 10,
              match: null,
              contextLines: 0,
            },
          },
        }, () => {})) as any

        expect(response.result.kind).toBe("summary+artifact")

        if (response.result.kind === "summary+artifact") {
          expect(response.result.artifact.absolutePath).toBe(bundlePath)
          expect(response.result.summary).toContain("binary kind binary")
        }
      } finally {
        await runtime.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
