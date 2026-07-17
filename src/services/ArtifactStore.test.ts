import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises"
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

// registerArtifact now validates existence before commit (Gate #8), so every
// fixture used through registerArtifact must point at a file that actually
// exists on disk. Fixtures live under `${root}/fixtures` so they get cleaned
// up by the caller's own root teardown instead of leaking into the real /tmp.
const fixtureArtifact = async (root: string, key: string, content = `fixture content for ${key}`): Promise<ArtifactRecord> => {
  const fixtureDirectory = join(root, "fixtures")
  await mkdir(fixtureDirectory, { recursive: true })
  const absolutePath = join(fixtureDirectory, `${key}.txt`)
  await writeFile(absolutePath, content, "utf8")

  return {
    key,
    label: key,
    kind: "text",
    summary: `artifact ${key}`,
    absolutePath,
    relativePath: null,
    external: true,
    createdAt: new Date().toISOString(),
  }
}

describe("ArtifactStoreLive atomic catalog writer", () => {
  test("session manifest and artifact index writes leave no temp file and round-trip", async () => {
    await withArtifactStore(async ({ store, root }) => {
      const layout = await Effect.runPromise(store.createSessionLayout("session-1"))
      await Effect.runPromise(store.writeSessionManifest("session-1", { state: "opening", bundleId: "dev.probe.fixture" }))
      await Effect.runPromise(store.registerArtifact("session-1", await fixtureArtifact(root, "a1")))

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

  test("listPersistedSessions surfaces a corrupt session manifest as a per-entry failure instead of failing the whole call", async () => {
    await withArtifactStore(async ({ store }) => {
      await Effect.runPromise(store.writeSessionManifest("session-good-1", { state: "closed", bundleId: "dev.probe.fixture" }))
      await Effect.runPromise(store.writeSessionManifest("session-good-2", { state: "opening", bundleId: "dev.probe.fixture" }))

      const corruptLayout = await Effect.runPromise(store.createSessionLayout("session-corrupt-listing"))
      await writeFile(corruptLayout.manifestPath, "{ not valid json", "utf8")

      // The call itself must still succeed - one corrupt manifest must not
      // poison startup recovery or `probe sessions list`/`probe doctor` for
      // every other (valid) session.
      const listing = await Effect.runPromise(store.listPersistedSessions())

      expect(listing.sessions.map((session) => session.sessionId).sort()).toEqual(["session-good-1", "session-good-2"])

      expect(listing.failures.length).toBe(1)
      expect(listing.failures[0]?.sessionId).toBe("session-corrupt-listing")
      expect(listing.failures[0]?.code).toBe("session-manifest-corrupt")
      expect(typeof listing.failures[0]?.reason).toBe("string")
    })
  })

  test("corrupt artifact index surfaces a typed error and blocks registerArtifact/listArtifacts/getArtifact", async () => {
    await withArtifactStore(async ({ store, root }) => {
      const layout = await Effect.runPromise(store.createSessionLayout("session-index-corrupt"))
      await writeFile(layout.artifactIndexPath, "{}", "utf8")

      const listResult = await Effect.runPromise(Effect.either(store.listArtifacts("session-index-corrupt")))
      expect(Either.isLeft(listResult)).toBe(true)
      if (Either.isLeft(listResult)) {
        expect(listResult.left.code).toBe("artifact-index-corrupt")
      }

      const registerResult = await Effect.runPromise(
        Effect.either(store.registerArtifact("session-index-corrupt", await fixtureArtifact(root, "a1"))),
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

  test("registerArtifact fails closed and never commits when the artifact's absolutePath does not exist on disk", async () => {
    await withArtifactStore(async ({ store, root }) => {
      await Effect.runPromise(store.createSessionLayout("session-missing-file"))

      const missingFileRecord: ArtifactRecord = {
        key: "ghost",
        label: "ghost",
        kind: "text",
        summary: "an artifact whose file was never written",
        absolutePath: join(root, "fixtures", "does-not-exist.txt"),
        relativePath: null,
        external: true,
        createdAt: new Date().toISOString(),
      }

      const result = await Effect.runPromise(Effect.either(store.registerArtifact("session-missing-file", missingFileRecord)))
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(EnvironmentError)
        expect(result.left.code).toBe("artifact-registration-missing-file")
      }

      // The failed registration must never have reached the atomic write.
      const artifacts = await Effect.runPromise(store.listArtifacts("session-missing-file"))
      expect(artifacts).toEqual([])
    })
  })

  test("registerArtifact fails closed and never commits when the record fails ArtifactRecord schema validation", async () => {
    await withArtifactStore(async ({ store }) => {
      await Effect.runPromise(store.createSessionLayout("session-invalid-record"))

      // Missing required fields (label, summary, external, createdAt, ...) -
      // cast through `any` the way a malformed RPC payload would arrive, since
      // the TS type alone cannot be trusted to police every runtime caller.
      const invalidRecord = { key: "bad", kind: "text", absolutePath: "/tmp/whatever" } as any as ArtifactRecord

      const result = await Effect.runPromise(Effect.either(store.registerArtifact("session-invalid-record", invalidRecord)))
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(EnvironmentError)
        expect(result.left.code).toBe("artifact-registration-invalid")
      }

      const artifacts = await Effect.runPromise(store.listArtifacts("session-invalid-record"))
      expect(artifacts).toEqual([])
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
        `${JSON.stringify([await fixtureArtifact(root, "legacy-artifact")], null, 2)}\n`,
        "utf8",
      )

      const manifest = await Effect.runPromise(store.readSessionManifest(sessionId))
      expect(manifest).toEqual({ state: "closed", bundleId: "dev.probe.legacy" })

      const artifacts = await Effect.runPromise(store.listArtifacts(sessionId))
      expect(artifacts.map((a) => a.key)).toEqual(["legacy-artifact"])

      const persisted = await Effect.runPromise(store.listPersistedSessions())
      expect(persisted.sessions.some((entry) => entry.sessionId === sessionId)).toBe(true)

      // And it must still be writable through the new primitive afterwards.
      await Effect.runPromise(store.registerArtifact(sessionId, await fixtureArtifact(root, "legacy-artifact-2")))
      const artifactsAfter = await Effect.runPromise(store.listArtifacts(sessionId))
      expect(artifactsAfter.map((a) => a.key).sort()).toEqual(["legacy-artifact", "legacy-artifact-2"])
    })
  })

  // Crash matrix, point 1 of 2: fault during the temp write itself, before it
  // is ever fully flushed. The .tmp sibling left behind is garbage/partial.
  test("crash matrix (fault before fsync completes): an orphaned garbage .tmp catalog file from a crashed write is swept deterministically on daemon start and does not corrupt subsequent reads or writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-artifact-store-orphan-test-"))
    const previous = process.env.PROBE_ARTIFACT_ROOT
    process.env.PROBE_ARTIFACT_ROOT = root

    try {
      const metaDirectory = join(root, "sessions", "session-orphan", "meta")
      await mkdir(metaDirectory, { recursive: true })
      await writeFile(
        join(metaDirectory, "artifact-index.json"),
        `${JSON.stringify([await fixtureArtifact(root, "committed")], null, 2)}\n`,
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
        await Effect.runPromise(store.registerArtifact("session-orphan", await fixtureArtifact(root, "after-sweep")))
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

  // Crash matrix, point 2 of 2: fault after the temp write is fully written
  // and fsynced, but before the rename that commits it. Unlike point 1, the
  // .tmp sibling here is complete, well-formed JSON - a legitimate next
  // version that simply never got promoted. Startup must still discard it and
  // keep serving the prior committed catalog rather than adopting an
  // unrenamed (and therefore unvalidated-as-committed) file.
  test("crash matrix (fault after fsync, before rename): a fully-flushed but uncommitted .tmp catalog file is discarded on daemon start in favor of the prior committed catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-artifact-store-crash-matrix-test-"))
    const previous = process.env.PROBE_ARTIFACT_ROOT
    process.env.PROBE_ARTIFACT_ROOT = root

    try {
      const metaDirectory = join(root, "sessions", "session-crash-matrix", "meta")
      await mkdir(metaDirectory, { recursive: true })
      const committedArtifact = await fixtureArtifact(root, "committed")
      await writeFile(
        join(metaDirectory, "artifact-index.json"),
        `${JSON.stringify([committedArtifact], null, 2)}\n`,
        "utf8",
      )

      // Reproduce exactly what atomicWriteFile does up through fsync, but
      // deliberately stop before the rename - this is what a crash between
      // fsync() returning and rename() executing leaves on disk.
      const nextArtifact = await fixtureArtifact(root, "never-committed")
      const nextContent = `${JSON.stringify([committedArtifact, nextArtifact], null, 2)}\n`
      const tempHandle = await open(join(metaDirectory, "artifact-index.json.tmp"), "w")
      try {
        await tempHandle.writeFile(nextContent, "utf8")
        await tempHandle.sync()
      } finally {
        await tempHandle.close()
      }

      const runtime = ManagedRuntime.make(ArtifactStoreLive)

      try {
        const store = await runtime.runPromise(ArtifactStore)

        const swept = await readdir(metaDirectory)
        expect(swept.includes("artifact-index.json.tmp")).toBe(false)

        // The old committed catalog stays authoritative - the fully-valid but
        // never-renamed content must never be adopted.
        const artifacts = await Effect.runPromise(store.listArtifacts("session-crash-matrix"))
        expect(artifacts.map((a) => a.key)).toEqual(["committed"])

        // And the catalog remains normally writable afterwards.
        await Effect.runPromise(store.registerArtifact("session-crash-matrix", await fixtureArtifact(root, "after-crash")))
        const artifactsAfter = await Effect.runPromise(store.listArtifacts("session-crash-matrix"))
        expect(artifactsAfter.map((a) => a.key).sort()).toEqual(["after-crash", "committed"])
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

  test("registering a duplicate key replaces it deterministically without dropping unrelated entries", async () => {
    await withArtifactStore(async ({ store, root }) => {
      const sessionId = "session-duplicate-key"
      await Effect.runPromise(store.createSessionLayout(sessionId))

      await Effect.runPromise(store.registerArtifact(sessionId, await fixtureArtifact(root, "other-1")))
      await Effect.runPromise(store.registerArtifact(sessionId, await fixtureArtifact(root, "dup", "version one")))
      await Effect.runPromise(store.registerArtifact(sessionId, await fixtureArtifact(root, "other-2")))

      const beforeReplace = await Effect.runPromise(store.listArtifacts(sessionId))
      expect(beforeReplace.map((a) => a.key).sort()).toEqual(["dup", "other-1", "other-2"])
      const firstDupEntry = beforeReplace.find((a) => a.key === "dup")
      expect(firstDupEntry?.summary).toBe("artifact dup")

      // Re-register the same key with different content/metadata.
      const replacement = await fixtureArtifact(root, "dup", "version two, much longer than version one")
      const updated = await Effect.runPromise(
        store.registerArtifact(sessionId, { ...replacement, summary: "replaced dup artifact" }),
      )

      const afterReplace = await Effect.runPromise(store.listArtifacts(sessionId))

      // Deterministic replace: still exactly one "dup" entry, and the two
      // unrelated keys are untouched.
      expect(afterReplace.map((a) => a.key).sort()).toEqual(["dup", "other-1", "other-2"])
      const dupEntries = afterReplace.filter((a) => a.key === "dup")
      expect(dupEntries.length).toBe(1)
      expect(dupEntries[0]?.summary).toBe("replaced dup artifact")
      expect(dupEntries[0]?.sizeBytes).toBe(updated.sizeBytes)
      expect(dupEntries[0]?.sizeBytes).not.toBe(firstDupEntry?.sizeBytes)

      const otherOne = afterReplace.find((a) => a.key === "other-1")
      const otherTwo = afterReplace.find((a) => a.key === "other-2")
      expect(otherOne?.summary).toBe("artifact other-1")
      expect(otherTwo?.summary).toBe("artifact other-2")
    })
  })

  test("100 concurrent unique registerArtifact calls durably persist all 100 entries, repeated across 20 runs", async () => {
    const totalRuns = 20
    const registrationsPerRun = 100

    for (let run = 0; run < totalRuns; run += 1) {
      await withArtifactStore(async ({ store, root }) => {
        const sessionId = `concurrency-session-${run}`
        await Effect.runPromise(store.createSessionLayout(sessionId))

        const keys = Array.from({ length: registrationsPerRun }, (_, index) => `artifact-${index}`)

        await Promise.all(
          keys.map(async (key) =>
            Effect.runPromise(store.registerArtifact(sessionId, await fixtureArtifact(root, key)))
          ),
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
