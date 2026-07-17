import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { materializeRuntimeAssets, probeRuntimeAssetHash, probeVersion } from "./RuntimeAssets"

export const probeRootPath = join(homedir(), ".probe")
export const probeRunnerCacheRootPath = join(probeRootPath, "runner")
export const probeRunnerSimulatorDerivedRootPath = join(probeRunnerCacheRootPath, "simulator", "derived")
// PRB-095: real-device runner products are no longer built into one fixed
// directory (that shape had no discriminator for *which* signing input
// produced the products on disk, so it could not tell a stale build from a
// fresh one). Each distinct build/signing key gets its own subdirectory
// under this root instead -- see `RunnerBuildCache`.
export const probeRunnerDeviceSignedCacheRootPath = join(probeRunnerCacheRootPath, "device", "signed-cache")

export interface ProbeRuntimeRootInfo {
  readonly kind: "source" | "materialized" | "override"
  readonly rootPath: string
  readonly packageVersion: string
  readonly assetHash: string | null
}

const hasProbeRuntimeAssets = (rootPath: string): boolean =>
  existsSync(resolveProbeFixtureProjectPath(rootPath))
  && existsSync(resolveProbeRunnerWrapperScriptPath(rootPath))
  && existsSync(resolveProbeLldbBridgeScriptPath(rootPath))

export function findSourceProjectRoot(): string | null {
  const start = dirname(fileURLToPath(import.meta.url))
  let current = start

  for (let i = 0; i < 10; i += 1) {
    const pkgPath = join(current, "package.json")

    if (existsSync(pkgPath) && hasProbeRuntimeAssets(current)) {
      return current
    }

    current = dirname(current)
  }

  return null
}

export const resolveProbeFixtureProjectPath = (projectRoot: string): string =>
  join(projectRoot, "ios", "ProbeFixture", "ProbeFixture.xcodeproj")

export const resolveProbeRunnerWrapperScriptPath = (projectRoot: string): string =>
  join(projectRoot, "ios", "ProbeRunner", "scripts", "run-transport-boundary-session.py")

export const resolveProbeLldbBridgeScriptPath = (projectRoot: string): string =>
  join(projectRoot, "src", "bridge", "lldb-python", "bridge.py")

export function resolveProbeRuntimeRootInfo(): ProbeRuntimeRootInfo {
  const overrideRoot = process.env.PROBE_RUNTIME_ROOT

  if (overrideRoot) {
    return {
      kind: "override",
      rootPath: overrideRoot,
      packageVersion: probeVersion,
      assetHash: null,
    }
  }

  const sourceRoot = findSourceProjectRoot()

  if (sourceRoot) {
    return {
      kind: "source",
      rootPath: sourceRoot,
      packageVersion: probeVersion,
      assetHash: probeRuntimeAssetHash,
    }
  }

  const materialized = materializeRuntimeAssets()
  return {
    kind: "materialized",
    rootPath: materialized.rootPath,
    packageVersion: materialized.packageVersion,
    assetHash: materialized.assetHash,
  }
}

export const resolveProbeRuntimeRoot = (): string =>
  resolveProbeRuntimeRootInfo().rootPath

export function findProjectRoot(): string {
  return resolveProbeRuntimeRoot()
}
