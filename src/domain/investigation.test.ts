import { describe, expect, test } from "bun:test"
import { boundedCollectionAllShown, sliceBoundedCollection } from "./bounded"
import {
  assembleInvestigationReport,
  compareEvidenceReports as compareReports,
  decodeInvestigationRecipe,
  deriveComparisonVerdict,
  fnv1aHex,
  identifyRegressedMetrics,
  investigationRecipeHash,
  mergeAndRankFindings,
  mergeInvestigationEvidenceReports,
  overallFindingsConfidence,
  planInvestigation,
  validateInvestigationRecipe,
  validateInvestigationRecipeDomain,
  type InvestigationRecipe,
} from "./investigation"
import type { PerfEvidenceComparison, PerfEvidenceFinding, PerfEvidenceReport } from "./perf-evidence"

// Pure test-only stand-in for `services/boundedCollections.ts#bindBoundedCollection`
// (which needs `ArtifactStore` + an Effect) -- these domain-level tests only
// assert total/shown/omitted, never `drill`, so a plain non-persisting bound
// is enough here; `InvestigationController.test.ts` covers the real,
// persisted-artifact drill handle end to end.
const boundFindingsForTest = (findings: ReadonlyArray<PerfEvidenceFinding>, shownLimit: number) => {
  const { shown, omitted } = sliceBoundedCollection(findings, shownLimit)
  return omitted === 0 ? boundedCollectionAllShown(findings) : { total: findings.length, shown, omitted, drill: null }
}

// PRB-099: pure-domain tests for the `probe investigate` orbit's core --
// recipe decode/validation, planning, recipe-digest determinism, the
// comparison-verdict/regressed-channel derivation the ProbeFixture
// planted-regression AC needs, cross-repetition evidence merge, and the
// bounded terminal report assembly. No I/O, no fake DaemonClient here --
// that lives in services/InvestigationController.test.ts.

const tapStep = { kind: "tap" as const, target: { kind: "point" as const, x: 1, y: 2 } }

const baseFlow = { contract: "probe.session-flow/v2" as const, steps: [tapStep] }

const baseRecipe = {
  target: { sessionId: "session-1" },
  measuredFlow: baseFlow,
  capture: { kind: "preset" as const, template: "time-profiler" as const },
  repetitions: 3,
  cooldown: { minIntervalMs: 500 },
}

describe("decodeInvestigationRecipe / validateInvestigationRecipe", () => {
  test("decodes a minimal valid recipe", () => {
    const recipe = decodeInvestigationRecipe(baseRecipe)
    expect(recipe.target.sessionId).toBe("session-1")
    expect(recipe.measuredFlow.steps.length).toBe(1)
    expect(recipe.repetitions).toBe(3)
  })

  test("validateInvestigationRecipe reports ok:true with no violations for a valid recipe", () => {
    const validation = validateInvestigationRecipe(baseRecipe)
    expect(validation).toEqual({ ok: true, violations: [] })
  })

  test("validateInvestigationRecipe never throws on a malformed payload -- reports violations instead", () => {
    const validation = validateInvestigationRecipe({ not: "a recipe" })
    expect(validation.ok).toBe(false)
    expect(validation.violations.length).toBeGreaterThan(0)
  })

  test("domain validation rejects zero repetitions", () => {
    const recipe = decodeInvestigationRecipe({ ...baseRecipe, repetitions: 0 })
    const violations = validateInvestigationRecipeDomain(recipe)
    expect(violations.some((violation) => violation.includes("repetitions"))).toBe(true)
  })

  test("domain validation rejects a negative cooldown", () => {
    const recipe = decodeInvestigationRecipe({ ...baseRecipe, cooldown: { minIntervalMs: -1 } })
    const violations = validateInvestigationRecipeDomain(recipe)
    expect(violations.some((violation) => violation.includes("cooldown"))).toBe(true)
  })

  test("domain validation rejects an empty measured flow", () => {
    const recipe = decodeInvestigationRecipe({ ...baseRecipe, measuredFlow: { contract: "probe.session-flow/v2", steps: [] } })
    const violations = validateInvestigationRecipeDomain(recipe)
    expect(violations.some((violation) => violation.includes("measuredFlow"))).toBe(true)
  })

  test("domain validation rejects a blank custom template path", () => {
    const recipe = decodeInvestigationRecipe({ ...baseRecipe, capture: { kind: "custom", customTemplatePath: "   " } })
    const violations = validateInvestigationRecipeDomain(recipe)
    expect(violations.some((violation) => violation.includes("customTemplatePath"))).toBe(true)
  })
})

describe("investigationRecipeHash / fnv1aHex", () => {
  test("is deterministic for the same recipe", () => {
    const recipe = decodeInvestigationRecipe(baseRecipe)
    expect(investigationRecipeHash(recipe)).toBe(investigationRecipeHash(recipe))
  })

  test("is independent of object key order", () => {
    const a = fnv1aHex(JSON.stringify({ a: 1, b: 2 }))
    const b = fnv1aHex(JSON.stringify({ b: 2, a: 1 }))
    // Raw JSON.stringify order differs; investigationRecipeHash canonicalizes
    // first -- this asserts the canonicalization path itself, not fnv1aHex.
    expect(a).not.toBe(b)

    const recipeA = decodeInvestigationRecipe(baseRecipe)
    const recipeB = decodeInvestigationRecipe({
      cooldown: baseRecipe.cooldown,
      repetitions: baseRecipe.repetitions,
      capture: baseRecipe.capture,
      measuredFlow: baseRecipe.measuredFlow,
      target: baseRecipe.target,
    })
    expect(investigationRecipeHash(recipeA)).toBe(investigationRecipeHash(recipeB))
  })

  test("differs when a repetition count changes", () => {
    const recipeA = decodeInvestigationRecipe(baseRecipe)
    const recipeB = decodeInvestigationRecipe({ ...baseRecipe, repetitions: 5 })
    expect(investigationRecipeHash(recipeA)).not.toBe(investigationRecipeHash(recipeB))
  })
})

describe("planInvestigation", () => {
  test("stable stages: unconditional five plus setup/warmup/compare only when declared", () => {
    const minimal = planInvestigation(decodeInvestigationRecipe(baseRecipe))
    expect(minimal.stages).toEqual(["preflight", "capture", "analyze", "report"])
    expect(minimal.comparisonRequested).toBe(false)

    const withEverything = planInvestigation(decodeInvestigationRecipe({
      ...baseRecipe,
      setup: baseFlow,
      warmup: baseFlow,
      baseline: { kind: "investigation", investigationId: "prior-investigation" },
    }))
    expect(withEverything.stages).toEqual(["preflight", "setup", "warmup", "capture", "analyze", "compare", "report"])
    expect(withEverything.comparisonRequested).toBe(true)
  })

  test("required runner capabilities reflect the measured flow's fast/batch steps", () => {
    const withBatch = planInvestigation(decodeInvestigationRecipe({
      ...baseRecipe,
      measuredFlow: {
        contract: "probe.session-flow/v2",
        steps: [{ kind: "sequence", actions: [tapStep, tapStep] }],
      },
    }))
    expect(withBatch.requiredRunnerCapabilities).toContain("uiActionBatch")
  })

  test("evidence policy defaults when the recipe omits it", () => {
    const plan = planInvestigation(decodeInvestigationRecipe(baseRecipe))
    expect(plan.evidencePolicy).toEqual({ success: "end", failure: "snapshot" })
  })

  test("capture description names the preset template or the custom path", () => {
    const preset = planInvestigation(decodeInvestigationRecipe(baseRecipe))
    expect(preset.captureDescription).toBe("preset:time-profiler")

    const custom = planInvestigation(decodeInvestigationRecipe({
      ...baseRecipe,
      capture: { kind: "custom", customTemplatePath: "/tmp/my.tracetemplate" },
    }))
    expect(custom.captureDescription).toBe("custom:/tmp/my.tracetemplate")
  })
})

// ---------------------------------------------------------------------------
// Fixture PerfEvidenceReports -- "recorded/fake capture lanes" per the glyph
// notes, standing in for a real xctrace capture of ProbeFixture's planted
// CPU regression. baseline/regressed/fixed mirrors the AC's three-build
// comparison recipe.
// ---------------------------------------------------------------------------

const provenance = {
  recipeHash: "fixture-hash",
  appBuild: "1",
  processIdentity: { name: "dev.probe.fixture", pid: 111 },
  device: { name: "iPhone 13 Pro", udid: "udid-1", osVersion: "18.0" },
  xcodeVersion: "Xcode 16.0",
  xctraceVersion: "16.0",
  templateDigest: "preset:time-profiler",
  generatedAt: "2026-01-01T00:00:00.000Z",
}

const makeReport = (args: {
  readonly appBuild: string
  readonly cpuSamples: ReadonlyArray<number>
  readonly findings?: ReadonlyArray<PerfEvidenceFinding>
}): PerfEvidenceReport => ({
  provenance: { ...provenance, appBuild: args.appBuild },
  phases: [],
  channels: [{ channel: "cpu-samples", status: "available", rowCount: args.cpuSamples.length }],
  metrics: [{ key: "gpu-interval-duration-ns", unit: "ns", samples: args.cpuSamples }],
  findings: args.findings ?? [],
})

describe("ProbeFixture planted-regression recipe (fake capture lanes)", () => {
  const baselineReport = makeReport({ appBuild: "1", cpuSamples: [1_000_000, 1_050_000, 1_020_000] })
  const regressedReport = makeReport({ appBuild: "2", cpuSamples: [2_000_000, 2_100_000, 2_050_000] })
  const fixedReport = makeReport({ appBuild: "3", cpuSamples: [1_010_000, 1_030_000, 1_015_000] })

  test("baseline -> regressed identifies the planted channel as regressed", () => {
    const comparison: PerfEvidenceComparison = compareReports(baselineReport, regressedReport)
    expect(comparison.comparable).toBe(true)
    expect(deriveComparisonVerdict(comparison)).toBe("regressed")
    const regressedMetrics = identifyRegressedMetrics(comparison)
    expect(regressedMetrics.map((metric) => metric.key)).toEqual(["gpu-interval-duration-ns"])
  })

  test("regressed -> fixed reports improved (recovers toward baseline)", () => {
    const comparison = compareReports(regressedReport, fixedReport)
    expect(deriveComparisonVerdict(comparison)).toBe("improved")
  })

  test("baseline -> fixed reports unchanged (within noise threshold)", () => {
    const comparison = compareReports(baselineReport, fixedReport)
    expect(deriveComparisonVerdict(comparison)).toBe("unchanged")
  })

  test("mismatched provenance is never-comparable, never silently coerced into a verdict", () => {
    const mismatched = makeReport({ appBuild: "2", cpuSamples: [2_000_000] })
    const comparison = compareReports(
      baselineReport,
      { ...mismatched, provenance: { ...mismatched.provenance, device: { ...mismatched.provenance.device, udid: "udid-2" } } },
    )
    expect(comparison.comparable).toBe(false)
    expect(deriveComparisonVerdict(comparison)).toBe("not-comparable")
  })
})

describe("mergeInvestigationEvidenceReports", () => {
  test("pools every repetition's metric samples under the same key", () => {
    const reports = [
      makeReport({ appBuild: "1", cpuSamples: [1, 2] }),
      makeReport({ appBuild: "1", cpuSamples: [3, 4] }),
    ]
    const merged = mergeInvestigationEvidenceReports(reports)
    expect(merged.metrics).toEqual([{ key: "gpu-interval-duration-ns", unit: "ns", samples: [1, 2, 3, 4] }])
  })

  test("flattens and re-ranks findings across repetitions by confidence", () => {
    const highFinding: PerfEvidenceFinding = {
      id: "b-high", kind: "observation", summary: "b", windowLabel: "w", source: { schema: "s", rowSelector: "r" }, confidence: "high", basis: [],
    }
    const lowFinding: PerfEvidenceFinding = {
      id: "a-low", kind: "observation", summary: "a", windowLabel: "w", source: { schema: "s", rowSelector: "r" }, confidence: "low", basis: [],
    }
    const merged = mergeInvestigationEvidenceReports([
      makeReport({ appBuild: "1", cpuSamples: [1], findings: [lowFinding] }),
      makeReport({ appBuild: "1", cpuSamples: [2], findings: [highFinding] }),
    ])
    expect(merged.findings.map((finding) => finding.id)).toEqual(["b-high", "a-low"])
  })

  test("throws for an empty repetition list -- an investigation always measures at least one repetition", () => {
    expect(() => mergeInvestigationEvidenceReports([])).toThrow()
  })
})

describe("assembleInvestigationReport", () => {
  const finding = (id: string, confidence: "high" | "medium" | "low"): PerfEvidenceFinding => ({
    id,
    kind: "observation",
    summary: `summary ${id}`,
    windowLabel: "w",
    source: { schema: "s", rowSelector: "r" },
    confidence,
    basis: [],
  })

  test("diagnosis (no comparison) reports overallVerdict diagnosis and comparisonVerdict not-requested", () => {
    const merged = mergeAndRankFindings([[finding("a", "high")]])
    const report = assembleInvestigationReport({
      investigationId: "inv-1",
      recipeHash: "hash-1",
      status: "completed",
      findings: boundFindingsForTest(merged, 20),
      confidence: overallFindingsConfidence(merged),
      walls: [],
      comparison: null,
      repetitionReportKeys: ["rep-0"],
      generatedAt: "2026-01-01T00:00:00.000Z",
    })
    expect(report.overallVerdict).toBe("diagnosis")
    expect(report.comparisonVerdict).toBe("not-requested")
    expect(report.confidence).toBe("high")
  })

  test("before/after proof (with comparison) reports overallVerdict before-after-proof", () => {
    const comparison = compareReports(
      makeReport({ appBuild: "1", cpuSamples: [1_000_000] }),
      makeReport({ appBuild: "2", cpuSamples: [2_000_000] }),
    )
    const merged = mergeAndRankFindings([[finding("a", "high")]])
    const report = assembleInvestigationReport({
      investigationId: "inv-1",
      recipeHash: "hash-1",
      status: "completed",
      findings: boundFindingsForTest(merged, 20),
      confidence: overallFindingsConfidence(merged),
      walls: [],
      comparison,
      repetitionReportKeys: ["rep-0"],
      generatedAt: "2026-01-01T00:00:00.000Z",
    })
    expect(report.overallVerdict).toBe("before-after-proof")
    expect(report.comparisonVerdict).toBe("regressed")
  })

  test("bounds findings and reports the true total/omitted count", () => {
    const manyFindings = Array.from({ length: 30 }, (_, index) => finding(`f-${index}`, "low"))
    const merged = mergeAndRankFindings([manyFindings])
    const report = assembleInvestigationReport({
      investigationId: "inv-1",
      recipeHash: "hash-1",
      status: "completed",
      findings: boundFindingsForTest(merged, 10),
      confidence: overallFindingsConfidence(merged),
      walls: [],
      comparison: null,
      repetitionReportKeys: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
    })
    expect(report.findings.total).toBe(30)
    expect(report.findings.shown.length).toBe(10)
    expect(report.findings.omitted).toBe(20)
  })

  test("overall confidence is the worst confidence across every finding", () => {
    const merged = mergeAndRankFindings([[finding("a", "high"), finding("b", "low")]])
    const report = assembleInvestigationReport({
      investigationId: "inv-1",
      recipeHash: "hash-1",
      status: "completed",
      findings: boundFindingsForTest(merged, 20),
      confidence: overallFindingsConfidence(merged),
      walls: [],
      comparison: null,
      repetitionReportKeys: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
    })
    expect(report.confidence).toBe("low")
  })
})

// Type-only sanity: `InvestigationRecipe` stays structurally what the tests
// above assume.
const _typeCheck: InvestigationRecipe = decodeInvestigationRecipe(baseRecipe)
void _typeCheck
