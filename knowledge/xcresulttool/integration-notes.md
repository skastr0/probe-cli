# xcresulttool integration notes

## Recommended integration path

1. Treat `.xcresult` as a bundle-aware drill surface, not a normal directory drill.
2. Use `xcresulttool get test-results summary` for bundle-level counts and failures.
3. Use `xcresulttool get test-results tests` to flatten test cases with pass/fail and duration.
4. Use `xccov view --report --json` against the `.xcresult` bundle for coverage totals.
5. Use `xcresulttool export attachments` to materialize a manifest plus exported files for attachment listing and per-attachment drill.

## Caveats

- `xccov` may emit log noise before the JSON payload on stdout; JSON extraction should tolerate leading non-JSON lines.
- Attachment listing is easiest through export + manifest rather than trying to reconstruct attachment paths directly from the nested test tree.
- Exported attachment paths are temporary unless Probe copies the chosen attachment into the session outputs area.
- Result bundles are directories, so generic text/JSON/XML drill rules should not claim to support them directly.

## Probe implementation choices for work item 055

- Keep the daemon RPC shape stable by reusing `artifact.drill` with a new `xcresult` query variant.
- Return structured JSON for summary and attachment-list views.
- Return copied artifacts for binary attachments so the user gets a durable session-scoped path.
