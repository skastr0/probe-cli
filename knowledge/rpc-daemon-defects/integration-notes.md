# RPC daemon defects: integration notes for later glyphs

Accessed: 2026-07-13

This pack backs `src/investigations/rpc-daemon-defects/`, PRB-087's benchmark/report/provenance
harness. Per the superseding acceptance gates on PRB-087, this glyph **records** the four known
defects below as expected-red observations; it does not fix them. A later glyph should read this
pack and `baselines/v1.json` before attempting a fix, then ratchet the same harness back to green.

## How to run it

```
bun run benchmark:investigation
```

Writes a fresh `knowledge/rpc-daemon-defects/baselines/v1.json` and prints the same report to
stdout. The four scenario functions are also exercised directly by `bun test` (see the
`*.test.ts` files next to each scenario/lane), so `bun run test` is a fast, CI-capable proxy for
"do the known defects still reproduce" without needing to run the full investigation script.

## Fix-order suggestion (not required by PRB-087, offered for the follow-up glyph)

1. **Artifact race / eager export** share one root cause — give `registerArtifact` either a
   per-session mutex (Probe already uses `Effect.makeSemaphore` elsewhere, e.g.
   `src/services/SessionRegistry.ts`'s `openMutex`) or an atomic compare-and-swap on the index
   file. Fixing this one root cause should flip both findings to green.
2. **Detached RPC work** — give `serveRpc`'s per-connection request handling a real child fiber
   (`Effect.forkScoped` or equivalent) instead of a bare `Effect.runPromise`, so daemon shutdown
   can interrupt in-flight requests instead of outliving them.
3. **Ambiguous mutation delivery** — once (2) is fixed, decide a real contract for `sequence`:
   either the client validates contiguity and surfaces a typed error on a gap, or the field is
   removed and replaced with an explicit "events complete" marker in the terminal frame.

## What this harness deliberately does not cover

- It does not install or launch the Probe XCUITest runner app on a simulator or device — that
  requires the full `ios/` Xcode build pipeline, which is out of scope for a defect-investigation
  benchmark. The simulator lane proves boot/shutdown is CI-capable; it is not a live-session lane.
- It does not attempt to trigger the "detached late `emit()` write reaches an already-`.end()`ed
  client socket" path end-to-end inside `bun test`, because reproducing it safely requires
  destroying a live client connection mid-request (see `sources.md`'s empirical checks) and this
  harness prioritized a deterministic, always-safe reproduction over a maximally dramatic one. The
  detached-RPC-work scenario still proves the underlying defect (work outlives daemon shutdown).
