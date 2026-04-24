import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ArtifactRecord, countLines, shouldInlineOutput } from "./output"

describe("output policy", () => {
  test("auto mode keeps small payloads inline", () => {
    expect(
      shouldInlineOutput(
        "auto",
        { maxInlineBytes: 64, maxInlineLines: 4 },
        "hello\nworld",
      ),
    ).toBe(true)
  })

  test("auto mode offloads oversized payloads", () => {
    expect(
      shouldInlineOutput(
        "auto",
        { maxInlineBytes: 10, maxInlineLines: 2 },
        "this payload is larger than the inline threshold",
      ),
    ).toBe(false)
  })

  test("countLines handles empty input", () => {
    expect(countLines("")).toBe(0)
  })

  test("artifact records expose compact machine-inspectable metadata", () => {
    const artifact = Schema.decodeUnknownSync(ArtifactRecord)({
      key: "snapshot.latest",
      label: "latest snapshot",
      kind: "json",
      summary: "Captured snapshot.",
      absolutePath: "/tmp/probe/snapshot.json",
      relativePath: "sessions/session-1/snapshot.json",
      sizeBytes: 128,
      external: false,
      createdAt: "2026-04-24T12:00:00.000Z",
    })

    expect(artifact.key).toBe("snapshot.latest")
    expect(artifact.kind).toBe("json")
    expect(artifact.absolutePath).toBe("/tmp/probe/snapshot.json")
    expect(artifact.sizeBytes).toBe(128)
    expect(artifact.createdAt).toBe("2026-04-24T12:00:00.000Z")
  })
})
