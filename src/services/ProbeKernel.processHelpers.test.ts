import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EnvironmentError } from "../domain/errors"
import { runProbeKernelHostCommand as runHostCommand, runXmllint } from "./ProbeKernel"

// Real, non-mocked coverage of the AppleProcessSupervisor-backed migration.

describe("ProbeKernel process helpers (real spawn, via AppleProcessSupervisor)", () => {
  test("runHostCommand resolves stdout/stderr/exitCode for a real process", async () => {
    const result = await runHostCommand("/bin/sh", ["-c", "echo hi; echo bye 1>&2; exit 2"])
    expect(result.stdout.trim()).toBe("hi")
    expect(result.stderr.trim()).toBe("bye")
    expect(result.exitCode).toBe(2)
  })

  test("runHostCommand rejects with the raw spawn error (ENOENT-detectable) when the binary is missing", async () => {
    const failure = await runHostCommand("/definitely/not/a/real/binary", []).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure && typeof failure === "object" && "code" in failure ? (failure as { code: unknown }).code : undefined)
      .toBe("ENOENT")
  })

  test("runXmllint resolves the xpath match for a real xml document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "probe-kernel-xmllint-"))
    try {
      const xmlPath = join(dir, "doc.xml")
      await writeFile(xmlPath, "<root><child>value</child></root>", "utf8")
      const content = await runXmllint(xmlPath, "string(//child)")
      expect(content.trim()).toBe("value")
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  test("runXmllint rejects with a typed EnvironmentError on a bad xpath", async () => {
    const dir = await mkdtemp(join(tmpdir(), "probe-kernel-xmllint-"))
    try {
      const xmlPath = join(dir, "doc.xml")
      await writeFile(xmlPath, "<root/>", "utf8")
      const failure = await runXmllint(xmlPath, "!!!not-an-xpath!!!").catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(EnvironmentError)
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  })
})
