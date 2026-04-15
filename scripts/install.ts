#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

const BIN_DIR = process.env.INSTALL_DIR || join(homedir(), ".local", "bin")
const INSTALL_ROOT = process.env.PROBE_INSTALL_ROOT || join(homedir(), ".probe", "install")
const BINARY_NAME = "probe"
const DIST_SRC_DIR = join("dist", "src")
const IOS_DIR = "ios"
const ENTRY_POINT = join(INSTALL_ROOT, "dist", "src", "cli", "main.js")

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  readonly name?: string
  readonly version?: string
  readonly type?: string
  readonly dependencies?: Record<string, string>
}

const ensureBuildExists = () => {
  if (!existsSync(join(DIST_SRC_DIR, "cli", "main.js"))) {
    console.error(`Missing transpiled CLI entrypoint: ${join(DIST_SRC_DIR, "cli", "main.js")}`)
    console.error("Run 'bun run build' first.")
    process.exit(1)
  }

  if (!existsSync(IOS_DIR)) {
    console.error(`Missing packaged iOS sources: ${IOS_DIR}`)
    process.exit(1)
  }
}

const shouldCopyIosPath = (source: string): boolean => {
  const name = basename(source)

  if (name === ".DS_Store" || name === ".build" || name === "xcuserdata") {
    return false
  }

  return !source.endsWith(".xcuserstate")
}

const writeProductionPackageJson = () => {
  const productionPackageJson = {
    name: packageJson.name ?? "probe-cli",
    version: packageJson.version ?? "0.0.0",
    private: true,
    type: packageJson.type ?? "module",
    dependencies: packageJson.dependencies ?? {},
  }

  writeFileSync(
    join(INSTALL_ROOT, "package.json"),
    `${JSON.stringify(productionPackageJson, null, 2)}\n`,
  )
}

const installProductionDependencies = () => {
  console.log("Installing production dependencies...")

  const result = spawnSync(process.execPath, ["install", "--production"], {
    cwd: INSTALL_ROOT,
    env: process.env,
    stdio: "inherit",
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

const writeBinShim = () => {
  const destPath = join(BIN_DIR, BINARY_NAME)
  const entryUrl = pathToFileURL(ENTRY_POINT).href
  const script = `#!/usr/bin/env bun

await import(${JSON.stringify(entryUrl)})
`

  mkdirSync(dirname(destPath), { recursive: true })
  writeFileSync(destPath, script)
  chmodSync(destPath, 0o755)

  return destPath
}

const install = () => {
  ensureBuildExists()

  console.log(`Installing package tree to ${INSTALL_ROOT}...`)
  rmSync(INSTALL_ROOT, { recursive: true, force: true })
  mkdirSync(INSTALL_ROOT, { recursive: true })

  cpSync(DIST_SRC_DIR, join(INSTALL_ROOT, "dist", "src"), {
    recursive: true,
    force: true,
  })

  cpSync(IOS_DIR, join(INSTALL_ROOT, IOS_DIR), {
    recursive: true,
    force: true,
    filter: shouldCopyIosPath,
  })

  writeProductionPackageJson()
  installProductionDependencies()

  const binPath = writeBinShim()

  console.log(`\nInstalled ${BINARY_NAME} to ${binPath}`)
  console.log(`Runtime package root: ${INSTALL_ROOT}`)

  const pathDirs = (process.env.PATH || "").split(":")
  if (!pathDirs.includes(BIN_DIR)) {
    console.log(`
Note: ${BIN_DIR} is not in your PATH.
Add it to your shell configuration:

  export PATH="$HOME/.local/bin:$PATH"
`)
  }

  console.log(`\nRun '${BINARY_NAME} doctor --json' to verify the install.`)
}

install()
