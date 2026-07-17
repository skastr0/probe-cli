import { spawnSync } from "node:child_process"
import { arch, platform } from "node:os"
import type { Provenance } from "./schema"

const runGit = (args: ReadonlyArray<string>): string | null => {
  const result = spawnSync("git", args, { encoding: "utf8" })

  if (result.status !== 0) {
    return null
  }

  return result.stdout.trim()
}

const readXcodeVersion = (): string | null => {
  const result = spawnSync("xcodebuild", ["-version"], { encoding: "utf8" })

  if (result.status !== 0) {
    return null
  }

  return result.stdout.trim().split("\n")[0] ?? null
}

export const captureProvenance = (): Provenance => {
  const gitSha = runGit(["rev-parse", "HEAD"]) ?? "unknown"
  const gitBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "unknown"
  const gitDirty = (runGit(["status", "--porcelain"]) ?? "").length > 0

  return {
    generatedAt: new Date().toISOString(),
    gitSha,
    gitBranch,
    gitDirty,
    host: {
      platform: platform(),
      arch: arch(),
      bunVersion: Bun.version,
      xcodeVersion: readXcodeVersion(),
    },
  }
}
