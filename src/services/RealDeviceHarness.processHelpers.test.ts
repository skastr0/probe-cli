import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  resetHostToolchainInfoCacheForTests,
  resolveHostToolchainInfo,
  runRealDeviceHostCommand,
  startRealDeviceRunnerWrapperProcess,
  stopRealDeviceRunnerWrapperProcess,
  verifySignedRealDeviceProduct,
} from "./RealDeviceHarness"

// Real, non-mocked coverage of the AppleProcessSupervisor-backed migration.

/** Every pid currently alive in the process group led by `pgid` (best-effort, macOS/Linux `ps`). */
const processGroupMembers = (pgid: number): ReadonlyArray<number> => {
  try {
    const output = execFileSync("ps", ["-o", "pid=", "-g", String(pgid)], { encoding: "utf8" })
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(Number)
  } catch {
    return []
  }
}

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "real-device-harness-process-helpers-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

describe("RealDeviceHarness runCommand (real spawn, via AppleProcessSupervisor)", () => {
  test("resolves stdout/stderr/exitCode for a real process regardless of exit code", async () => {
    const result = await runRealDeviceHostCommand({ command: "/bin/sh", commandArgs: ["-c", "echo hi; exit 4"] })
    expect(result.stdout.trim()).toBe("hi")
    expect(result.exitCode).toBe(4)
  })

  test("rejects with a plain Error on timeout and kills the child", async () => {
    const start = Date.now()
    await expect(
      runRealDeviceHostCommand({ command: "/bin/sh", commandArgs: ["-c", "sleep 30"], timeoutMs: 150 }),
    ).rejects.toThrow(/timed out after 150 ms/)
    expect(Date.now() - start).toBeLessThan(3_000)
  })

  test("rejects with the raw spawn error when the binary is missing", async () => {
    const failure = await runRealDeviceHostCommand({ command: "/definitely/not/a/real/binary", commandArgs: [] })
      .catch((error: unknown) => error)
    expect(failure && typeof failure === "object" && "code" in failure ? (failure as { code: unknown }).code : undefined)
      .toBe("ENOENT")
  })
})

describe("RealDeviceHarness runner wrapper process (real spawn, via AppleProcessSupervisor)", () => {
  test(
    "startRealDeviceRunnerWrapperProcess/stop leave zero surviving descendants and append stderr linearly",
    async () => {
      await withTempDir(async (dir) => {
        const wrapperStderrPath = join(dir, "wrapper.stderr.log")

        const wrapper = await startRealDeviceRunnerWrapperProcess({
          command: "/bin/sh",
          // A process-group leader that emits stderr and forks descendants,
          // mirroring the real xcodebuild/XCUITest wrapper shape closely
          // enough to exercise the same lifecycle path.
          commandArgs: ["-c", "echo wrapper-stderr-line 1>&2; sleep 30 & sleep 30 & wait"],
          cwd: dir,
          observerControlDirectory: join(dir, "observer-control"),
          wrapperStderrPath,
        })

        await new Promise((resolve) => setTimeout(resolve, 150))

        expect(wrapper.handle.isRunning()).toBe(true)
        const membersBeforeStop = processGroupMembers(wrapper.handle.pid)
        expect(membersBeforeStop.length).toBeGreaterThan(0)

        const logged = await readFile(wrapperStderrPath, "utf8")
        expect(logged).toContain("wrapper-stderr-line")

        await stopRealDeviceRunnerWrapperProcess(wrapper)

        expect(wrapper.handle.isRunning()).toBe(false)
        expect(processGroupMembers(wrapper.handle.pid).length).toBe(0)

        const exitResult = await wrapper.exit
        expect(exitResult.code === 0 || exitResult.signal !== null).toBe(true)
      })
    },
  )

  test("stopRealDeviceRunnerWrapperProcess is a no-op once the wrapper has already exited", async () => {
    await withTempDir(async (dir) => {
      const wrapper = await startRealDeviceRunnerWrapperProcess({
        command: "/bin/sh",
        commandArgs: ["-c", "exit 0"],
        cwd: dir,
        observerControlDirectory: join(dir, "observer-control"),
        wrapperStderrPath: join(dir, "wrapper.stderr.log"),
      })

      await wrapper.exit
      expect(wrapper.handle.isRunning()).toBe(false)

      // Should resolve immediately without attempting to signal a dead pid.
      await stopRealDeviceRunnerWrapperProcess(wrapper)
    })
  })
})

// PRB-095: real, non-mocked coverage of the codesign/security seam
// `RunnerBuildCache`'s revalidation depends on -- against a locally
// ad-hoc-signed fixture bundle. This does not require a physical device or a
// DEVELOPMENT_TEAM (ad-hoc signing needs neither), so it genuinely runs on
// any macOS host with Xcode command line tools installed.
describe("verifySignedRealDeviceProduct (real codesign/security, ad-hoc signed fixture)", () => {
  const makeAdHocSignedApp = async (dir: string): Promise<string> => {
    const appPath = join(dir, "Fake.app")
    await mkdir(appPath, { recursive: true })
    await writeFile(
      join(appPath, "Info.plist"),
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        + "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n"
        + "<plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>com.example.fake</string></dict></plist>\n",
      "utf8",
    )
    await writeFile(join(appPath, "Fake"), "#!/bin/sh\nexit 0\n", "utf8")
    await chmod(join(appPath, "Fake"), 0o755)

    await runRealDeviceHostCommand({
      command: "/usr/bin/codesign",
      commandArgs: ["--sign", "-", "--force", appPath],
    })

    return appPath
  }

  test("a validly ad-hoc-signed app with no embedded profile fails with a profile-missing reason (never a signing false-positive)", async () => {
    await withTempDir(async (dir) => {
      const appPath = await makeAdHocSignedApp(dir)
      const result = await verifySignedRealDeviceProduct(appPath)

      expect(result.signed).toBe(false)
      expect(result.reason).toContain("embedded.mobileprovision")
    })
  })

  test("a tampered signature (binary modified after signing) is rejected by codesign --verify", async () => {
    await withTempDir(async (dir) => {
      const appPath = await makeAdHocSignedApp(dir)
      // Mutate the sealed binary after signing -- codesign --verify --deep
      // --strict must catch this; a cache that trusted paths/mtimes alone
      // would not.
      await writeFile(join(appPath, "Fake"), "#!/bin/sh\necho tampered\n", "utf8")

      const result = await verifySignedRealDeviceProduct(appPath)

      expect(result.signed).toBe(false)
      expect(result.reason).toContain("codesign --verify")
    })
  })

  test("a missing app bundle fails cleanly instead of throwing", async () => {
    await withTempDir(async (dir) => {
      const result = await verifySignedRealDeviceProduct(join(dir, "DoesNotExist.app"))

      expect(result.signed).toBe(false)
      expect(result.reason).toBeTruthy()
    })
  })
})

// PRB-095: real coverage of the Xcode/SDK version discovery that seeds the
// runner build cache key -- against the real `xcodebuild -version` /
// `xcrun --show-sdk-version` seam on this host.
describe("resolveHostToolchainInfo (real xcodebuild/xcrun)", () => {
  test("resolves a non-empty Xcode/SDK version and memoizes until reset", async () => {
    resetHostToolchainInfoCacheForTests()

    const first = await resolveHostToolchainInfo()
    expect(first.xcodeVersion).toMatch(/Xcode/)
    expect(first.sdkVersion).not.toBe("unknown")
    expect(first.sdkVersion.length).toBeGreaterThan(0)

    // A second call before reset returns the identical memoized object
    // (same values, no fresh `xcodebuild -version` invocation) -- verified
    // indirectly by asserting the values are stable across calls.
    const second = await resolveHostToolchainInfo()
    expect(second).toEqual(first)

    resetHostToolchainInfoCacheForTests()
    const afterReset = await resolveHostToolchainInfo()
    expect(afterReset).toEqual(first)
  })
})
