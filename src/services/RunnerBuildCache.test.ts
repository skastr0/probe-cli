import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  computeRunnerBuildCacheKey,
  computeRunnerSourceHash,
  ensureRealDeviceRunnerBuildCached,
  resetRunnerSourceHashCacheForTests,
  resolveRunnerSourceHash,
  type RunnerBuildCacheDeps,
  type RunnerBuildProducts,
  type SignedProductValidation,
} from "./RunnerBuildCache"

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "runner-build-cache-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

const baseKeyInput = {
  runtimeAssetHash: "runtime-hash-1",
  runnerSourceHash: "source-hash-1",
  xcodeVersion: "Xcode 16.0",
  sdkVersion: "18.0",
  platform: "ios-device",
  arch: "arm64",
  developmentTeam: "TEAMID1234",
  signingIdentity: "automatic",
  profileIdentity: "automatic",
  buildSettingsHash: "settings-hash-1",
}

const validSignature = (overrides: Partial<SignedProductValidation> = {}): SignedProductValidation => ({
  signed: true,
  signingIdentity: "Apple Development: Test (ABCDE12345)",
  profileIdentity: "profile-uuid-1",
  profileExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  reason: null,
  ...overrides,
})

/** Builds a fake `RunnerBuildCacheDeps` that materializes real product paths under `derivedDataPath` on each build. */
const makeFakeDeps = (overrides: Partial<RunnerBuildCacheDeps> = {}): {
  readonly deps: RunnerBuildCacheDeps
  readonly buildCallCount: () => number
  readonly verifyCallCount: () => number
} => {
  let buildCalls = 0
  let verifyCalls = 0

  const deps: RunnerBuildCacheDeps = {
    runBuild: async ({ derivedDataPath, buildLogPath }) => {
      buildCalls += 1
      const productsRoot = join(derivedDataPath, "Build", "Products", "Debug-iphoneos")
      await mkdir(productsRoot, { recursive: true })
      await mkdir(join(productsRoot, "ProbeFixture.app"), { recursive: true })
      await mkdir(join(productsRoot, "ProbeRunnerUITests-Runner.app", "PlugIns", "ProbeRunnerUITests.xctest"), {
        recursive: true,
      })
      await writeFile(join(derivedDataPath, "Build", "Products", "test.xctestrun"), "<plist/>", "utf8")
      await mkdir(join(buildLogPath, ".."), { recursive: true })
      await writeFile(buildLogPath, "build ok\n", "utf8")
      return { exitCode: 0, failureSummary: null }
    },
    locateProducts: async (derivedDataPath): Promise<RunnerBuildProducts | null> => {
      const productsRoot = join(derivedDataPath, "Build", "Products", "Debug-iphoneos")
      const runnerAppPath = join(productsRoot, "ProbeRunnerUITests-Runner.app")
      return {
        xctestrunPath: join(derivedDataPath, "Build", "Products", "test.xctestrun"),
        targetAppPath: join(productsRoot, "ProbeFixture.app"),
        runnerAppPath,
        runnerXctestPath: join(runnerAppPath, "PlugIns", "ProbeRunnerUITests.xctest"),
      }
    },
    verifyProduct: async () => {
      verifyCalls += 1
      return validSignature()
    },
    now: () => new Date(),
    ...overrides,
  }

  return { deps, buildCallCount: () => buildCalls, verifyCallCount: () => verifyCalls }
}

describe("computeRunnerBuildCacheKey", () => {
  test("is deterministic regardless of field insertion order", () => {
    const a = computeRunnerBuildCacheKey(baseKeyInput)
    const b = computeRunnerBuildCacheKey({ ...baseKeyInput })
    expect(a.hash).toBe(b.hash)
  })

  test("changes when any discriminating field changes", () => {
    const base = computeRunnerBuildCacheKey(baseKeyInput)
    const fields: ReadonlyArray<keyof typeof baseKeyInput> = [
      "runtimeAssetHash",
      "runnerSourceHash",
      "xcodeVersion",
      "sdkVersion",
      "platform",
      "arch",
      "developmentTeam",
      "signingIdentity",
      "profileIdentity",
      "buildSettingsHash",
    ]

    for (const field of fields) {
      const changed = computeRunnerBuildCacheKey({ ...baseKeyInput, [field]: `${baseKeyInput[field]}-changed` })
      expect(changed.hash).not.toBe(base.hash)
    }
  })
})

describe("computeRunnerSourceHash", () => {
  test("changes when a source file's content changes and is stable when nothing changes", async () => {
    await withTempDir(async (root) => {
      await mkdir(join(root, "ios", "ProbeFixture", "ProbeFixture"), { recursive: true })
      await mkdir(join(root, "ios", "ProbeFixture", "ProbeFixture.xcodeproj"), { recursive: true })
      await mkdir(join(root, "ios", "ProbeRunner"), { recursive: true })
      await writeFile(join(root, "ios", "ProbeFixture", "ProbeFixture.xcodeproj", "project.pbxproj"), "pbx-v1", "utf8")
      await writeFile(join(root, "ios", "ProbeFixture", "ProbeFixture", "AppDelegate.swift"), "v1", "utf8")
      await writeFile(join(root, "ios", "ProbeRunner", "Tests.swift"), "v1", "utf8")

      const first = await computeRunnerSourceHash(root)
      const again = await computeRunnerSourceHash(root)
      expect(again).toBe(first)

      await writeFile(join(root, "ios", "ProbeFixture", "ProbeFixture", "AppDelegate.swift"), "v2", "utf8")
      const afterEdit = await computeRunnerSourceHash(root)
      expect(afterEdit).not.toBe(first)
    })
  })

  test("resolveRunnerSourceHash memoizes per project root until reset", async () => {
    resetRunnerSourceHashCacheForTests()

    await withTempDir(async (root) => {
      await mkdir(join(root, "ios", "ProbeFixture", "ProbeFixture"), { recursive: true })
      await mkdir(join(root, "ios", "ProbeFixture", "ProbeFixture.xcodeproj"), { recursive: true })
      await mkdir(join(root, "ios", "ProbeRunner"), { recursive: true })
      await writeFile(join(root, "ios", "ProbeFixture", "ProbeFixture.xcodeproj", "project.pbxproj"), "pbx", "utf8")
      await writeFile(join(root, "ios", "ProbeRunner", "Tests.swift"), "v1", "utf8")

      const first = await resolveRunnerSourceHash(root)
      await writeFile(join(root, "ios", "ProbeRunner", "Tests.swift"), "v2", "utf8")
      const stillMemoized = await resolveRunnerSourceHash(root)
      expect(stillMemoized).toBe(first)

      resetRunnerSourceHashCacheForTests()
      const afterReset = await resolveRunnerSourceHash(root)
      expect(afterReset).not.toBe(first)
    })
  })
})

describe("ensureRealDeviceRunnerBuildCached", () => {
  test("first open for a key runs one build; the next ten opens run zero builds", async () => {
    await withTempDir(async (cacheRoot) => {
      const { deps, buildCallCount } = makeFakeDeps()
      const sessionBuildLogPath = join(cacheRoot, "session-1", "build.log")

      const first = await ensureRealDeviceRunnerBuildCached({
        cacheRoot,
        keyInput: baseKeyInput,
        sessionBuildLogPath,
        deps,
      })
      expect(first.status).toBe("miss")
      expect(buildCallCount()).toBe(1)

      for (let i = 0; i < 10; i += 1) {
        const outcome = await ensureRealDeviceRunnerBuildCached({
          cacheRoot,
          keyInput: baseKeyInput,
          sessionBuildLogPath: join(cacheRoot, `session-warm-${i}`, "build.log"),
          deps,
        })
        expect(outcome.status).toBe("hit")
        expect(outcome.buildLogPath).toBeNull()
      }

      expect(buildCallCount()).toBe(1)
    })
  })

  test("concurrent opens for one key coalesce into exactly one build", async () => {
    await withTempDir(async (cacheRoot) => {
      // Promise executors run synchronously, so `releaseBuild` is always
      // assigned before this scope's `await` yields -- the definite
      // assignment assertion avoids TypeScript treating the closure
      // assignment as merely a possible (rather than guaranteed) narrowing.
      let releaseBuild!: () => void
      const gate = new Promise<void>((resolve) => {
        releaseBuild = resolve
      })
      let buildCalls = 0

      const { deps } = makeFakeDeps({
        runBuild: async (args) => {
          buildCalls += 1
          await gate
          const productsRoot = join(args.derivedDataPath, "Build", "Products", "Debug-iphoneos")
          await mkdir(productsRoot, { recursive: true })
          await mkdir(join(productsRoot, "ProbeFixture.app"), { recursive: true })
          await mkdir(join(productsRoot, "ProbeRunnerUITests-Runner.app", "PlugIns", "ProbeRunnerUITests.xctest"), {
            recursive: true,
          })
          await writeFile(join(args.derivedDataPath, "Build", "Products", "test.xctestrun"), "<plist/>", "utf8")
          await writeFile(args.buildLogPath, "build ok\n", "utf8")
          return { exitCode: 0, failureSummary: null }
        },
      })

      const openOne = ensureRealDeviceRunnerBuildCached({
        cacheRoot,
        keyInput: baseKeyInput,
        sessionBuildLogPath: join(cacheRoot, "session-a", "build.log"),
        deps,
      })
      const openTwo = ensureRealDeviceRunnerBuildCached({
        cacheRoot,
        keyInput: baseKeyInput,
        sessionBuildLogPath: join(cacheRoot, "session-b", "build.log"),
        deps,
      })

      // Give both callers a chance to reach the coalescing map before releasing the build.
      await new Promise((resolve) => setTimeout(resolve, 20))
      releaseBuild()

      const [resultOne, resultTwo] = await Promise.all([openOne, openTwo])
      expect(buildCalls).toBe(1)
      expect([resultOne.status, resultTwo.status].sort()).toEqual(["coalesced", "miss"])
    })
  })

  test("a failed build never publishes a reusable entry, and the next open retries the build", async () => {
    await withTempDir(async (cacheRoot) => {
      let attempt = 0
      const { deps } = makeFakeDeps({
        runBuild: async ({ buildLogPath }) => {
          attempt += 1
          await mkdir(join(buildLogPath, ".."), { recursive: true })
          await writeFile(buildLogPath, "signing error\n", "utf8")
          return { exitCode: 65, failureSummary: "Signing for \"ProbeFixture\" requires a development team." }
        },
      })

      await expect(
        ensureRealDeviceRunnerBuildCached({
          cacheRoot,
          keyInput: baseKeyInput,
          sessionBuildLogPath: join(cacheRoot, "session-1", "build.log"),
          deps,
        }),
      ).rejects.toThrow(/build-for-testing failed/)

      expect(attempt).toBe(1)

      const entries = await readdir(cacheRoot).catch(() => [])
      const leftoverBuildingDirs = entries.filter((entry) => entry.includes(".building-"))
      expect(leftoverBuildingDirs).toEqual([])

      // Retrying with the same key attempts a fresh build rather than reusing anything.
      await expect(
        ensureRealDeviceRunnerBuildCached({
          cacheRoot,
          keyInput: baseKeyInput,
          sessionBuildLogPath: join(cacheRoot, "session-2", "build.log"),
          deps,
        }),
      ).rejects.toThrow(/build-for-testing failed/)
      expect(attempt).toBe(2)
    })
  })

  test("an expired cached profile is invalidated and rebuilt with a recorded invalidation reason", async () => {
    await withTempDir(async (cacheRoot) => {
      // Revalidation compares the *stored* entry's profile expiry against
      // `now()` -- it never re-derives expiry from a fresh verify call for an
      // unchanged file -- so this advances the fake clock past the profile's
      // recorded expiry instead of varying `verifyProduct`'s output.
      let currentTime = new Date("2026-01-01T00:00:00.000Z")
      const { deps, buildCallCount } = makeFakeDeps({
        now: () => currentTime,
        verifyProduct: async () => validSignature({ profileExpiresAt: "2026-01-02T00:00:00.000Z" }),
      })

      await ensureRealDeviceRunnerBuildCached({
        cacheRoot,
        keyInput: baseKeyInput,
        sessionBuildLogPath: join(cacheRoot, "session-1", "build.log"),
        deps,
      })
      expect(buildCallCount()).toBe(1)

      currentTime = new Date("2026-01-03T00:00:00.000Z")

      const second = await ensureRealDeviceRunnerBuildCached({
        cacheRoot,
        keyInput: baseKeyInput,
        sessionBuildLogPath: join(cacheRoot, "session-2", "build.log"),
        deps,
      })

      expect(second.status).toBe("miss")
      expect(second.invalidationReason).toMatch(/expired/)
      expect(buildCallCount()).toBe(2)
    })
  })

  test("a tampered cached signature is invalidated and rebuilt", async () => {
    await withTempDir(async (cacheRoot) => {
      let verifyCallIndex = 0
      const { deps, buildCallCount } = makeFakeDeps({
        verifyProduct: async () => {
          verifyCallIndex += 1
          // Calls 1-2 are the initial build's own target/runner validation
          // (must succeed so the entry publishes). Call 3 is the *target*
          // app check inside revalidation on the second open -- returning
          // tampered there short-circuits revalidation before it reaches the
          // runner check, so this must go back to valid afterward or the
          // rebuild triggered by the invalidation would itself fail.
          if (verifyCallIndex === 3) {
            return {
              signed: false,
              signingIdentity: null,
              profileIdentity: null,
              profileExpiresAt: null,
              reason: "codesign --verify failed",
            }
          }
          return validSignature()
        },
      })

      await ensureRealDeviceRunnerBuildCached({
        cacheRoot,
        keyInput: baseKeyInput,
        sessionBuildLogPath: join(cacheRoot, "session-1", "build.log"),
        deps,
      })

      const second = await ensureRealDeviceRunnerBuildCached({
        cacheRoot,
        keyInput: baseKeyInput,
        sessionBuildLogPath: join(cacheRoot, "session-2", "build.log"),
        deps,
      })

      expect(second.status).toBe("miss")
      expect(second.invalidationReason).toBe("codesign --verify failed")
      expect(buildCallCount()).toBe(2)
    })
  })

  test("a cached product deleted out from under the cache (e.g. derived-data pruned by hand) is invalidated and rebuilt", async () => {
    await withTempDir(async (cacheRoot) => {
      const { deps, buildCallCount } = makeFakeDeps()
      const key = computeRunnerBuildCacheKey(baseKeyInput)

      const first = await ensureRealDeviceRunnerBuildCached({
        cacheRoot,
        keyInput: baseKeyInput,
        sessionBuildLogPath: join(cacheRoot, "session-1", "build.log"),
        deps,
      })
      expect(buildCallCount()).toBe(1)

      // Simulate an operator (or another tool) deleting the published
      // target app out from under the cache entry directly on disk.
      await rm(first.products.targetAppPath, { recursive: true, force: true })
      expect(await readFile(join(cacheRoot, key.hash, "entry.json"), "utf8")).toBeTruthy()

      const second = await ensureRealDeviceRunnerBuildCached({
        cacheRoot,
        keyInput: baseKeyInput,
        sessionBuildLogPath: join(cacheRoot, "session-2", "build.log"),
        deps,
      })

      expect(second.status).toBe("miss")
      expect(second.invalidationReason).toContain("target app is missing")
      expect(buildCallCount()).toBe(2)
    })
  })

  test("different keys (e.g. a different team) get independent cache entries", async () => {
    await withTempDir(async (cacheRoot) => {
      const { deps, buildCallCount } = makeFakeDeps()

      await ensureRealDeviceRunnerBuildCached({
        cacheRoot,
        keyInput: baseKeyInput,
        sessionBuildLogPath: join(cacheRoot, "session-1", "build.log"),
        deps,
      })
      await ensureRealDeviceRunnerBuildCached({
        cacheRoot,
        keyInput: { ...baseKeyInput, developmentTeam: "OTHERTEAM99" },
        sessionBuildLogPath: join(cacheRoot, "session-2", "build.log"),
        deps,
      })

      expect(buildCallCount()).toBe(2)
    })
  })

  test("a lost publish race falls back to the already-published winner instead of failing", async () => {
    await withTempDir(async (cacheRoot) => {
      const key = computeRunnerBuildCacheKey(baseKeyInput)
      const entryDir = join(cacheRoot, key.hash)

      const { deps: racingDeps } = makeFakeDeps({
        runBuild: async (args) => {
          // Simulate a concurrent process publishing the same key first.
          await mkdir(join(entryDir, "derived-data"), { recursive: true })
          await writeFile(
            join(entryDir, "entry.json"),
            JSON.stringify({
              key: baseKeyInput,
              builtAt: new Date().toISOString(),
              products: {
                xctestrunPath: join(entryDir, "derived-data", "test.xctestrun"),
                targetAppPath: join(entryDir, "derived-data", "ProbeFixture.app"),
                runnerAppPath: join(entryDir, "derived-data", "Runner.app"),
                runnerXctestPath: join(entryDir, "derived-data", "Runner.app", "PlugIns", "ProbeRunnerUITests.xctest"),
              },
              signingIdentity: "winner-identity",
              profileIdentity: "winner-profile",
              profileExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            "utf8",
          )

          const productsRoot = join(args.derivedDataPath, "Build", "Products", "Debug-iphoneos")
          await mkdir(productsRoot, { recursive: true })
          await mkdir(join(productsRoot, "ProbeFixture.app"), { recursive: true })
          await mkdir(join(productsRoot, "ProbeRunnerUITests-Runner.app", "PlugIns", "ProbeRunnerUITests.xctest"), {
            recursive: true,
          })
          await writeFile(join(args.derivedDataPath, "Build", "Products", "test.xctestrun"), "<plist/>", "utf8")
          await writeFile(args.buildLogPath, "build ok\n", "utf8")
          return { exitCode: 0, failureSummary: null }
        },
      })

      const result = await ensureRealDeviceRunnerBuildCached({
        cacheRoot,
        keyInput: baseKeyInput,
        sessionBuildLogPath: join(cacheRoot, "session-1", "build.log"),
        deps: racingDeps,
      })

      expect(result.signingIdentity).toBe("winner-identity")
      const remaining = await readdir(cacheRoot)
      expect(remaining.filter((entry) => entry.includes(".building-"))).toEqual([])
    })
  })
})
