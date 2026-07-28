#!/usr/bin/env bun
/**
 * Fair live-device try: fixture fly path + optional Ripple snapshot.
 * Usage: bun run scripts/live-device-fair-try.ts [--phase fixture|ripple|all]
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const deviceId = process.env.PROBE_DEVICE_ID ?? "9FE1EE68-650B-590A-B131-48E1575FBE5A"
const teamId = process.env.PROBE_TEAM_ID ?? "4452968868"
const rippleBundle = process.env.PROBE_RIPPLE_BUNDLE ?? "com.skastr0.ripple"
const phase = process.argv.includes("--phase")
  ? process.argv[process.argv.indexOf("--phase") + 1]
  : "all"

const receiptDir = join(root, "knowledge", "live-device-fair-try-2026-07-28")
mkdirSync(receiptDir, { recursive: true })

const runProbe = (args: string[], timeoutMs = 180_000): { ok: boolean; raw: string; json: unknown | null } => {
  const result = spawnSync("bun", ["run", "src/cli/main.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  })
  const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
  // Prefer last JSON object in output
  let json: unknown | null = null
  const start = raw.indexOf("{")
  if (start >= 0) {
    try {
      json = JSON.parse(raw.slice(start))
    } catch {
      // try last brace block
      const last = raw.lastIndexOf("\n{")
      if (last >= 0) {
        try {
          json = JSON.parse(raw.slice(last + 1))
        } catch {
          json = null
        }
      }
    }
  }
  return { ok: result.status === 0, raw, json }
}

const save = (name: string, data: unknown) => {
  const path = join(receiptDir, name)
  writeFileSync(path, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`, "utf8")
  console.log(`saved ${path}`)
}

const semantic = (identifier: string, type: string | null = null) => ({
  kind: "semantic",
  identifier,
  label: null,
  value: null,
  placeholder: null,
  type,
  section: null,
  interactive: true,
})

const summary: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  deviceId,
  teamId,
  phases: {} as Record<string, unknown>,
}

const runFixture = () => {
  console.log("\n=== FIXTURE OPEN ===")
  const open = runProbe([
    "session", "open",
    "--target", "device",
    "--device-id", deviceId,
    "--team-id", teamId,
    "--output-json",
  ], 300_000)
  save("fixture-open.json", open.json ?? open.raw)
  if (!open.ok || !open.json || typeof open.json !== "object") {
    summary.phases = { ...summary.phases as object, fixture: { ok: false, step: "open", raw: open.raw.slice(0, 2000) } }
    return null
  }
  const health = open.json as Record<string, unknown>
  const sessionId = String(health.sessionId ?? "")
  console.log("sessionId", sessionId, "state", health.state)

  console.log("\n=== SNAPSHOT agentView ===")
  const snap = runProbe(["session", "snapshot", "--session-id", sessionId, "--output-json"])
  save("fixture-snapshot.json", snap.json ?? snap.raw)
  const snapObj = (snap.json ?? {}) as Record<string, unknown>
  const agentView = (snapObj.agentView ?? {}) as Record<string, unknown>
  const interactive = (agentView.interactive as unknown[]) ?? []
  console.log("agentView total", agentView.interactiveTotal, "shown", interactive.length)
  for (const n of interactive.slice(0, 20) as Array<Record<string, unknown>>) {
    console.log(`  ${n.ref} ${n.type} id=${n.identifier} label=${n.label}`)
  }

  console.log("\n=== BATCH actions[] form ===")
  const batchPayload = {
    sessionId,
    actions: [
      {
        kind: "type",
        target: semantic("fixture.form.input", "textField"),
        text: "live-device-wave",
        replace: true,
      },
      {
        kind: "tap",
        target: semantic("fixture.form.applyButton", "button"),
      },
    ],
  }
  const batch = runProbe(["session", "action", "--input-json", JSON.stringify(batchPayload), "--output-json"])
  save("fixture-batch-form.json", batch.json ?? batch.raw)
  const batchObj = (batch.json ?? {}) as Record<string, unknown>
  console.log("verdict", batchObj.verdict, "summary", batchObj.summary)

  console.log("\n=== multiTap ×5 ===")
  const multiPayload = {
    sessionId,
    action: {
      kind: "multiTap",
      target: semantic("fixture.gesture.multiTapTarget"),
      tapCount: 5,
      interTapDelayMs: 40,
    },
  }
  const multi = runProbe(["session", "action", "--input-json", JSON.stringify(multiPayload), "--output-json"])
  save("fixture-multitap.json", multi.json ?? multi.raw)
  const multiObj = (multi.json ?? {}) as Record<string, unknown>
  console.log("summary", multiObj.summary)
  console.log("timings", {
    handledMs: multiObj.handledMs,
    resolutionMs: multiObj.resolutionMs,
    waitMs: multiObj.waitMs,
    interactionMs: multiObj.interactionMs,
    finalizationMs: multiObj.finalizationMs,
    hostRttMs: multiObj.hostRttMs,
  })
  console.log("evidence", multiObj.evidence)
  console.log("uiDelta", multiObj.uiDelta)

  console.log("\n=== multiTap with success=end (uiDelta path) ===")
  const multiEndPayload = {
    sessionId,
    action: {
      kind: "multiTap",
      target: semantic("fixture.gesture.multiTapTarget"),
      tapCount: 3,
      interTapDelayMs: 40,
      evidencePolicy: { success: "end", failure: "snapshot" },
    },
  }
  const multiEnd = runProbe(["session", "action", "--input-json", JSON.stringify(multiEndPayload), "--output-json"])
  save("fixture-multitap-end.json", multiEnd.json ?? multiEnd.raw)
  const multiEndObj = (multiEnd.json ?? {}) as Record<string, unknown>
  console.log("uiDelta kind", (multiEndObj.uiDelta as Record<string, unknown> | null)?.kind)
  console.log("uiDelta interactive", ((multiEndObj.uiDelta as Record<string, unknown> | null)?.interactive as unknown[])?.length)

  console.log("\n=== recording export flow-v2 ===")
  const exp = runProbe([
    "session", "recording", "export",
    "--session-id", sessionId,
    "--label", "fixture-live-fly",
    "--format", "flow-v2",
    "--output-json",
  ])
  save("fixture-export-flow-v2.json", exp.json ?? exp.raw)
  console.log("export ok", exp.ok, typeof exp.json === "object" ? (exp.json as Record<string, unknown>).summary ?? (exp.json as Record<string, unknown>).flowPath : exp.raw.slice(0, 500))

  // Try session run of exported flow if path present
  const expObj = (exp.json ?? {}) as Record<string, unknown>
  const flowPath = typeof expObj.flowPath === "string" ? expObj.flowPath : null
  let flowRun: Record<string, unknown> | null = null
  if (flowPath) {
    console.log("\n=== session run exported flow ===")
    const run = runProbe(["session", "run", "--session-id", sessionId, "--file", flowPath, "--output-json"])
    save("fixture-run-exported-flow.json", run.json ?? run.raw)
    flowRun = (run.json ?? { raw: run.raw.slice(0, 1000) }) as Record<string, unknown>
    console.log("run verdict", flowRun.verdict, flowRun.summary)
  }

  console.log("\n=== close fixture ===")
  const close = runProbe(["session", "close", "--session-id", sessionId, "--output-json"])
  save("fixture-close.json", close.json ?? close.raw)

  const phaseResult = {
    ok: Boolean(batch.ok && multi.ok && snap.ok),
    sessionId,
    agentViewShown: interactive.length,
    agentViewTotal: agentView.interactiveTotal,
    batchVerdict: batchObj.verdict,
    multiTap: {
      summary: multiObj.summary,
      handledMs: multiObj.handledMs,
      interactionMs: multiObj.interactionMs,
      evidence: multiObj.evidence,
      uiDelta: multiObj.uiDelta,
    },
    multiTapEndUiDelta: multiEndObj.uiDelta ?? null,
    exportOk: exp.ok,
    exportSummary: expObj.summary ?? expObj.flowPath ?? null,
    flowRunVerdict: flowRun?.verdict ?? null,
  }
  summary.phases = { ...(summary.phases as object), fixture: phaseResult }
  return phaseResult
}

const runRipple = () => {
  console.log("\n=== RIPPLE OPEN ===")
  // Ripple must already be installed; open attaches/launches via runner
  const open = runProbe([
    "session", "open",
    "--target", "device",
    "--device-id", deviceId,
    "--team-id", teamId,
    "--bundle-id", rippleBundle,
    "--output-json",
  ], 300_000)
  save("ripple-open.json", open.json ?? open.raw)
  if (!open.ok || !open.json || typeof open.json !== "object") {
    summary.phases = {
      ...(summary.phases as object),
      ripple: { ok: false, step: "open", raw: (open.raw ?? "").slice(0, 2500) },
    }
    console.log("ripple open failed", (open.raw ?? "").slice(0, 1500))
    return null
  }
  const health = open.json as Record<string, unknown>
  const sessionId = String(health.sessionId ?? "")
  console.log("sessionId", sessionId, "state", health.state, "target", health.target)

  console.log("\n=== RIPPLE SNAPSHOT agentView ===")
  const snap = runProbe(["session", "snapshot", "--session-id", sessionId, "--output-json"])
  save("ripple-snapshot.json", snap.json ?? snap.raw)
  const snapObj = (snap.json ?? {}) as Record<string, unknown>
  const agentView = (snapObj.agentView ?? {}) as Record<string, unknown>
  const interactive = (agentView.interactive as Array<Record<string, unknown>>) ?? []
  console.log("status", snapObj.statusLabel)
  console.log("agentView total", agentView.interactiveTotal, "shown", interactive.length)
  for (const n of interactive.slice(0, 30)) {
    console.log(`  ${n.ref} ${n.type} id=${n.identifier} label=${n.label}`)
  }

  // Best-effort: tap first button-like with identifier or Continue/Next/Get Started labels
  const candidates = interactive.filter((n) => {
    const id = String(n.identifier ?? "").toLowerCase()
    const label = String(n.label ?? "").toLowerCase()
    const type = String(n.type ?? "").toLowerCase()
    if (!type.includes("button") && type !== "cell" && type !== "other") return false
    return (
      id.includes("continue")
      || id.includes("next")
      || id.includes("start")
      || id.includes("skip")
      || label.includes("continue")
      || label.includes("next")
      || label.includes("get started")
      || label.includes("skip")
      || label.includes("begin")
    )
  })

  let tapResult: unknown = null
  if (candidates.length > 0) {
    const pick = candidates[0]!
    console.log("\n=== RIPPLE best-effort tap ===", pick)
    const target = pick.identifier
      ? semantic(String(pick.identifier), pick.type ? String(pick.type) : null)
      : {
          kind: "ref",
          ref: String(pick.ref),
          fallback: pick.label
            ? {
                kind: "semantic",
                identifier: null,
                label: String(pick.label),
                value: null,
                placeholder: null,
                type: pick.type ? String(pick.type) : null,
                section: null,
                interactive: true,
              }
            : null,
        }
    const tap = runProbe([
      "session", "action",
      "--input-json",
      JSON.stringify({ sessionId, action: { kind: "tap", target } }),
      "--output-json",
    ])
    save("ripple-tap.json", tap.json ?? tap.raw)
    tapResult = tap.json
    console.log("tap summary", (tap.json as Record<string, unknown> | null)?.summary)

    const snap2 = runProbe(["session", "snapshot", "--session-id", sessionId, "--output-json"])
    save("ripple-snapshot-after-tap.json", snap2.json ?? snap2.raw)
    const av2 = ((snap2.json as Record<string, unknown> | null)?.agentView ?? {}) as Record<string, unknown>
    console.log("after-tap agentView", av2.interactiveTotal, "status", (snap2.json as Record<string, unknown> | null)?.statusLabel)
  } else {
    console.log("no obvious continue/next button — leaving at first screen (honest)")
  }

  const close = runProbe(["session", "close", "--session-id", sessionId, "--output-json"])
  save("ripple-close.json", close.json ?? close.raw)

  const phaseResult = {
    ok: Boolean(snap.ok && open.ok),
    sessionId,
    statusLabel: snapObj.statusLabel,
    agentViewShown: interactive.length,
    agentViewTotal: agentView.interactiveTotal,
    sampleInteractive: interactive.slice(0, 15),
    bestEffortTap: tapResult !== null,
    tapSummary: (tapResult as Record<string, unknown> | null)?.summary ?? null,
  }
  summary.phases = { ...(summary.phases as object), ripple: phaseResult }
  return phaseResult
}

// Ensure daemon is up
const doctor = runProbe(["doctor", "--output-json"], 30_000)
const doctorObj = (doctor.json ?? {}) as Record<string, unknown>
const daemon = (doctorObj.daemon ?? {}) as Record<string, unknown>
if (!daemon.running) {
  console.log("daemon not running — start with: bun run probe -- serve")
  console.log("doctor raw", doctor.raw.slice(0, 500))
  process.exit(2)
}

if (phase === "fixture" || phase === "all") {
  runFixture()
}
if (phase === "ripple" || phase === "all") {
  runRipple()
}

summary.finishedAt = new Date().toISOString()
save("summary.json", summary)
console.log("\n=== SUMMARY ===")
console.log(JSON.stringify(summary, null, 2))
