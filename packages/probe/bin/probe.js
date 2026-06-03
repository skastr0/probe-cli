#!/usr/bin/env node

"use strict"

const { spawnSync } = require("node:child_process")

const platformPackages = {
  "darwin-arm64": "@skastr0/probe-darwin-arm64",
  "darwin-x64": "@skastr0/probe-darwin-x64",
}

const platformKey = `${process.platform}-${process.arch}`
const packageName = platformPackages[platformKey]

if (!packageName) {
  console.error(`Probe does not provide a native binary for ${platformKey}.`)
  process.exit(1)
}

let binaryPath
try {
  binaryPath = require.resolve(`${packageName}/bin/probe`)
} catch {
  console.error(`Probe could not find ${packageName}. Reinstall @skastr0/probe and retry.`)
  process.exit(1)
}

const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

if (result.signal) {
  console.error(`Probe exited after receiving ${result.signal}.`)
  process.exit(1)
}

process.exit(result.status ?? 1)
