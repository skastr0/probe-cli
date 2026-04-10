import { describe, expect, test } from "bun:test"
import { countLines, shouldInlineOutput } from "./output"

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
})
