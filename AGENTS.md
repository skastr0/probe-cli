# Probe Agent Guide

## Project Intent
- Build Probe as a daemon-first, agent-first iOS runtime controller.
- Prefer public Apple/Xcode surfaces, explicit capability reporting, and honest handling of hard walls.
- Keep token efficiency as a product feature: structured JSON, compact refs, artifact offload, and drill-based follow-up.

## Stack and Tooling Constraints
- Host runtime: TypeScript on Effect.
- Package manager: `bun` only.
- Favor a single long-lived daemon runtime over per-command process-local state.
- Treat Apple/Xcode utilities as integration boundaries that need deliberate contracts and validation.

## Research and Knowledge Workflow
- Any work item that integrates with Apple/Xcode utilities, third-party utilities, or external APIs must begin by checking `knowledge/` for an existing research pack.
- If a relevant research pack exists, reuse and extend it instead of duplicating research.
- If no relevant pack exists, do a research-orchestration pass first: gather official docs, best practices, caveats, and relevant API references before implementation.
- Save durable findings under `knowledge/<topic>/` so later work items can reuse them.
- Keep research idempotent: update the existing pack for a utility/integration seam rather than creating multiple competing folders.
- Implementation work should cite or reference the knowledge pack it relied on in work item notes.

## Effect and CLI Rule
- Any work item touching the host CLI, daemon, RPC, command handling, child-process supervision, runtime wiring, or session orchestration must load the `effect` skill first.
- Any delegated subagent working on CLI-host concerns must be explicitly instructed to load and follow the `effect` skill before designing or implementing changes.
- Prefer `ManagedRuntime`, `Layer.scoped`, typed services, and structured resource lifecycles over ad hoc process management.

## Work Item Naming and Sequencing
- Top-level SDLC work items use `NNN-name.md` where `NNN` is a zero-padded sequence number.
- Child or prerequisite items use `NNNa-name.md`, `NNNb-name.md`, `NNNc-name.md`, and so on.
- The `id` field inside each work item must start with the same sequence prefix as the filename.
- Prefer adding child items or new sequence entries over renumbering established items.
- Use sequence order to make prerequisites visible in the filesystem.

## Anti-Patterns to Avoid
- ❌ Integrating with `xcodebuild`, `simctl`, `devicectl`, `xctrace`, `lldb`, `log`, or similar utilities from memory alone.
- ❌ Repeating the same docs research in multiple work items instead of updating a shared knowledge pack.
- ❌ Building CLI-host behavior without loading Effect guidance first.
- ❌ Hiding Apple tooling hard walls behind vague “not working” notes.
- ❌ Letting output and artifact policy emerge implicitly instead of treating it as a first-class contract.
- ✅ Reuse knowledge, cite sources, document capability gaps, and keep the work item sequence explicit.
