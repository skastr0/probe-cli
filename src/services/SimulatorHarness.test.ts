import { describe, expect, test } from "bun:test"
import { Effect, Either, ManagedRuntime } from "effect"
import { EnvironmentError, UserInputError } from "../domain/errors"
import {
  buildProbeRunnerForSimulator,
  extractPidFromLaunchctlList,
  isInstalledAppListMatch,
  resolveAttachTargetProcessId,
  SimulatorHarness,
  SimulatorHarnessLive,
} from "./SimulatorHarness"

const simulatorHarnessRuntime = ManagedRuntime.make(SimulatorHarnessLive)

const simulatorUdid = "SIM-123"
const bundleId = "com.example.notes"

const expectTaggedError = async <TError extends EnvironmentError | UserInputError>(args: {
  readonly effect: Promise<unknown>
  readonly tag: TError["_tag"]
  readonly code: string
}): Promise<TError> => {
  try {
    await args.effect
  } catch (error) {
    expect(error).toBeInstanceOf(args.tag === "EnvironmentError" ? EnvironmentError : UserInputError)

    if (error instanceof EnvironmentError || error instanceof UserInputError) {
      expect(error._tag).toBe(args.tag)
      expect(error.code).toBe(args.code)
      return error as TError
    }

    throw error
  }

  throw new Error(`Expected ${args.tag} with code ${args.code}`)
}

describe("SimulatorHarness helpers", () => {
  test("extractPidFromLaunchctlList returns the PID for a matching bundle identifier", () => {
    const stdout = [
      "PID\tStatus\tLabel",
      "12345\t0\tcom.example.notes",
      "-\t0\tcom.example.other",
    ].join("\n")

    expect(extractPidFromLaunchctlList(stdout, bundleId)).toBe(12_345)
  })

  test("extractPidFromLaunchctlList returns null when the bundle identifier is absent", () => {
    const stdout = [
      "PID\tStatus\tLabel",
      "12345\t0\tcom.example.other",
    ].join("\n")

    expect(extractPidFromLaunchctlList(stdout, bundleId)).toBeNull()
  })

  test("extractPidFromLaunchctlList returns null when the matching line has no leading PID", () => {
    const stdout = [
      "PID\tStatus\tLabel",
      "-\t0\tcom.example.notes",
    ].join("\n")

    expect(extractPidFromLaunchctlList(stdout, bundleId)).toBeNull()
  })

  test("isInstalledAppListMatch returns true for an exact bundle identifier match", () => {
    const stdout = '{"bundleIdentifier":"com.example.notes","name":"Notes"}'

    expect(isInstalledAppListMatch(stdout, bundleId)).toBe(true)
  })

  test("isInstalledAppListMatch returns false for substring-only matches", () => {
    const stdout = '{"bundleIdentifier":"com.example.notes.beta"}'

    expect(isInstalledAppListMatch(stdout, bundleId)).toBe(false)
  })

  test("isInstalledAppListMatch handles listapps-style output with quoted values", () => {
    const stdout = [
      '{',
      '  "ApplicationType" = User;',
      '  "CFBundleIdentifier" = "com.example.notes";',
      '}',
    ].join("\n")

    expect(isInstalledAppListMatch(stdout, bundleId)).toBe(true)
  })

  test("resolveAttachTargetProcessId returns the PID for an installed running app", async () => {
    const pid = await resolveAttachTargetProcessId(
      {
        simulatorUdid,
        bundleId,
      },
      {
        runCommand: async () => ({
          stdout: '{"bundleIdentifier":"com.example.notes"}',
          stderr: "",
        }),
        runCommandWithExit: async () => ({
          stdout: "12345\t0\tcom.example.notes\n",
          stderr: "",
          exitCode: 0,
        }),
      },
    )

    expect(pid).toBe(12_345)
  })

  test("resolveAttachTargetProcessId fails when the app is not installed", async () => {
    let launchctlChecked = false

    await expectTaggedError<EnvironmentError>({
      effect: resolveAttachTargetProcessId(
        {
          simulatorUdid,
          bundleId,
        },
        {
          runCommand: async () => ({
            stdout: '{"bundleIdentifier":"com.example.other"}',
            stderr: "",
          }),
          runCommandWithExit: async () => {
            launchctlChecked = true

            return {
              stdout: "",
              stderr: "",
              exitCode: 0,
            }
          },
        },
      ),
      tag: "EnvironmentError",
      code: "target-app-not-installed",
    })

    expect(launchctlChecked).toBe(false)
  })

  test("resolveAttachTargetProcessId fails when the app is installed but not running", async () => {
    const error = await expectTaggedError<EnvironmentError>({
      effect: resolveAttachTargetProcessId(
        {
          simulatorUdid,
          bundleId,
        },
        {
          runCommand: async () => ({
            stdout: '{"bundleIdentifier":"com.example.notes"}',
            stderr: "",
          }),
          runCommandWithExit: async () => ({
            stdout: "-\t0\tcom.example.notes\n",
            stderr: "",
            exitCode: 0,
          }),
        },
      ),
      tag: "EnvironmentError",
      code: "target-app-not-running",
    })

    expect(error.reason).toContain(bundleId)
    expect(error.reason).toContain(simulatorUdid)
  })

  test("buildProbeRunnerForSimulator builds the ProbeRunner scheme for the selected simulator", async () => {
    const calls: Array<{
      readonly command: string
      readonly commandArgs: ReadonlyArray<string>
      readonly logPath?: string
    }> = []

    await buildProbeRunnerForSimulator(
      {
        projectPath: "/tmp/probe-cli/ios/ProbeFixture/ProbeFixture.xcodeproj",
        simulatorUdid,
        derivedDataPath: "/tmp/probe-cli/.probe/simulator-runner-builds/SIM-123/derived-data",
        buildLogPath: "/tmp/probe-cli/logs/build-for-testing.log",
      },
      {
        runCommand: async (args) => {
          calls.push(args)
          return {
            stdout: "",
            stderr: "",
          }
        },
      },
    )

    expect(calls).toEqual([
      {
        command: "xcodebuild",
        commandArgs: [
          "-project",
          "/tmp/probe-cli/ios/ProbeFixture/ProbeFixture.xcodeproj",
          "-scheme",
          "ProbeRunner",
          "-destination",
          `platform=iOS Simulator,id=${simulatorUdid}`,
          "-derivedDataPath",
          "/tmp/probe-cli/.probe/simulator-runner-builds/SIM-123/derived-data",
          "CODE_SIGNING_ALLOWED=NO",
          "build-for-testing",
        ],
        logPath: "/tmp/probe-cli/logs/build-for-testing.log",
      },
    ])
  })

  test("build-and-install mode rejects non-default bundle identifiers before touching host tools", async () => {
    const result = await simulatorHarnessRuntime.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const harness = yield* SimulatorHarness

          return yield* harness.openSession({
            rootDir: "/tmp/probe-cli-test",
            sessionId: "session-1",
            artifactRoot: "/tmp/probe-cli-test/artifacts",
            runnerDirectory: "/tmp/probe-cli-test/runner",
            logsDirectory: "/tmp/probe-cli-test/logs",
            bundleId,
            sessionMode: "build-and-install",
            simulatorUdid: null,
          })
        }),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)

    if (!Either.isLeft(result)) {
      throw new Error("Expected build-and-install bundle mismatch to fail")
    }

    const error = result.left
    expect(error).toBeInstanceOf(UserInputError)
    expect(error.code).toBe("simulator-session-mode-bundle-mismatch")

    expect(error.reason).toContain(bundleId)
  })
})
