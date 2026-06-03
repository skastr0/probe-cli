import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { probeRuntimeAssetManifest } from "../generated/runtimeAssets"

export interface MaterializedRuntimeAssets {
  readonly rootPath: string
  readonly packageVersion: string
  readonly assetHash: string
  readonly assetCount: number
}

const runtimeCacheRoot = (): string =>
  process.env.PROBE_RUNTIME_CACHE_ROOT ?? join(homedir(), ".probe", "runtime")

const sha256File = (path: string): string | null => {
  if (!existsSync(path)) {
    return null
  }

  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

export const materializeRuntimeAssets = (): MaterializedRuntimeAssets => {
  const rootPath = join(
    runtimeCacheRoot(),
    probeRuntimeAssetManifest.packageVersion,
    probeRuntimeAssetManifest.assetHash,
  )

  for (const asset of probeRuntimeAssetManifest.assets) {
    const outputPath = join(rootPath, asset.path)

    if (sha256File(outputPath) !== asset.sha256) {
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, Buffer.from(asset.dataBase64, "base64"))
      chmodSync(outputPath, asset.mode)
    }
  }

  const manifestPath = join(rootPath, ".probe-runtime-assets.json")
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      packageName: probeRuntimeAssetManifest.packageName,
      packageVersion: probeRuntimeAssetManifest.packageVersion,
      assetHash: probeRuntimeAssetManifest.assetHash,
      assetCount: probeRuntimeAssetManifest.assets.length,
    }, null, 2)}\n`,
  )

  return {
    rootPath,
    packageVersion: probeRuntimeAssetManifest.packageVersion,
    assetHash: probeRuntimeAssetManifest.assetHash,
    assetCount: probeRuntimeAssetManifest.assets.length,
  }
}

export const probePackageName = probeRuntimeAssetManifest.packageName
export const probeVersion = probeRuntimeAssetManifest.packageVersion
export const probeRuntimeAssetHash = probeRuntimeAssetManifest.assetHash
