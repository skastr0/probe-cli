import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Either, ManagedRuntime } from "effect"
import { EnvironmentError } from "../domain/errors"
import type { ArtifactRecord } from "../domain/output"
import { ArtifactStore, ArtifactStoreLive } from "./ArtifactStore"

type ArtifactStoreService = Context.Tag.Service<typeof ArtifactStore>

// ArtifactStoreLive resolves its root from PROBE_ARTIFACT_ROOT so every test
// runs against an isolated tmp directory and never touches the real ~/.probe.
const withArtifactStore = async <T>(
  run: (context: {
    readonly store: ArtifactStoreService
    readonly root: string
  }) => Promise<T>,
): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "probe-artifact-store-test-"))
  const previous = process.env.PROBE_ARTIFACT_ROOT
  process.env.PROBE_ARTIFACT_ROOT = root

  const runtime = ManagedRuntime.make(ArtifactStoreLive)

  try {
    const store = await runtime.runPromise(ArtifactStore)
    return await run({ store, root })
  } finally {
    await runtime.dispose()

    if (previous === undefined) {
      delete process.env.PROBE_ARTIFACT_ROOT
    } else {
      process.env.PROBE_ARTIFACT_ROOT = previous
    }

    await rm(root, { recursive: true, force: true })
  }
}

const fixtureArtifact = (key: string): ArtifactRecord => ({
  key,
  label: key,
  kind: "text",
  summary: `artifact ${key}`,
  absolutePath: `/tmp/${key}.txt`,
  relativePath: null,
  external: true,
  createdAt: new Date().toISOString(),
})

describe("ArtifactStoreLive atomic catalog writer", () => {
  test("session manifest and artifact index writes leave no temp file and round-trip", async () => {
    await withArtifactStore(async ({ store, root }) => {
      const layout = await Effect.runPromise(store.createSessionLayout("session-1"))
      await Effect.runPromise(store.writeSessionManifest("session-1", { state: "opening", bundleId: "dev.probe.fixture" }))
      await Effect.runPromise(store.registerArtifact("session-1", fixtureArtifact("a1")))

      const manifest = await Effect.runPromise(store.readSessionManifest("session-1"))
      expect(manifest).toEqual({ state: "opening", bundleId: "dev.probe.fixture" })

      const artifacts = await Effect.runPromise(store.listArtifacts("session-1"))
      expect(artifacts.map((a) => a.key)).toEqual(["a1"])

      const metaEntries = await readdir(layout.metaDirectory)
      expect(metaEntries.some((entry) => entry.endsWith(".tmp"))).toBe(false)

      const rawManifest = await readFile(layout.manifestPath, "utf8")
      expect(() => JSON.parse(rawManifest)).not.toThrow()
      expect(rawManifest.endsWith("\n")).toBe(true)
    })
  })

  test("daemon metadata write is atomic and round-trips", async () => {
    await withArtifactStore(async ({ store }) => {
      await Effect.runPromise(store.writeDaemonMetadata({ pid: 1234, startedAt: "2026-07-13T00:00:00.000Z" }))
      const metadata = await Effect.runPromise(store.readDaemonMetadata())
      expect(metadata).toEqual({ pid: 1234, startedAt: "2026-07-13T00:00:00.000Z" })

      const daemonMetadataPath = await Effect.runPromise(store.getDaemonMetadataPath())
      const entries = await readdir(join(daemonMetadataPath, ".."))
      expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false)
    })
  })

  test("missing catalog files are reported as legitimate absence, not corruption", async () => {
    await withArtifactStore(async ({ store }) => {
      const manifest = await Effect.runPromise(store.readSessionManifest("never-opened"))
      expect(manifest).toBeNull()

      const daemonMetadata = await Effect.runPromise(store.readDaemonMetadata())
      expect(daemonMetadata).toBeNull()
    })
  })

  test("corrupt session manifest surfaces a typed error instead of a silent empty fallback", async () => {
    await withArtifactStore(async ({ store }) => {
      const layout = await Effect.runPromise(store.createSessionLayout("session-corrupt"))
      await writeFile(layout.manifestPath, "{ not valid json", "utf8")

      const result = await Effect.runPromise(Effect.either(store.readSessionManifest("session-corrupt")))
      expect(Either.isLeft(result)).toBe(true)

      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(EnvironmentError)
        expect(result.left.code).toBe("session-manifest-corrupt")
      }
    })
  })

  test("corrupt artifact index surfaces a typed error and blocks registerArtifact/listArtifacts/getArtifact", async () => {
    await withArtifactStore(async ({ store }) => {
      const layout = await Effect.runPromise(store.createSessionLayout("session-index-corrupt"))
      await writeFile(layout.artifactIndexPath, "{}", "utf8")

      const listResult = await Effect.runPromise(Effect.either(store.listArtifacts("session-index-corrupt")))
      expect(Either.isLeft(listResult)).toBe(true)
      if (Either.isLeft(listResult)) {
        expect(listResult.left.code).toBe("artifact-index-corrupt")
      }

      const registerResult = await Effect.runPromise(
        Effect.either(store.registerArtifact("session-index-corrupt", fixtureArtifact("a1"))),
      )
      expect(Either.isLeft(registerResult)).toBe(true)
      if (Either.isLeft(registerResult)) {
        expect(registerResult.left.code).toBe("artifact-index-corrupt")
      }

      const getResult = await Effect.runPromise(
        Effect.either(store.getArtifact("session-index-corrupt", "a1")),
      )
      expect(Either.isLeft(getResult)).toBe(true)
      if (Either.isLeft(getResult)) {
        expect(getResult.left).toBeInstanceOf(EnvironmentError)
      }

      // The corrupt file itself must survive untouched - no silent "recovery"
      // by overwriting it with an empty array.
      const rawIndex = await readFile(layout.artifactIndexPath, "utf8")
      expect(rawIndex).toBe("{}")
    })
  })

  test("an artifact index that is valid JSON and a valid array but has a malformed entry still surfaces as corruption", async () => {
    await withArtifactStore(async ({ store }) => {
      const layout = await Effect.runPromise(store.createSessionLayout("session-malformed-entry"))
      // Valid JSON, valid array shape - but the entry is missing required
      // ArtifactRecord fields. A shallow Array.isArray check would let this
      // through; the schema decode must not.
      await writeFile(layout.artifactIndexPath, `${JSON.stringify([{ key: "a1" }], null, 2)}\n`, "utf8")

      const result = await Effect.runPromise(Effect.either(store.listArtifacts("session-malformed-entry")))
      expect(Either.isLeft(result)).toBe(true)

      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(EnvironmentError)
        expect(result.left.code).toBe("artifact-index-corrupt")
      }
    })
  })

  test("corrupt daemon metadata surfaces a typed error from readDaemonMetadata and is left untouched by syncDaemonSessionMetadata", async () => {
    await withArtifactStore(async ({ store }) => {
      const daemonMetadataPath = await Effect.runPromise(store.getDaemonMetadataPath())
      await mkdir(join(daemonMetadataPath, ".."), { recursive: true })
      await writeFile(daemonMetadataPath, "not json at all", "utf8")

      const result = await Effect.runPromise(Effect.either(store.readDaemonMetadata()))
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left.code).toBe("daemon-metadata-corrupt")
      }

      // syncDaemonSessionMetadata has no error channel by design (best-effort
      // bookkeeping); it must skip the write rather than clobber the corrupt
      // file with a freshly-derived {}, preserving the evidence for the
      // strict read above.
      await Effect.runPromise(
        store.syncDaemonSessionMetadata([
          {
            sessionId: "s1",
            state: "open",
            bundleId: "dev.probe.fixture",
            simulatorUdid: null,
            artifactRoot: null,
            updatedAt: new Date().toISOString(),
          },
        ]),
      )

      const rawAfterSync = await readFile(daemonMetadataPath, "utf8")
      expect(rawAfterSync).toBe("not json at all")
    })
  })

  test("existing session directories written the pre-atomic-writer way stay readable without migration", async () => {
    await withArtifactStore(async ({ store, root }) => {
      // Simulate a session directory laid down by a previous Probe version:
      // a plain writeFile, never touched by the new atomic-write primitive.
      const sessionId = "legacy-session"
      const metaDirectory = join(root, "sessions", sessionId, "meta")
      await mkdir(metaDirectory, { recursive: true })
      await writeFile(
        join(metaDirectory, "session-manifest.json"),
        `${JSON.stringify({ state: "closed", bundleId: "dev.probe.legacy" }, null, 2)}\n`,
        "utf8",
      )
      await writeFile(
        join(metaDirectory, "artifact-index.json"),
        `${JSON.stringify([fixtureArtifact("legacy-artifact")], null, 2)}\n`,
        "utf8",
      )

      const manifest = await Effect.runPromise(store.readSessionManifest(sessionId))
      expect(manifest).toEqual({ state: "closed", bundleId: "dev.probe.legacy" })

      const artifacts = await Effect.runPromise(store.listArtifacts(sessionId))
      expect(artifacts.map((a) => a.key)).toEqual(["legacy-artifact"])

      const persisted = await Effect.runPromise(store.listPersistedSessions())
      expect(persisted.some((entry) => entry.sessionId === sessionId)).toBe(true)

      // And it must still be writable through the new primitive afterwards.
      await Effect.runPromise(store.registerArtifact(sessionId, fixtureArtifact("legacy-artifact-2")))
      const artifactsAfter = await Effect.runPromise(store.listArtifacts(sessionId))
      expect(artifactsAfter.map((a) => a.key).sort()).toEqual(["legacy-artifact", "legacy-artifact-2"])
    })
  })

  test("an orphaned .tmp catalog file from a crashed write is swept deterministically on daemon start and does not corrupt subsequent reads or writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-artifact-store-orphan-test-"))
    const previous = process.env.PROBE_ARTIFACT_ROOT
    process.env.PROBE_ARTIFACT_ROOT = root

    try {
      const metaDirectory = join(root, "sessions", "session-orphan", "meta")
      await mkdir(metaDirectory, { recursive: true })
      await writeFile(
        join(metaDirectory, "artifact-index.json"),
        `${JSON.stringify([fixtureArtifact("committed")], null, 2)}\n`,
        "utf8",
      )
      // A crash between the temp write and the rename leaves exactly this on disk.
      await writeFile(join(metaDirectory, "artifact-index.json.tmp"), "{ garbage from a crashed write", "utf8")

      const daemonRoot = join(root, "daemon", "v1")
      await mkdir(daemonRoot, { recursive: true })
      await writeFile(join(daemonRoot, "daemon.json.tmp"), "also garbage", "utf8")

      // Constructing ArtifactStoreLive is the daemon-start moment: the sweep
      // must run before any request is served.
      const runtime = ManagedRuntime.make(ArtifactStoreLive)

      try {
        const store = await runtime.runPromise(ArtifactStore)

        const orphanGone = await readdir(metaDirectory)
        expect(orphanGone.includes("artifact-index.json.tmp")).toBe(false)

        const daemonOrphanGone = await readdir(daemonRoot)
        expect(daemonOrphanGone.includes("daemon.json.tmp")).toBe(false)

        // The real (already-committed) catalog file must be unaffected.
        const artifacts = await Effect.runPromise(store.listArtifacts("session-orphan"))
        expect(artifacts.map((a) => a.key)).toEqual(["committed"])

        // And a subsequent write must succeed normally, with no interference
        // from the swept orphan.
        await Effect.runPromise(store.registerArtifact("session-orphan", fixtureArtifact("after-sweep")))
        const artifactsAfter = await Effect.runPromise(store.listArtifacts("session-orphan"))
        expect(artifactsAfter.map((a) => a.key).sort()).toEqual(["after-sweep", "committed"])
      } finally {
        await runtime.dispose()
      }
    } finally {
      if (previous === undefined) {
        delete process.env.PROBE_ARTIFACT_ROOT
      } else {
        process.env.PROBE_ARTIFACT_ROOT = previous
      }

      await rm(root, { recursive: true, force: true })
    }
  })

  test("100 concurrent unique registerArtifact calls durably persist all 100 entries, repeated across 20 runs", async () => {
    const totalRuns = 20
    const registrationsPerRun = 100

    for (let run = 0; run < totalRuns; run += 1) {
      await withArtifactStore(async ({ store }) => {
        const sessionId = `concurrency-session-${run}`
        await Effect.runPromise(store.createSessionLayout(sessionId))

        const keys = Array.from({ length: registrationsPerRun }, (_, index) => `artifact-${index}`)

        await Promise.all(
          keys.map((key) => Effect.runPromise(store.registerArtifact(sessionId, fixtureArtifact(key)))),
        )

        const artifacts = await Effect.runPromise(store.listArtifacts(sessionId))
        expect(artifacts.length).toBe(registrationsPerRun)
        expect(new Set(artifacts.map((a) => a.key)).size).toBe(registrationsPerRun)
        expect(new Set(artifacts.map((a) => a.key))).toEqual(new Set(keys))
      })
    }
  }, 60_000)

  test("100 concurrent unique syncDaemonSessionMetadata calls converge without lost updates", async () => {
    await withArtifactStore(async ({ store }) => {
      await Effect.runPromise(store.writeDaemonMetadata({ pid: 1, startedAt: new Date().toISOString() }))

      const calls = Array.from({ length: 100 }, (_, index) => index)

      await Promise.all(
        calls.map((index) =>
          Effect.runPromise(
            store.syncDaemonSessionMetadata([
              {
                sessionId: `s${index}`,
                state: "open",
                bundleId: "dev.probe.fixture",
                simulatorUdid: null,
                artifactRoot: null,
                updatedAt: new Date().toISOString(),
              },
            ]),
          ),
        ),
      )

      const metadata = await Effect.runPromise(store.readDaemonMetadata())
      expect(metadata).not.toBeNull()
      // Every call's target shape must be internally consistent - no
      // torn/interleaved write ever lands activeSessions and sessions out of
      // sync with each other, which a lost update on the read-modify-write
      // cycle would produce.
      expect((metadata as Record<string, unknown>).activeSessions).toBe(1)
      expect(Array.isArray((metadata as Record<string, unknown>).sessions)).toBe(true)
      expect(((metadata as Record<string, unknown>).sessions as Array<unknown>).length).toBe(1)
    })
  })
})
