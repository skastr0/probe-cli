import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const probeRootPath = join(homedir(), ".probe")
export const probeRunnerCacheRootPath = join(probeRootPath, "runner")
export const probeRunnerSimulatorDerivedRootPath = join(probeRunnerCacheRootPath, "simulator", "derived")
export const probeRunnerDeviceDerivedRootPath = join(probeRunnerCacheRootPath, "device", "derived")

export function findProjectRoot(): string {
  const start = dirname(fileURLToPath(import.meta.url))
  let current = start

  for (let i = 0; i < 10; i += 1) {
    const pkgPath = join(current, "package.json")

    if (existsSync(pkgPath)) {
      return current
    }

    current = dirname(current)
  }

  return start
}

export const resolveProbeFixtureProjectPath = (projectRoot: string): string =>
  join(projectRoot, "ios", "ProbeFixture", "ProbeFixture.xcodeproj")

export const resolveProbeRunnerWrapperScriptPath = (projectRoot: string): string =>
  join(projectRoot, "ios", "ProbeRunner", "scripts", "run-transport-boundary-session.py")
