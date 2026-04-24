# Flow examples for `probe session run`

Run any example with:

```bash
probe session run --session-id <id> --file docs/examples/flows/<example>.json --output-json
```

## Examples

- `verified-only-v1.json` — existing verified-only flow style with the v1 contract
- `fast-final-assert-v2.json` — fast mutations followed by one verified assert
- `mixed-mode-v2.json` — verified evidence steps mixed with fast mutations
- `sequence-batch-v2.json` — explicit runner-batched `sequence` step with an end checkpoint

## Fast vs verified

- `verified` steps keep the host in the loop and preserve the old evidence-heavy behavior
- `fast` steps skip host snapshots around supported mutations to reduce round-trips
- Use a final verified `assert`, a `snapshot`, or `sequence.checkpoint: "end"` when you need proof of final state
