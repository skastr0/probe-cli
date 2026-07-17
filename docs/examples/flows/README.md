# Flow examples for `probe session run`

Run any example with:

```bash
probe session run --session-id <id> --file docs/examples/flows/<example>.json --output-json
```

## Examples

- `verified-only-v2.json` — verified-only flow style, same step kinds as the original flow contract
- `fast-final-assert-v2.json` — fast mutations followed by one verified assert
- `mixed-mode-v2.json` — verified evidence steps mixed with fast mutations
- `sequence-batch-v2.json` — explicit runner-batched `sequence` step with an end checkpoint

`probe.session-flow/v2` is the single canonical flow contract. `probe.session-flow/v1` was removed; old v1 input now fails with a typed `unsupported-flow-contract` error that names the migration step (re-tag `contract` as `probe.session-flow/v2` — step shapes are unchanged).

## Fast vs verified

- `verified` steps keep the host in the loop and preserve the old evidence-heavy behavior
- `fast` steps skip host snapshots around supported mutations to reduce round-trips
- Use a final verified `assert`, a `snapshot`, or `sequence.checkpoint: "end"` when you need proof of final state
