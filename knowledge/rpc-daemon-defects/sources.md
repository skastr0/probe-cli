# RPC daemon defects investigation sources

Accessed: 2026-07-13

## Local context used

| Source | Why it matters |
| --- | --- |
| `src/rpc/server.ts` | Daemon-side RPC socket loop; source of the detached-RPC-work finding (line 148) and the unacknowledged-event write path used by the mutation-delivery finding. |
| `src/rpc/client.ts` | Client-side RPC socket loop; source of the event-vs-response handling that never validates `sequence` (lines 265-268). |
| `src/rpc/protocol.ts` | `RpcProgressEvent` schema (line 679) declares `sequence` with no producer/consumer enforcement. |
| `src/services/ArtifactStore.ts` | `registerArtifact` (lines 509-517) and its `readArtifactIndex`/`writeArtifactIndex` helpers (lines 258-293); source of the artifact-race and eager-export findings. |
| `src/services/SessionRegistry.ts` | `exportRecording` (lines 5949-6000) and `writeJsonArtifact` (lines 2215-2254); shows production callers that trust a resolved `registerArtifact` call as durable export success. |
| `src/rpc/socket.test.ts` | Existing idiom for driving `serveRpc` directly in tests (`Effect.runFork` + `Fiber.interrupt`, `withTempSocketRoot`, `waitForSocket`, raw socket helpers) that this investigation's fixtures reuse. |
| `src/spikes/runner-transport/benchmark.ts` | Precedent for a standalone `bun run`-able benchmark script that writes a versioned JSON report under `knowledge/`. |
| `knowledge/README.md` | Defines the reusable pack shape this pack follows. |
| `knowledge/devicectl-device-signing/api-notes.md` | Confirms `devicectl list devices --json-output <path>` as the only supported machine-readable devicectl interface, reused by the device lane. |
| PRB-087 glyph notes (relayed directly in the task prompt; the canonical glyph file path was not resolvable in this workspace — see `open-questions.md`) | Defines the superseding acceptance gates this investigation implements: a versioned benchmark/report/provenance harness, deterministic simulator fixture workloads, and an immutable (possibly red) baseline capture. |

## Empirical checks performed on this host

| Check | Command | Result |
| --- | --- | --- |
| Bun's `os.homedir()` HOME-override behavior | `bun -e 'import {homedir} from "node:os"; process.env.HOME="/tmp/x"; console.log(homedir())'` | Does **not** pick up the override (prints the real home directory both before and after reassigning `process.env.HOME`), unlike Node's documented POSIX behavior. This is why the artifact-race/eager-export scenarios exercise a faithful mirror of `ArtifactStore`'s algorithm against a temp directory instead of the real `ArtifactStoreLive` layer. |
| `net.Socket#write()` after the peer destroys its end, no callback | throwaway script (see PRB-087 session transcript) | Does not throw synchronously and does not crash the process on Bun 1.3.14 (macOS arm64); the write silently no-ops. |
| `net.Server#close()` with an open connection | throwaway script | Blocks until the open connection closes/is destroyed, confirming why the detached-RPC-work scenario must destroy its client socket before interrupting the daemon fiber. |
| Concurrent `registerArtifact`-shaped read-modify-write | 16-trial throwaway script | Lost one of two concurrent registrations in 16/16 trials on this host's filesystem. |
