import { describe, expect, test } from "bun:test"
import { captureProvenance } from "./provenance"

describe("captureProvenance", () => {
  test("captures a plausible git sha, branch, and host shape", () => {
    const provenance = captureProvenance()

    expect(provenance.gitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(provenance.gitBranch.length).toBeGreaterThan(0)
    expect(typeof provenance.gitDirty).toBe("boolean")
    expect(provenance.host.platform.length).toBeGreaterThan(0)
    expect(provenance.host.bunVersion.length).toBeGreaterThan(0)
    expect(() => new Date(provenance.generatedAt).toISOString()).not.toThrow()
  })
})
