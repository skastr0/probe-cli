import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { validateInvestigationRecipe } from "./investigation"

// PRB-099 review fix (AC#9, minor): "ripple onboarding-to-breathing-scene
// recipe completes 20/20 captures on iPhone 13 Pro" is environmentally
// blocked on this host (no DEVELOPMENT_TEAM signing, so no real-device
// session -- and no live accessibility snapshot to author real navigation
// steps from either). The non-environmental half of that AC is a produced
// recipe artifact -- docs/examples/investigations/*.json -- and this test is
// its attempt receipt: every recipe there is schema/domain-valid, glob-
// discovered (never enumerated by name, mirroring
// services/flowExampleInventory.ts's convention for docs/examples/flows) so
// a future addition is checked automatically. This is deliberately a small
// standalone inventory rather than an extension of
// services/flowExampleInventory.ts -- that module decodes every discovered
// file as a `probe.session-flow/v2` flow contract; an investigation recipe
// is a structurally different top-level shape (target/measuredFlow/capture/
// repetitions/cooldown), so folding it in would need a second decode branch
// keyed by root, a larger change than this minor finding's ask.
const investigationExamplesRoot = join(import.meta.dir, "..", "..", "docs", "examples", "investigations")

const discoverInvestigationExampleFiles = (): ReadonlyArray<{ readonly fileName: string; readonly raw: unknown }> =>
  readdirSync(investigationExamplesRoot)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => ({
      fileName,
      raw: JSON.parse(readFileSync(join(investigationExamplesRoot, fileName), "utf8")) as unknown,
    }))

const examples = discoverInvestigationExampleFiles()

describe("investigation recipe example inventory (docs/examples/investigations)", () => {
  test("glob discovery finds at least one investigation recipe example", () => {
    expect(examples.length).toBeGreaterThan(0)
  })

  for (const example of examples) {
    test(`${example.fileName} decodes and passes domain validation`, () => {
      const validation = validateInvestigationRecipe(example.raw)
      expect(validation).toEqual({ ok: true, violations: [] })
    })
  }

  test("ripple-onboarding-to-breathing-scene.json declares 20 repetitions (AC#9's \"20/20 captures\")", () => {
    const recipe = examples.find((example) => example.fileName === "ripple-onboarding-to-breathing-scene.json")
    expect(recipe).toBeDefined()
    expect((recipe?.raw as { readonly repetitions: number }).repetitions).toBe(20)
  })
})
