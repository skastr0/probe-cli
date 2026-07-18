# Flow examples for `probe session run`

Run any example with:

```bash
probe session run --session-id <id> --file docs/examples/flows/<example>.json --output-json
```

## Examples

- `verified-only-v2.json` — verified-only flow style, same step kinds as the original flow contract
- `fast-final-assert-v2.json` — fast mutations followed by one verified assert
- `mixed-mode-v2.json` — verified evidence steps mixed with fast mutations
- `sequence-batch-v2.json` — explicit runner-batched `sequence` step with an end checkpoint (requires the `uiActionBatch` runner capability, which the production Swift runner does not implement yet — see below)

`probe.session-flow/v2` is the single canonical flow contract. `probe.session-flow/v1` was removed; old v1 input now fails with a typed `unsupported-flow-contract` error that names the migration step (re-tag `contract` as `probe.session-flow/v2` — step shapes are unchanged).

## Validation (PRB-071)

Every file in this directory is glob-discovered, decoded, and domain-validated in `src/services/flowExampleInventory.test.ts`, which runs as part of `bun test`/`bun run verify`. Adding a new example that fails to decode, violates fast/verified execution rules, or requires a runner capability the production runner does not implement yet fails that suite automatically — unless the capability gap is deliberately named in `KNOWN_PENDING_CAPABILITY_EXAMPLES` (`src/services/flowExampleInventory.ts`), the single source of truth both the schema test and `scripts/validate-product-flow.ts` read from.

`sequence-batch-v2.json` is the one currently-known pending-capability example: `RUNNER_CAPABILITY_REGISTRY` marks `uiActionBatch` as `implementedInSwift: false`, so it is reported as an explicit skip rather than a pass in both the schema test and product validation, until the runner ships batch support.

Representative examples that target `fixture.*` identifiers are additionally executed end to end against a live ProbeFixture session by `scripts/validate-product-flow.ts` (`--target simulator`, default bundle id) — schema validation alone cannot catch a stale accessibility identifier, only running the flow against the real app can.

## Fast vs verified

- `verified` steps keep the host in the loop and preserve the old evidence-heavy behavior
- `fast` steps skip host snapshots around supported mutations to reduce round-trips
- Use a final verified `assert`, a `snapshot`, or `sequence.checkpoint: "end"` when you need proof of final state
