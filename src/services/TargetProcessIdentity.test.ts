import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either } from "effect"
import { EnvironmentError } from "../domain/errors"
import { verifyTargetProcessIdentity } from "./TargetProcessIdentity"

// PRB-096: unit coverage of the fresh, pre-spawn target-process identity
// check decoupled from PerfService and from any real process/devicectl call
// -- the same seam AC 1-3 gate raw perf record on.

interface CaptureResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
}

const withTempRoot = async <T>(run: (root: string) => Promise<T>) => {
  const root = await mkdtemp(join(tmpdir(), "probe-target-process-identity-"))

  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const runVerify = (args: Parameters<typeof verifyTargetProcessIdentity>[0]) =>
  Effect.runPromise(Effect.either(verifyTargetProcessIdentity(args)))

describe("TargetProcessIdentity", () => {
  test("verifies a live simulator pid whose comm resolves under the expected device container", async () => {
    const result = await runVerify({
      platform: "simulator",
      deviceId: "sim-1",
      targetProcessId: 123,
      signal: new AbortController().signal,
      capture: async (args) => {
        expect(args.command).toBe("ps")
        expect(args.commandArgs).toEqual(["-p", "123", "-o", "pid=,comm="])
        return {
          stdout: "123  /Users/x/Library/Developer/CoreSimulator/Devices/sim-1/data/.../ProbeFixture.app/ProbeFixture",
          stderr: "",
          exitCode: 0,
        } satisfies CaptureResult
      },
    })

    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.method).toBe("ps")
    }
  })

  test("fails closed with a typed pre-spawn error when ps reports no such process", async () => {
    const result = await runVerify({
      platform: "simulator",
      deviceId: "sim-1",
      targetProcessId: 999,
      signal: new AbortController().signal,
      capture: async () => ({ stdout: "", stderr: "", exitCode: 1 }) satisfies CaptureResult,
    })

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(EnvironmentError)
      expect(result.left.code).toBe("perf-target-process-not-found")
      expect(result.left.reason).toContain("999")
    }
  })

  test("fails closed when the live pid resolves under a different simulator's container (likely pid reuse)", async () => {
    const result = await runVerify({
      platform: "simulator",
      deviceId: "sim-1",
      targetProcessId: 123,
      signal: new AbortController().signal,
      capture: async () => ({
        stdout: "123  /Users/x/Library/Developer/CoreSimulator/Devices/sim-OTHER/data/.../SomeApp.app/SomeApp",
        stderr: "",
        exitCode: 0,
      }) satisfies CaptureResult,
    })

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(EnvironmentError)
      expect(result.left.code).toBe("perf-target-process-not-found")
      expect(result.left.reason).toContain("pid reuse")
    }
  })

  test("fails closed when ps itself fails to run", async () => {
    const result = await runVerify({
      platform: "simulator",
      deviceId: "sim-1",
      targetProcessId: 123,
      signal: new AbortController().signal,
      capture: async () => {
        throw new Error("spawn ps ENOENT")
      },
    })

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("perf-target-process-not-found")
      expect(result.left.reason).toContain("ENOENT")
    }
  })

  test("verifies a live device pid via devicectl's processes JSON output", async () => {
    await withTempRoot(async () => {
      const result = await runVerify({
        platform: "device",
        deviceId: "device-1",
        targetProcessId: 456,
        signal: new AbortController().signal,
        capture: async (args) => {
          expect(args.command).toBe("xcrun")
          expect(args.commandArgs.slice(0, 4)).toEqual(["devicectl", "device", "info", "processes"])

          const outputIndex = args.commandArgs.indexOf("--json-output")
          const outputPath = args.commandArgs[outputIndex + 1]
          if (!outputPath) {
            throw new Error("Missing --json-output path")
          }

          const { writeFile } = await import("node:fs/promises")
          await writeFile(
            outputPath,
            JSON.stringify({
              info: {},
              result: { processes: [{ processIdentifier: 456, executable: "/private/var/.../ProbeFixture" }] },
            }),
            "utf8",
          )

          return { stdout: "", stderr: "", exitCode: 0 } satisfies CaptureResult
        },
      })

      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.method).toBe("devicectl-processes")
      }
    })
  })

  test("fails closed when devicectl reports no matching process", async () => {
    const result = await runVerify({
      platform: "device",
      deviceId: "device-1",
      targetProcessId: 456,
      signal: new AbortController().signal,
      capture: async (args) => {
        const outputIndex = args.commandArgs.indexOf("--json-output")
        const outputPath = args.commandArgs[outputIndex + 1]!
        const { writeFile } = await import("node:fs/promises")
        await writeFile(outputPath, JSON.stringify({ info: {}, result: { processes: [] } }), "utf8")
        return { stdout: "", stderr: "", exitCode: 0 } satisfies CaptureResult
      },
    })

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("perf-target-process-not-found")
      expect(result.left.reason).toContain("456")
    }
  })

  test("fails closed (never claims success) when devicectl itself exits non-zero -- e.g. an unmountable DDI", async () => {
    // Empirically reproduced against a real connected-but-locked device on
    // the implementation host: `xcrun devicectl device info processes`
    // fails before ever producing JSON with "The developer disk image could
    // not be mounted ... device is locked" -- a signing/DDI blocker, not a
    // Probe defect. This proves the code path fails closed on that shape of
    // failure instead of ever fabricating a match.
    const result = await runVerify({
      platform: "device",
      deviceId: "device-1",
      targetProcessId: 456,
      signal: new AbortController().signal,
      capture: async () => ({
        stdout: "",
        stderr: "ERROR: The developer disk image could not be mounted on this device.",
        exitCode: 1,
      }) satisfies CaptureResult,
    })

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("perf-target-process-not-found")
      expect(result.left.reason).toContain("developer disk image")
    }
  })

  test("aborting the signal interrupts an in-flight identity check", async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await runVerify({
      platform: "simulator",
      deviceId: "sim-1",
      targetProcessId: 123,
      signal: controller.signal,
      capture: async (args) => {
        if (args.signal.aborted) {
          throw new Error("aborted before dispatch")
        }
        return { stdout: "123 x", stderr: "", exitCode: 0 } satisfies CaptureResult
      },
    })

    expect(Either.isLeft(result)).toBe(true)
  })
})
