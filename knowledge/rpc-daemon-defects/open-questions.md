# RPC daemon defects: open questions

Accessed: 2026-07-13

## Resolved for this investigation

1. **The literal PRB-087 glyph spec file was not resolvable in this workspace.**
   - The task setup referenced a glyph spec at a path this session could not resolve to a real
     file, and this session was instructed not to read or write Tower directly. The four defect
     category names (ambiguous mutation delivery, eager export, artifact races, detached RPC
     work) and the superseding acceptance gates (versioned harness + deterministic simulator
     fixture workloads + immutable baseline capture, red allowed) were relayed directly in the
     task prompt instead, and this pack + the harness were built against that relay plus direct
     reading of `src/rpc/` and `src/services/ArtifactStore.ts`/`SessionRegistry.ts`.
   - **Why it's safe to proceed on:** none of the four defect names or their line-cited mechanisms
     appear anywhere else in this repo's source or `knowledge/`, so they are not a pre-existing
     documented contract this work could contradict — they are new findings this glyph is meant to
     formalize. If a later reader has the original glyph text and it names different concrete
     mechanisms than the ones documented in `api-notes.md`, treat this pack's interpretation as
     superseded and update it.

2. **`ArtifactStoreLive`'s root directory is not injectable, and Bun's `os.homedir()` ignores a
   `HOME` env override at call time (verified empirically, see `sources.md`).**
   - **Decision:** the artifact-race and eager-export scenarios exercise a faithful, line-cited
     mirror of `registerArtifact`'s read-modify-write algorithm against a temp directory rather
     than the real singleton service, to avoid writing to the operator's real `~/.probe` artifact
     root during an automated benchmark/test run.
   - **Follow-up worth filing separately (not done here — out of scope for PRB-087):**
     `ArtifactStoreLive` taking an injectable root (e.g. via a config service or constructor
     argument) would make it directly unit-testable and would let a future fix-verification pass
     exercise the real service instead of a mirror.

## Still open

1. **Does the real production impact match the reproduction rate measured here?** The 100%
   reproduction rate for the artifact race was measured on one host's local filesystem with 16
   trials. It has not been measured against the artifact root's actual storage characteristics in
   a deployed daemon (e.g. network filesystem latency), which could change the race window.
2. **Is the "sequence gap" framing the right shape for the mutation-delivery fix?** `api-notes.md`
   suggests either enforcing contiguity or removing `sequence` in favor of an explicit
   "events-complete" marker; this pack does not take a position on which is correct for Probe's
   actual RPC consumers (CLI progress rendering, MCP-style callers, etc.).
3. **Full end-to-end simulator-session lane.** The current simulator lane only proves
   boot/shutdown is possible; a stronger later baseline could drive a real Probe session (open →
   screenshot → export) against a booted simulator through the actual daemon/RPC stack, which
   would let the artifact-race/eager-export findings be reproduced against the real
   `ArtifactStoreLive` service end-to-end instead of the mirror described above.
