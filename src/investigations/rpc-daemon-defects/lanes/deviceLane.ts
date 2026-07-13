import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatReceipt, realCommandRunner, type CommandRunner } from "../commandRunner"
import type { LaneResult } from "../schema"

interface DevicectlDevicesPayload {
  readonly result?: {
    readonly devices?: ReadonlyArray<{
      readonly deviceProperties?: { readonly name?: string }
      readonly hardwareProperties?: { readonly udid?: string }
    }>
  }
}

// The device lane is explicit and never silently skipped: it always attempts
// `xcrun devicectl list devices` (Probe's own RealDeviceHarness backend —
// src/services/RealDeviceHarness.ts:2026-2028 uses the identical invocation
// shape, including the `--json-output <path>` flag, which per
// knowledge/devicectl-device-signing/api-notes.md is the only supported
// machine-readable interface for devicectl output) and records the outcome —
// physical-device-found, no-device-attached, or command-failed — as a receipt.
// This sandbox has no physical iPhone/iPad attached, so "no device attached" is
// the expected, honestly-reported outcome here.
export const runDeviceLane = async (runCommand: CommandRunner = realCommandRunner): Promise<LaneResult> => {
  const receipts: Array<string> = []
  const details: Array<string> = []
  const outputRoot = await mkdtemp(join(tmpdir(), "probe-investigation-devicectl-"))

  try {
    const outputPath = join(outputRoot, "devices.json")
    const args = ["devicectl", "list", "devices", "--json-output", outputPath]
    const result = runCommand("xcrun", args, 30_000)
    receipts.push(formatReceipt("xcrun", args, result))

    if (result.status !== 0) {
      details.push(`xcrun devicectl list devices exited ${result.status}: ${result.stderr || "no stderr captured"}`)
      return {
        lane: "device",
        status: "attempted-failed",
        summary: "xcrun devicectl list devices failed; this is reported explicitly rather than skipped.",
        details,
        receipts,
      }
    }

    let payload: DevicectlDevicesPayload

    try {
      payload = JSON.parse(await readFile(outputPath, "utf8")) as DevicectlDevicesPayload
    } catch (error) {
      details.push(`Failed to parse devicectl JSON output: ${error instanceof Error ? error.message : String(error)}`)
      return {
        lane: "device",
        status: "attempted-failed",
        summary: "devicectl list devices produced output that could not be parsed as JSON.",
        details,
        receipts,
      }
    }

    const devices = payload.result?.devices ?? []
    details.push(`devicectl reported ${devices.length} known device(s).`)

    if (devices.length === 0) {
      return {
        lane: "device",
        status: "attempted-failed",
        summary: "No physical device is attached to this host; the device lane was attempted and explicitly found nothing, not silently skipped.",
        details,
        receipts,
      }
    }

    for (const device of devices) {
      details.push(`known device: ${device.deviceProperties?.name ?? "unknown"} (${device.hardwareProperties?.udid ?? "unknown udid"})`)
    }

    return {
      lane: "device",
      status: "ran",
      summary: `devicectl reported ${devices.length} known device(s); this investigation does not drive a live device session against them.`,
      details,
      receipts,
    }
  } finally {
    await rm(outputRoot, { recursive: true, force: true })
  }
}
