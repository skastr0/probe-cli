import { formatReceipt, realCommandRunner, type CommandRunner } from "../commandRunner"
import type { LaneResult } from "../schema"

interface SimctlDeviceEntry {
  readonly udid: string
  readonly name: string
  readonly state: string
  readonly isAvailable?: boolean
}

interface SimctlListPayload {
  readonly devices: Record<string, ReadonlyArray<SimctlDeviceEntry>>
}

const pickBootCandidate = (payload: SimctlListPayload): SimctlDeviceEntry | null => {
  for (const entries of Object.values(payload.devices)) {
    const candidate = entries.find((entry) => entry.isAvailable !== false)

    if (candidate) {
      return candidate
    }
  }

  return null
}

// Deterministic, CI-capable simulator lane: boots a real iOS Simulator via
// `xcrun simctl` (Probe's own SimulatorHarness backend — src/services/SimulatorHarness.ts)
// and shuts it back down. This proves the simulator lane is exercisable in this
// environment; it does not install/launch the Probe XCUITest runner app, which
// requires the full ios/ Xcode build pipeline and is out of scope for this
// investigation harness. If `simctl` boot fails or is unavailable, that failure
// is captured as an explicit receipt rather than silently skipped.
export const runSimulatorLane = async (runCommand: CommandRunner = realCommandRunner): Promise<LaneResult> => {
  const receipts: Array<string> = []
  const details: Array<string> = []

  const listArgs = ["simctl", "list", "devices", "available", "--json"]
  const listResult = runCommand("xcrun", listArgs, 15_000)
  receipts.push(formatReceipt("xcrun", listArgs, listResult))

  if (listResult.status !== 0) {
    details.push(`xcrun simctl list devices failed: ${listResult.stderr || "no stderr captured"}`)
    return {
      lane: "simulator",
      status: "attempted-failed",
      summary: "Could not enumerate available iOS Simulator devices via simctl.",
      details,
      receipts,
    }
  }

  let payload: SimctlListPayload

  try {
    payload = JSON.parse(listResult.stdout) as SimctlListPayload
  } catch (error) {
    details.push(`Failed to parse simctl JSON output: ${error instanceof Error ? error.message : String(error)}`)
    return {
      lane: "simulator",
      status: "attempted-failed",
      summary: "simctl list devices returned output that could not be parsed as JSON.",
      details,
      receipts,
    }
  }

  const candidate = pickBootCandidate(payload)

  if (!candidate) {
    details.push("No available iOS Simulator devices were reported by simctl.")
    return {
      lane: "simulator",
      status: "attempted-failed",
      summary: "No available iOS Simulator devices to boot.",
      details,
      receipts,
    }
  }

  details.push(`Selected simulator: ${candidate.name} (${candidate.udid}), initial state ${candidate.state}.`)

  const alreadyBooted = candidate.state === "Booted"
  let bootedByThisRun = false

  if (!alreadyBooted) {
    const bootArgs = ["simctl", "boot", candidate.udid]
    const bootResult = runCommand("xcrun", bootArgs, 60_000)
    receipts.push(formatReceipt("xcrun", bootArgs, bootResult))

    const alreadyBootedError = bootResult.stderr.includes("Unable to boot device in current state: Booted")

    if (bootResult.status !== 0 && !alreadyBootedError) {
      details.push(`simctl boot failed: ${bootResult.stderr || "no stderr captured"}`)
      return {
        lane: "simulator",
        status: "attempted-failed",
        summary: `Failed to boot simulator ${candidate.name} (${candidate.udid}).`,
        details,
        receipts,
      }
    }

    bootedByThisRun = bootResult.status === 0
  }

  const statusArgs = ["simctl", "list", "devices", candidate.udid, "--json"]
  const statusResult = runCommand("xcrun", statusArgs, 15_000)
  receipts.push(formatReceipt("xcrun", statusArgs, statusResult))

  let confirmedBooted = alreadyBooted || bootedByThisRun

  try {
    const statusPayload = JSON.parse(statusResult.stdout) as SimctlListPayload
    const refreshed = Object.values(statusPayload.devices)
      .flat()
      .find((entry) => entry.udid === candidate.udid)
    confirmedBooted = refreshed?.state === "Booted"
    details.push(`Post-boot state: ${refreshed?.state ?? "unknown"}.`)
  } catch {
    details.push("Could not confirm post-boot state via simctl JSON output.")
  }

  if (bootedByThisRun) {
    const shutdownArgs = ["simctl", "shutdown", candidate.udid]
    const shutdownResult = runCommand("xcrun", shutdownArgs, 30_000)
    receipts.push(formatReceipt("xcrun", shutdownArgs, shutdownResult))
    details.push(
      shutdownResult.status === 0
        ? "Shut the simulator back down after the boot probe (left as found)."
        : `Shutdown after boot probe failed: ${shutdownResult.stderr || "no stderr captured"}`,
    )
  }

  return {
    lane: "simulator",
    status: confirmedBooted ? "ran" : "attempted-failed",
    summary: confirmedBooted
      ? `Booted and confirmed simulator ${candidate.name} (${candidate.udid}) via simctl.`
      : `Attempted to boot simulator ${candidate.name} (${candidate.udid}) but could not confirm the Booted state.`,
    details,
    receipts,
  }
}
