import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clampExportFileToBudget } from "./PerfService"

const sampleExport = `<?xml version="1.0"?>
<trace-query-result>
  <node>
    <schema name="metal-gpu-intervals">
      <col><mnemonic>start</mnemonic></col>
      <col><mnemonic>duration</mnemonic></col>
    </schema>
    <row><start-time>0</start-time><duration>1</duration></row>
    <row><start-time>2</start-time><duration>3</duration></row>
    <row><start-time>4</start-time><duration>5</duration></row>
  </node>
</trace-query-result>
`

describe("clampExportFileToBudget", () => {
  test("returns untruncated when under budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "probe-clamp-"))
    const path = join(dir, "export.xml")
    await writeFile(path, sampleExport, "utf8")

    const result = await clampExportFileToBudget({
      outputPath: path,
      maxBytes: 10 * 1024 * 1024,
    })

    expect(result).not.toBeNull()
    expect(result!.truncated).toBe(false)
    expect(result!.rowCount).toBe(3)
  })

  test("cuts after the last complete row that fits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "probe-clamp-"))
    const path = join(dir, "export.xml")
    await writeFile(path, sampleExport, "utf8")
    // End of second complete </row> is a known in-bounds cut.
    const secondRowEnd = sampleExport.indexOf("</row>", sampleExport.indexOf("</row>") + 1) + "</row>".length
    const result = await clampExportFileToBudget({
      outputPath: path,
      maxBytes: secondRowEnd,
    })

    expect(result).not.toBeNull()
    // File size equals budget → treated as exact fit (truncated false is OK);
    // force oversize by 1 byte on a longer budget window:
    await writeFile(path, sampleExport, "utf8")
    const oversize = await clampExportFileToBudget({
      outputPath: path,
      maxBytes: secondRowEnd - 1,
    })
    expect(oversize).not.toBeNull()
    expect(oversize!.truncated).toBe(true)
    expect(oversize!.rowCount).toBe(1)
    const clamped = await readFile(path, "utf8")
    expect(clamped.endsWith("</row>")).toBe(true)
    expect(clamped.match(/<row>/g)?.length).toBe(1)
  })

  test("returns null when no complete row fits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "probe-clamp-"))
    const path = join(dir, "export.xml")
    await writeFile(path, "<?xml version=\"1.0\"?><trace-query-result><row>partial", "utf8")

    const result = await clampExportFileToBudget({
      outputPath: path,
      maxBytes: 40,
    })

    expect(result).toBeNull()
  })
})
