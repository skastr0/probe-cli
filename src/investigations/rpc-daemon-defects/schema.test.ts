import { describe, expect, test } from "bun:test"
import {
  decodeInvestigationReport,
  deriveOverallVerdict,
  encodeInvestigationReport,
  INVESTIGATION_SCHEMA_VERSION,
  type DefectFinding,
  type InvestigationReport,
} from "./schema"

const finding = (verdict: DefectFinding["verdict"]): DefectFinding => ({
  id: "fixture-finding",
  category: "detached-rpc-work",
  verdict,
  summary: "fixture",
  evidence: ["fixture evidence"],
  metrics: { count: 1 },
})

const sampleReport: InvestigationReport = {
  schemaVersion: INVESTIGATION_SCHEMA_VERSION,
  glyphId: "PRB-087",
  provenance: {
    generatedAt: "2026-07-13T00:00:00.000Z",
    gitSha: "abc123",
    gitBranch: "prb/prb-087",
    gitDirty: false,
    host: {
      platform: "darwin",
      arch: "arm64",
      bunVersion: "1.3.14",
      xcodeVersion: "Xcode 26.3",
    },
  },
  lanes: {
    simulator: {
      lane: "simulator",
      status: "ran",
      summary: "fixture simulator lane",
      details: [],
      receipts: [],
    },
    device: {
      lane: "device",
      status: "attempted-failed",
      summary: "fixture device lane",
      details: [],
      receipts: [],
    },
  },
  findings: [finding("red")],
  overallVerdict: "red",
  notes: [],
}

describe("investigation report schema", () => {
  test("round-trips through encode/decode without loss", () => {
    const encoded = encodeInvestigationReport(sampleReport)
    const decoded = decodeInvestigationReport(encoded)
    expect(decoded).toEqual(sampleReport)
  })

  test("rejects an unknown glyph id", () => {
    expect(() => decodeInvestigationReport({ ...sampleReport, glyphId: "PRB-999" })).toThrow()
  })

  test("rejects a defect category outside the known set", () => {
    const malformed = {
      ...sampleReport,
      findings: [{ ...finding("red"), category: "unknown-category" }],
    }
    expect(() => decodeInvestigationReport(malformed)).toThrow()
  })
})

describe("deriveOverallVerdict", () => {
  test("is red when any finding is red", () => {
    expect(deriveOverallVerdict([finding("green"), finding("red"), finding("not-run")])).toBe("red")
  })

  test("is green when no finding is red", () => {
    expect(deriveOverallVerdict([finding("green"), finding("not-run")])).toBe("green")
  })

  test("is green for an empty finding set", () => {
    expect(deriveOverallVerdict([])).toBe("green")
  })
})
