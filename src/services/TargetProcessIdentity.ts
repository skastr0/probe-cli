import { randomUUID } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { EnvironmentError } from "../domain/errors"

/**
 * PRB-096: the fresh, pre-spawn liveness/identity check a raw perf capture
 * runs against its target-process lease immediately before invoking `xctrace
 * record` -- this, not XCUITest runner health, is what raw record gates on
 * now ("Raw perf record requires connected target and live verified process
 * identity, not healthy XCUITest runner").
 *
 * Deliberately narrow in scope (see the glyph's Exclusions: no PID-reuse
 * claims without real verification). This proves the pid is alive and, for a
 * simulator target, that it actually resolves under the expected booted
 * device's own container path -- catching the common reuse case (an
 * unrelated process landing on the same pid on a *different* simulator)
 * without inventing a stronger cross-time epoch. It does not attempt to
 * track process identity across time; one fresh check right before spawn is
 * the contract.
 */

export interface TargetProcessIdentitySnapshot {
  readonly verifiedAt: string
  readonly method: "ps" | "devicectl-processes"
  readonly detail: string
}

export interface TargetProcessIdentityCaptureResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
}

/** Matches the shape of `PerfCommandRunner.capture` (PerfService.ts) so PerfService can pass its existing injected capture straight through. */
export type TargetProcessIdentityCapture = (args: {
  readonly command: string
  readonly commandArgs: ReadonlyArray<string>
  readonly timeoutMs: number
  readonly allowFailure?: boolean
  readonly signal: AbortSignal
}) => Promise<TargetProcessIdentityCaptureResult>

const identityCheckTimeoutMs = 10_000

const notFoundError = (args: {
  readonly platform: "simulator" | "device"
  readonly targetProcessId: number
  readonly deviceId: string
  readonly detail: string
}): EnvironmentError =>
  new EnvironmentError({
    code: "perf-target-process-not-found",
    reason:
      `Target process ${args.targetProcessId} on ${args.platform} ${args.deviceId} could not be verified alive `
      + `immediately before recording. ${args.detail}`,
    nextStep:
      "The target app may have exited, crashed, or its pid may have been reused by an unrelated process. "
      + "Reopen the session and retry the profiling command.",
    details: [],
  })

const verifySimulatorProcessIdentity = (args: {
  readonly deviceId: string
  readonly targetProcessId: number
  readonly capture: TargetProcessIdentityCapture
  readonly signal: AbortSignal
}): Effect.Effect<TargetProcessIdentitySnapshot, EnvironmentError> =>
  Effect.tryPromise({
    try: () =>
      args.capture({
        command: "ps",
        commandArgs: ["-p", String(args.targetProcessId), "-o", "pid=,comm="],
        timeoutMs: identityCheckTimeoutMs,
        allowFailure: true,
        signal: args.signal,
      }),
    catch: (error) =>
      notFoundError({
        platform: "simulator",
        targetProcessId: args.targetProcessId,
        deviceId: args.deviceId,
        detail: `\`ps\` failed to run: ${error instanceof Error ? error.message : String(error)}.`,
      }),
  }).pipe(
    Effect.flatMap((result) => {
      const output = result.stdout.trim()

      if (result.exitCode !== 0 || output.length === 0) {
        return Effect.fail(
          notFoundError({
            platform: "simulator",
            targetProcessId: args.targetProcessId,
            deviceId: args.deviceId,
            detail: `\`ps -p ${args.targetProcessId}\` reported no running process.`,
          }),
        )
      }

      if (!output.includes(args.deviceId)) {
        return Effect.fail(
          notFoundError({
            platform: "simulator",
            targetProcessId: args.targetProcessId,
            deviceId: args.deviceId,
            detail:
              `pid ${args.targetProcessId} is alive but does not resolve under simulator ${args.deviceId}'s `
              + "own container -- likely pid reuse by an unrelated process.",
          }),
        )
      }

      return Effect.succeed({
        verifiedAt: new Date().toISOString(),
        method: "ps" as const,
        detail: output,
      })
    }),
  )

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/**
 * `devicectl`'s JSON envelope shape is `{ info, result: {...} }` (confirmed
 * empirically against `devicectl list devices` on this host -- see
 * knowledge/devicectl-device-signing), but the exact array field name under
 * `result` for `device info processes` is not pinned down: exercising the
 * real command against a connected device on this host fails before it ever
 * returns JSON ("The developer disk image could not be mounted ... device is
 * locked" -- a signing/DDI blocker, not a Probe defect; see
 * knowledge/devicectl-device-signing/integration-notes.md). This scans
 * defensively for any array of process-shaped records instead of
 * hard-coding one field name, so a plausible schema still gets a real check
 * -- and, critically, still fails closed (no match found) if the shape does
 * not hold, instead of ever claiming a false positive.
 */
const findMatchingProcess = (payload: unknown, targetProcessId: number): string | null => {
  if (!isRecord(payload) || !isRecord(payload.result)) {
    return null
  }

  for (const value of Object.values(payload.result)) {
    if (!Array.isArray(value)) {
      continue
    }

    for (const entry of value) {
      if (!isRecord(entry)) {
        continue
      }

      const pid = entry.processIdentifier ?? entry.pid

      if (typeof pid === "number" && pid === targetProcessId) {
        return JSON.stringify(entry)
      }
    }
  }

  return null
}

const verifyDeviceProcessIdentity = (args: {
  readonly deviceId: string
  readonly targetProcessId: number
  readonly capture: TargetProcessIdentityCapture
  readonly signal: AbortSignal
}): Effect.Effect<TargetProcessIdentitySnapshot, EnvironmentError> =>
  Effect.gen(function* () {
    const jsonOutputPath = join(tmpdir(), `probe-perf-target-identity-${randomUUID()}.json`)

    const result = yield* Effect.tryPromise({
      try: () =>
        args.capture({
          command: "xcrun",
          commandArgs: [
            "devicectl",
            "device",
            "info",
            "processes",
            "--device",
            args.deviceId,
            "--filter",
            `processIdentifier == ${args.targetProcessId}`,
            "--json-output",
            jsonOutputPath,
          ],
          timeoutMs: identityCheckTimeoutMs,
          allowFailure: true,
          signal: args.signal,
        }),
      catch: (error) =>
        notFoundError({
          platform: "device",
          targetProcessId: args.targetProcessId,
          deviceId: args.deviceId,
          detail: `\`xcrun devicectl device info processes\` failed to run: ${error instanceof Error ? error.message : String(error)}.`,
        }),
    })

    if (result.exitCode !== 0) {
      return yield* notFoundError({
        platform: "device",
        targetProcessId: args.targetProcessId,
        deviceId: args.deviceId,
        detail: `\`xcrun devicectl device info processes\` exited ${result.exitCode ?? "unknown"}: ${
          (result.stderr.trim() || result.stdout.trim()).slice(0, 400)
        }.`,
      })
    }

    const payload = yield* Effect.tryPromise({
      try: async () => {
        const raw = await readFile(jsonOutputPath, "utf8")
        return JSON.parse(raw) as unknown
      },
      catch: (error) =>
        notFoundError({
          platform: "device",
          targetProcessId: args.targetProcessId,
          deviceId: args.deviceId,
          detail: `Could not read/parse the devicectl processes JSON output: ${error instanceof Error ? error.message : String(error)}.`,
        }),
    }).pipe(
      Effect.ensuring(Effect.promise(() => rm(jsonOutputPath, { force: true }))),
    )

    const matched = findMatchingProcess(payload, args.targetProcessId)

    if (!matched) {
      return yield* notFoundError({
        platform: "device",
        targetProcessId: args.targetProcessId,
        deviceId: args.deviceId,
        detail: `devicectl reported no running process with pid ${args.targetProcessId} on device ${args.deviceId}.`,
      })
    }

    return {
      verifiedAt: new Date().toISOString(),
      method: "devicectl-processes" as const,
      detail: matched,
    }
  })

export const verifyTargetProcessIdentity = (args: {
  readonly platform: "simulator" | "device"
  readonly deviceId: string
  readonly targetProcessId: number
  readonly capture: TargetProcessIdentityCapture
  readonly signal: AbortSignal
}): Effect.Effect<TargetProcessIdentitySnapshot, EnvironmentError> =>
  args.platform === "simulator"
    ? verifySimulatorProcessIdentity(args)
    : verifyDeviceProcessIdentity(args)
