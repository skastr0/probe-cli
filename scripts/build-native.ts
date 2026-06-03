#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"

const nativeTargets = [
  {
    target: "bun-darwin-arm64",
    packageName: "probe-darwin-arm64",
  },
  {
    target: "bun-darwin-x64",
    packageName: "probe-darwin-x64",
  },
] as const

const targets = (process.env.PROBE_NATIVE_TARGETS ?? nativeTargets.map((entry) => entry.target).join(","))
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0)

rmSync(join("dist", "native"), { recursive: true, force: true })

for (const entry of nativeTargets) {
  if (!targets.includes(entry.target)) {
    continue
  }

  const outputPath = join("dist", "native", entry.packageName, "probe")
  mkdirSync(dirname(outputPath), { recursive: true })

  const result = spawnSync(
    process.execPath,
    [
      "build",
      "--compile",
      `--target=${entry.target}`,
      "src/cli/main.ts",
      "--outfile",
      outputPath,
    ],
    {
      stdio: "inherit",
    },
  )

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }

  chmodSync(outputPath, 0o755)
  console.log(`Built ${entry.target} -> ${outputPath}`)
}
