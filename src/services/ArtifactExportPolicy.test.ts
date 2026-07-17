import { describe, expect, test } from "bun:test"
import { Readable, Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { ExportBudgetExceededError, ExportBudgetTransform } from "./ArtifactExportPolicy"

// Unit coverage of the policy itself, decoupled from PerfService and from any
// real process spawn -- the coordinator this policy moved into (PRB-085 gate
// 12) should be testable on its own, not only indirectly through a wrapper's
// end-to-end export pipeline.

const collect = async (chunks: ReadonlyArray<string>, guard: ExportBudgetTransform): Promise<string> => {
  const collected: Array<Buffer> = []

  await pipeline(
    Readable.from(chunks),
    guard,
    new Writable({
      write(chunk, _encoding, callback) {
        collected.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        callback()
      },
    }),
  )

  return Buffer.concat(collected).toString("utf8")
}

describe("ArtifactExportPolicy", () => {
  test("passes chunks through and counts bytes/rows while under budget", async () => {
    const guard = new ExportBudgetTransform({ maxBytes: 1024, maxRows: 10 })
    const output = await collect(["<row>a</row>", "<row>b</row><row>c</row>"], guard)

    expect(output).toBe("<row>a</row><row>b</row><row>c</row>")
    expect(guard.rowCount).toBe(3)
    expect(guard.bytesWritten).toBe(Buffer.byteLength(output, "utf8"))
    expect(guard.exceededError).toBeNull()
  })

  test("counts a <row> tag split across chunk boundaries exactly once", async () => {
    const guard = new ExportBudgetTransform({ maxBytes: 1024, maxRows: 10 })
    // Split the tag itself across two chunks -- the trailing-buffer carryover
    // is what prevents this from being missed or double-counted.
    await collect(["<ro", "w>a</row>"], guard)

    expect(guard.rowCount).toBe(1)
  })

  test("fails the stream and records a bytes-exceeded error once the byte budget is crossed", async () => {
    const guard = new ExportBudgetTransform({ maxBytes: 4, maxRows: 100 })

    await expect(collect(["<row>a</row>"], guard)).rejects.toBeInstanceOf(ExportBudgetExceededError)
    expect(guard.exceededError?.kind).toBe("bytes")
    expect(guard.exceededError?.limit).toBe(4)
  })

  test("fails the stream and records a rows-exceeded error once the row budget is crossed", async () => {
    const guard = new ExportBudgetTransform({ maxBytes: 1024, maxRows: 1 })

    await expect(collect(["<row>a</row><row>b</row>"], guard)).rejects.toBeInstanceOf(ExportBudgetExceededError)
    expect(guard.exceededError?.kind).toBe("rows")
    expect(guard.exceededError?.limit).toBe(1)
    expect(guard.exceededError?.observed).toBe(2)
  })

  test("ExportBudgetExceededError formats a human-readable message for each kind", () => {
    const bytes = new ExportBudgetExceededError({ kind: "bytes", limit: 2 * 1024 * 1024, observed: 3 * 1024 * 1024 })
    const rows = new ExportBudgetExceededError({ kind: "rows", limit: 20_000, observed: 20_500 })

    expect(bytes.message).toBe("Export exceeded 2.0 MiB.")
    expect(rows.message).toBe("Export exceeded 20000 rows.")
  })
})
