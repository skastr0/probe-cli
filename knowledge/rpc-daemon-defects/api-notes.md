# RPC daemon defects: API / behavior notes

Accessed: 2026-07-13

Legend:

- **Observed** = directly reproduced by the harness in `src/investigations/rpc-daemon-defects/`.
- **Inference** = derived from reading the source, not independently reproduced.

## Detached RPC work — Observed

`serveRpc` (`src/rpc/server.ts:48-241`) wraps its own lifecycle in `Effect.scoped(Effect.acquireRelease(...))`, so interrupting the fiber running `serveRpc` runs the release effect (`server.close()`, socket `unlink`, `onMetadataRemove()`). Each accepted connection's request handling, however, is dispatched at line 148 as:

```ts
Effect.runPromise(Effect.either(config.onRequest(request, emit))).then(...)
```

`Effect.runPromise` starts a brand-new top-level Effect run; it is not a child fiber of `serveRpc`'s own scope. `src/investigations/rpc-daemon-defects/scenarios/detachedRpcWork.ts` proves this by starting `serveRpc`, sending a request whose handler sleeps 150ms, interrupting the daemon fiber ~40ms in, and observing that the handler still settles ~110ms after the interrupt resolves — i.e. after the daemon has already released its socket and metadata.

## Ambiguous mutation delivery — Observed

`RpcProgressEvent` (`src/rpc/protocol.ts:673-688`) carries a `sequence: Schema.Number` field. Neither `src/rpc/server.ts` (which just forwards whatever the handler passes to `emit`) nor `src/rpc/client.ts:265-268` (`if (frame.kind === "event") { options.onEvent?.(frame); continue }`) inspects it. `src/investigations/rpc-daemon-defects/scenarios/ambiguousMutationDelivery.ts` emits sequence `1` then `5` (modelling events 2-4 being dropped) and shows the client resolves the request successfully with no error and no way for a caller to know the stream had a gap.

## Artifact races and eager export — Observed

`ArtifactStore.registerArtifact` (`src/services/ArtifactStore.ts:509-517`) is a non-atomic read-modify-write over a single JSON index file:

```ts
const existing = yield* readArtifactIndex(sessionId)
const next = [...existing.filter((entry) => entry.key !== normalizedRecord.key), normalizedRecord]
yield* writeArtifactIndex(sessionId, next)
```

`readArtifactIndex`/`writeArtifactIndex` (`src/services/ArtifactStore.ts:258-293`) have no lock, version check, or atomic append. Two concurrent registrations for the same session can both read the pre-write index and the later write silently clobbers the earlier one. Because `registerArtifact` always resolves successfully on the happy path (it never re-reads to confirm its own write survived), a caller — e.g. `exportRecording` (`src/services/SessionRegistry.ts:5949-6000`) or `writeJsonArtifact` (`src/services/SessionRegistry.ts:2215-2254`) — can report "export succeeded" for an artifact that is not durably discoverable moments later. `src/investigations/rpc-daemon-defects/scenarios/artifactRaceAndEagerExport.ts` reproduces this at a 100% rate over 16 trials on this host (see `baselines/v1.json`).

Note: this scenario exercises a faithful mirror of the algorithm against a temp directory, not the real `ArtifactStoreLive` layer — see `open-questions.md` for why.

## Simulator vs. device lane — Observed

- Simulator lane: `xcrun simctl list devices available --json` → `xcrun simctl boot <udid>` (skipped if already `Booted`) → confirm via `xcrun simctl list devices <udid> --json` → `xcrun simctl shutdown <udid>` if this run performed the boot. All CI-capable and deterministic in shape; timing varies with host load.
- Device lane: `xcrun devicectl list devices --json-output <path>` (matches the existing invocation in `src/services/RealDeviceHarness.ts:2026-2028` and the interface documented in `knowledge/devicectl-device-signing/api-notes.md`). Always attempted; "no device attached" or a command failure is reported as an explicit `attempted-failed` lane result, never silently skipped.
