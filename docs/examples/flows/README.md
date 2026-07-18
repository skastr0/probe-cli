# Flow examples for `probe session run`

Run any example with:

```bash
probe session run --session-id <id> --file docs/examples/flows/<example>.json --output-json
```

## Examples

- `verified-only-v2.json` — verified-only flow style, same step kinds as the original flow contract
- `fast-final-assert-v2.json` — fast mutations followed by one verified assert
- `mixed-mode-v2.json` — verified evidence steps mixed with fast mutations
- `sequence-batch-v2.json` — explicit runner-batched `sequence` step with an `evidencePolicy: { success: "end" }` post-batch capture (requires the `uiActionBatch` runner capability, which the production Swift runner implements — see below)

`probe.session-flow/v2` is the single canonical flow contract. `probe.session-flow/v1` was removed; old v1 input now fails with a typed `unsupported-flow-contract` error that names the migration step (re-tag `contract` as `probe.session-flow/v2` — step shapes are unchanged).

## Validation (PRB-071)

Every file in this directory is glob-discovered, decoded, and domain-validated in `src/services/flowExampleInventory.test.ts`, which runs as part of `bun test`/`bun run verify`. Adding a new example that fails to decode, violates fast/verified execution rules, or requires a runner capability the production runner does not implement yet fails that suite automatically — unless the capability gap is deliberately named in `KNOWN_PENDING_CAPABILITY_EXAMPLES` (`src/services/flowExampleInventory.ts`), the single source of truth both the schema test and `scripts/validate-product-flow.ts` read from.

`KNOWN_PENDING_CAPABILITY_EXAMPLES` is currently empty (PRB-092): `RUNNER_CAPABILITY_REGISTRY` marks both `uiAction` and `uiActionBatch` as `implementedInSwift: true`, boundary-tested against a live Simulator session (see `RUNNER_CAPABILITY_REGISTRY`'s evidence strings in `src/services/runnerCapabilities.ts`), so every example in this directory — including `sequence-batch-v2.json` — runs as a real pass in both the schema test and product validation.

Representative examples that target `fixture.*` identifiers are additionally executed end to end against a live ProbeFixture session by `scripts/validate-product-flow.ts` (`--target simulator`, default bundle id) — schema validation alone cannot catch a stale accessibility identifier, only running the flow against the real app can.

## Fast vs verified

- `verified` steps keep the host in the loop for target resolution
- `fast` steps resolve targets on-device to reduce round-trips
- Both lanes share one canonical evidence policy (PRB-093, see `src/domain/evidence.ts`): `evidencePolicy.success` is `none` (zero discretionary snapshots), `end` (one post-mutation/post-sequence snapshot — the default), or `around` (one pre and one post, always fresh); `evidencePolicy.failure` is `none` or `snapshot` (best-effort, default). Use a final verified `assert`, a `snapshot`, or `sequence.evidencePolicy: { success: "end" }` when you need proof of final state.
- **Migration note for `sequence` steps (PRB-093):** before this glyph, an omitted `checkpoint` field defaulted to `"none"` — a batch that captured nothing on success. `checkpoint` is gone; an omitted `evidencePolicy` now defaults to `success: "end"` — one post-batch snapshot, regardless of child count. A caller that relied on the old zero-capture default and wants it back sets `evidencePolicy: { success: "none" }` explicitly. A payload still sending the deleted `checkpoint` field is rejected with a typed decode error (PRB-103) rather than silently ignored — the field's absence from the decoded step used to look identical to "I didn't ask for capture," which masked exactly this default change.
