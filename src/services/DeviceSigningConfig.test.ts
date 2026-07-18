import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  developmentTeamEnvKey,
  readPersistedDeviceSigningConfig,
  resolveDevelopmentTeam,
  resolveDevelopmentTeamFromHost,
  resolveProbeConfigPath,
  writePersistedDeviceSigningConfig,
} from "./DeviceSigningConfig"

let scratchRoot: string
let previousConfigRoot: string | undefined
let previousTeamEnv: string | undefined

beforeEach(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), "device-signing-config-"))
  previousConfigRoot = process.env.PROBE_CONFIG_ROOT
  previousTeamEnv = process.env[developmentTeamEnvKey]
  process.env.PROBE_CONFIG_ROOT = scratchRoot
})

afterEach(async () => {
  if (previousConfigRoot === undefined) {
    delete process.env.PROBE_CONFIG_ROOT
  } else {
    process.env.PROBE_CONFIG_ROOT = previousConfigRoot
  }

  if (previousTeamEnv === undefined) {
    delete process.env[developmentTeamEnvKey]
  } else {
    process.env[developmentTeamEnvKey] = previousTeamEnv
  }

  await rm(scratchRoot, { force: true, recursive: true })
})

describe("resolveDevelopmentTeam", () => {
  test("prefers explicit payload over persisted config and environment", () => {
    const resolved = resolveDevelopmentTeam({
      explicitTeamId: "EXPLICIT1",
      persistedTeamId: "PERSISTED1",
      environmentTeamId: "ENV1",
    })
    expect(resolved).toEqual({ developmentTeam: "EXPLICIT1", source: "explicit-payload" })
  })

  test("prefers persisted config over environment when no explicit payload is given", () => {
    const resolved = resolveDevelopmentTeam({
      explicitTeamId: null,
      persistedTeamId: "PERSISTED1",
      environmentTeamId: "ENV1",
    })
    expect(resolved).toEqual({ developmentTeam: "PERSISTED1", source: "persisted-config" })
  })

  test("falls back to environment when neither explicit nor persisted are set", () => {
    const resolved = resolveDevelopmentTeam({
      explicitTeamId: null,
      persistedTeamId: null,
      environmentTeamId: "ENV1",
    })
    expect(resolved).toEqual({ developmentTeam: "ENV1", source: "environment" })
  })

  test("treats blank/whitespace-only values as absent at every tier", () => {
    const resolved = resolveDevelopmentTeam({
      explicitTeamId: "   ",
      persistedTeamId: "",
      environmentTeamId: "  ENV1  ",
    })
    expect(resolved).toEqual({ developmentTeam: "ENV1", source: "environment" })
  })

  test("returns null when no tier supplies a value", () => {
    expect(resolveDevelopmentTeam({ explicitTeamId: null, persistedTeamId: null, environmentTeamId: null })).toBeNull()
  })
})

describe("persisted device signing config (file-backed)", () => {
  test("reads back a written team id, scoped to PROBE_CONFIG_ROOT", async () => {
    await writePersistedDeviceSigningConfig({ developmentTeam: "TEAMID1234" })
    const persisted = await readPersistedDeviceSigningConfig()
    expect(persisted).toEqual({ developmentTeam: "TEAMID1234" })
  })

  test("clearing (developmentTeam: null) round-trips to null", async () => {
    await writePersistedDeviceSigningConfig({ developmentTeam: "TEAMID1234" })
    await writePersistedDeviceSigningConfig({ developmentTeam: null })
    const persisted = await readPersistedDeviceSigningConfig()
    expect(persisted).toEqual({ developmentTeam: null })
  })

  test("a missing config file resolves to no persisted team instead of throwing", async () => {
    const persisted = await readPersistedDeviceSigningConfig()
    expect(persisted).toEqual({ developmentTeam: null })
  })

  test("a corrupt config file degrades to no persisted team instead of throwing", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises")
    const { dirname } = await import("node:path")
    const configPath = resolveProbeConfigPath()
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, "{not valid json", "utf8")

    const persisted = await readPersistedDeviceSigningConfig()
    expect(persisted).toEqual({ developmentTeam: null })
  })

  test("preserves unrelated top-level config keys already on disk", async () => {
    const { mkdir, writeFile, readFile } = await import("node:fs/promises")
    const { dirname } = await import("node:path")
    const configPath = resolveProbeConfigPath()
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, `${JSON.stringify({ unrelated: { keep: true } })}\n`, "utf8")

    await writePersistedDeviceSigningConfig({ developmentTeam: "TEAMID1234" })

    const raw = JSON.parse(await readFile(configPath, "utf8")) as { unrelated?: { keep?: boolean } }
    expect(raw.unrelated).toEqual({ keep: true })
  })
})

describe("resolveDevelopmentTeamFromHost", () => {
  test("resolves against the persisted config when no explicit id is passed", async () => {
    await writePersistedDeviceSigningConfig({ developmentTeam: "PERSISTEDHOST" })
    delete process.env[developmentTeamEnvKey]

    const resolved = await resolveDevelopmentTeamFromHost(null)
    expect(resolved).toEqual({ developmentTeam: "PERSISTEDHOST", source: "persisted-config" })
  })

  test("an explicit id still wins over a persisted default", async () => {
    await writePersistedDeviceSigningConfig({ developmentTeam: "PERSISTEDHOST" })

    const resolved = await resolveDevelopmentTeamFromHost("EXPLICITHOST")
    expect(resolved).toEqual({ developmentTeam: "EXPLICITHOST", source: "explicit-payload" })
  })
})
