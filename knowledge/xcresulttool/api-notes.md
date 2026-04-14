# xcresulttool API notes

## Core commands

- Summary JSON:
  - `xcrun xcresulttool get test-results summary --path <bundle> --compact`
- Full test tree JSON:
  - `xcrun xcresulttool get test-results tests --path <bundle> --compact`
- Per-test details JSON:
  - `xcrun xcresulttool get test-results test-details --path <bundle> --test-id <id> --compact`
- Attachment export with manifest:
  - `xcrun xcresulttool export attachments --path <bundle> --output-path <dir>`
  - Emits exported files plus `manifest.json`
- Coverage from a result bundle:
  - `xcrun xccov view --report --json <bundle>`

## Observed output shape highlights

- `summary` includes bundle-level counts, environment description, top insights, statistics, and failure summaries.
- `tests` returns a recursive `testNodes` tree with node types like:
  - `Test Suite`
  - `Test Case`
  - `Test Case Run`
  - `Failure Message`
  - `Attachment`
  - `Runtime Warning`
- `export attachments` produces a manifest with:
  - test identifier
  - exported file name
  - suggested human-readable name
  - failure association
  - device/config metadata
- `xccov view --report --json <bundle>` returns top-level coverage totals plus per-target summaries.

## Probe-facing implication

- For a compact agent-facing drill surface, use:
  - `summary` + `tests` for structured test results
  - `export attachments` for list/drill attachment flows
  - `xccov` for coverage, because current `xcresulttool` help does not expose coverage summaries directly in the `get test-results` family
