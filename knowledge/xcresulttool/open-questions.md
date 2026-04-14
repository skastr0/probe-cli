# xcresulttool open questions

- Verify on a real runner-produced `.xcresult` whether `summary.testFailures` is always an array; the published schema snippets are inconsistent.
- Validate whether Probe should expose richer per-test activity trees (`activities`) in a follow-up drill view.
- Decide later whether attachment drill should support deeper queries for exported JSON/XML/text attachments instead of returning the full content directly.
