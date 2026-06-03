#!/usr/bin/env bun

import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { probeRuntimeAssetManifest } from "../src/generated/runtimeAssets"

interface PackageJson {
  readonly version?: string
}

interface PackageTarget {
  readonly directory: string
  readonly packageName: string
  readonly tarballName: string
}

const rootPackageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson
const version = rootPackageJson.version ?? "0.0.0"

const packageTargets: readonly PackageTarget[] = [
  {
    directory: "packages/probe-darwin-arm64",
    packageName: "@skastr0/probe-darwin-arm64",
    tarballName: `skastr0-probe-darwin-arm64-${version}.tgz`,
  },
  {
    directory: "packages/probe-darwin-x64",
    packageName: "@skastr0/probe-darwin-x64",
    tarballName: `skastr0-probe-darwin-x64-${version}.tgz`,
  },
  {
    directory: "packages/probe",
    packageName: "@skastr0/probe",
    tarballName: `skastr0-probe-${version}.tgz`,
  },
]

const platformPackages: Record<string, PackageTarget> = {
  "darwin-arm64": packageTargets[0]!,
  "darwin-x64": packageTargets[1]!,
}

const run = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string
    readonly env?: NodeJS.ProcessEnv
  } = {},
): string => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })

  if (result.status !== 0) {
    process.stderr.write(result.stdout)
    process.stderr.write(result.stderr)
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`)
  }

  return result.stdout
}

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertNoRuntimeUserState = (rootPath: string) => {
  const visit = (path: string) => {
    const stats = statSync(path)

    if (stats.isDirectory()) {
      assert(!path.includes("xcuserdata"), `Runtime assets include xcuserdata: ${path}`)

      for (const entry of readdirSync(path)) {
        visit(join(path, entry))
      }

      return
    }

    assert(!path.endsWith(".xcuserstate"), `Runtime assets include xcuserstate: ${path}`)
  }

  visit(rootPath)
}

const hostPlatformKey = `${process.platform}-${process.arch}`
const hostPlatformPackage = platformPackages[hostPlatformKey]

assert(
  Boolean(hostPlatformPackage),
  `Probe npm validation only supports darwin arm64/x64 hosts today; got ${hostPlatformKey}.`,
)

assert(
  probeRuntimeAssetManifest.packageVersion === version,
  `Runtime asset manifest version ${probeRuntimeAssetManifest.packageVersion} does not match package version ${version}.`,
)

console.log(`Validating Probe npm packages for ${version} on ${hostPlatformKey}...`)

for (const target of packageTargets) {
  console.log(`Dry-running ${target.packageName}...`)
  run("npm", ["pack", "--dry-run", `./${target.directory}`])
}

const workDir = mkdtempSync(join(tmpdir(), "probe-npm-validate-"))
const runtimeCacheRoot = join(workDir, "runtime")

for (const target of packageTargets) {
  console.log(`Packing ${target.packageName}...`)
  run("npm", ["pack", `./${target.directory}`, "--pack-destination", workDir])
}

run("npm", ["init", "-y"], { cwd: workDir })
run(
  "npm",
  [
    "install",
    "--no-audit",
    "--no-fund",
    join(workDir, hostPlatformPackage!.tarballName),
    join(workDir, packageTargets[2]!.tarballName),
  ],
  { cwd: workDir },
)

const installedVersion = run("./node_modules/.bin/probe", ["--version"], { cwd: workDir }).trim()
assert(installedVersion === version, `Installed probe reported ${installedVersion}, expected ${version}.`)

const doctorJson = run("./node_modules/.bin/probe", ["doctor", "--output-json"], {
  cwd: workDir,
  env: {
    ...process.env,
    PROBE_RUNTIME_CACHE_ROOT: runtimeCacheRoot,
  },
})
const doctor = JSON.parse(doctorJson) as {
  readonly commands?: readonly string[]
  readonly diagnostics?: readonly unknown[]
}

assert(Array.isArray(doctor.commands), "probe doctor did not return a commands array.")
assert(Array.isArray(doctor.diagnostics), "probe doctor did not return diagnostics.")

const runtimeRoot = join(
  runtimeCacheRoot,
  version,
  probeRuntimeAssetManifest.assetHash,
)
const materializedManifestPath = join(runtimeRoot, ".probe-runtime-assets.json")
const materializedManifest = JSON.parse(readFileSync(materializedManifestPath, "utf8")) as {
  readonly packageVersion?: string
  readonly assetHash?: string
}

assert(materializedManifest.packageVersion === version, "Materialized runtime manifest has the wrong version.")
assert(
  materializedManifest.assetHash === probeRuntimeAssetManifest.assetHash,
  "Materialized runtime manifest has the wrong asset hash.",
)
assertNoRuntimeUserState(runtimeRoot)

const npxVersion = run(
  "npx",
  [
    "-y",
    "--package",
    join(workDir, hostPlatformPackage!.tarballName),
    "--package",
    join(workDir, packageTargets[2]!.tarballName),
    "probe",
    "--version",
  ],
  { cwd: workDir },
).trim()

assert(npxVersion === version, `npx probe reported ${npxVersion}, expected ${version}.`)

console.log(`Validated Probe npm packages in ${workDir}.`)
