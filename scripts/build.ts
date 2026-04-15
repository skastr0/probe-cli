#!/usr/bin/env bun

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"

const srcDir = "src"
const distSrcDir = join("dist", "src")
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version?: string }
const version = packageJson.version ?? "0.0.0"

const collectTsFiles = (dir: string): readonly string[] => {
  const entries = readdirSync(dir).sort()
  const files: string[] = []

  for (const entry of entries) {
    const path = join(dir, entry)
    const stats = statSync(path)

    if (stats.isDirectory()) {
      files.push(...collectTsFiles(path))
      continue
    }

    if (stats.isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts")) {
      files.push(path)
    }
  }

  return files
}

console.log("Cleaning dist directory...")
rmSync("dist", { recursive: true, force: true })
mkdirSync(distSrcDir, { recursive: true })

console.log(`\nTranspiling probe v${version} source layout...\n`)

const transpiler = new Bun.Transpiler({ loader: "ts" })
const files = collectTsFiles(srcDir)

for (const sourcePath of files) {
  const relativePath = relative(srcDir, sourcePath)
  const outputPath = join(distSrcDir, relativePath.replace(/\.ts$/, ".js"))
  const source = readFileSync(sourcePath, "utf8")
  const output = transpiler.transformSync(source)

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, output)
}

console.log(`Transpiled ${files.length} files to ${distSrcDir}`)
console.log(`
Build complete.

To install locally:
  bun run install:local

To test the transpiled CLI:
  bun dist/src/cli/main.js --help
`)
