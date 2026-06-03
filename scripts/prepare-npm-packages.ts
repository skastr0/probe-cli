#!/usr/bin/env bun

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const rootPackageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  readonly version?: string
  readonly repository?: {
    readonly type?: string
    readonly url?: string
  }
  readonly homepage?: string
  readonly bugs?: {
    readonly url?: string
  }
}

const version = rootPackageJson.version ?? "0.0.0"
const repository = rootPackageJson.repository ?? {
  type: "git",
  url: "git+https://github.com/skastr0/probe.git",
}
const homepage = rootPackageJson.homepage ?? "https://github.com/skastr0/probe#readme"
const bugs = rootPackageJson.bugs ?? { url: "https://github.com/skastr0/probe/issues" }

const writeJson = (path: string, value: unknown) => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

const ensureExecutable = (path: string) => {
  chmodSync(path, 0o755)
}

const stageLicense = (packageDir: string) => {
  copyFileSync("LICENSE", join(packageDir, "LICENSE"))
}

const stagePlatformPackage = (args: {
  readonly packageDir: string
  readonly packageName: string
  readonly cpu: "arm64" | "x64"
  readonly binarySource: string
}) => {
  if (!existsSync(args.binarySource)) {
    throw new Error(`Missing native binary ${args.binarySource}. Run bun run build:native first.`)
  }

  const binaryDestination = join(args.packageDir, "bin", "probe")
  mkdirSync(dirname(binaryDestination), { recursive: true })
  copyFileSync(args.binarySource, binaryDestination)
  ensureExecutable(binaryDestination)
  stageLicense(args.packageDir)

  writeJson(join(args.packageDir, "package.json"), {
    name: args.packageName,
    version,
    description: "Native Probe CLI binary for macOS.",
    license: "MIT",
    repository: {
      ...repository,
      directory: args.packageDir,
    },
    homepage,
    bugs,
    os: ["darwin"],
    cpu: [args.cpu],
    files: [
      "bin/probe",
      "README.md",
      "LICENSE",
    ],
    publishConfig: {
      access: "public",
    },
  })
}

const stageMainPackage = () => {
  const packageDir = join("packages", "probe")
  stageLicense(packageDir)
  ensureExecutable(join(packageDir, "bin", "probe.js"))

  writeJson(join(packageDir, "package.json"), {
    name: "@skastr0/probe",
    version,
    description: "iOS app inspection and automation CLI for development workflows.",
    license: "MIT",
    repository: {
      ...repository,
      directory: packageDir,
    },
    homepage,
    bugs,
    type: "commonjs",
    bin: {
      probe: "bin/probe.js",
    },
    optionalDependencies: {
      "@skastr0/probe-darwin-arm64": version,
      "@skastr0/probe-darwin-x64": version,
    },
    files: [
      "bin/probe.js",
      "README.md",
      "LICENSE",
    ],
    publishConfig: {
      access: "public",
    },
  })
}

stagePlatformPackage({
  packageDir: join("packages", "probe-darwin-arm64"),
  packageName: "@skastr0/probe-darwin-arm64",
  cpu: "arm64",
  binarySource: join("dist", "native", "probe-darwin-arm64", "probe"),
})

stagePlatformPackage({
  packageDir: join("packages", "probe-darwin-x64"),
  packageName: "@skastr0/probe-darwin-x64",
  cpu: "x64",
  binarySource: join("dist", "native", "probe-darwin-x64", "probe"),
})

stageMainPackage()

console.log(`Prepared npm package staging directories for Probe ${version}.`)
