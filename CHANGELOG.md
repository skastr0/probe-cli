# Changelog

All notable changes to Probe will be documented in this file.

Probe is pre-1.0. End users can install it from npm via `@skastr0/probe`; source checkout plus local Bun install remains the development path.

## Unreleased

- Removed the `probe.session-flow/v1` flow contract, its decoder, its `probe.session-flow/report-v1` result contract, and the v1 planner branch. `probe.session-flow/v2` is now the single canonical session-flow contract (PRB-082).
- Migration: re-tag a v1 flow's `"contract"` field as `"probe.session-flow/v2"` — existing v1 step shapes decode unchanged under v2. Old v1 input now fails closed with a typed `UnsupportedFlowContractError` (`code: "unsupported-flow-contract"`) instead of silently decoding through a compatibility adapter.
- The production Swift runner now implements `uiActionBatch`: it decodes a batch of child actions, executes them in order, stops at the first failure, and reports completed count, failed child index/kind, per-child timing, and total timing — even on partial failure. `RUNNER_CAPABILITY_REGISTRY` marks `uiActionBatch` `implementedInSwift: true`, boundary-tested against a live Simulator session; the ready frame now advertises it (PRB-092).
- Added a new `multiTap` action: `target`, `tapCount` (2..20), and a bounded `interTapDelayMs` (0..500ms). The selector resolves exactly once; `multiTap` works as a direct `session action`, a `session run` flow step, and a `sequence` batch child through one domain schema. A five-tap `multiTap` request is one RPC, one runner command, and five discrete tap events, with no host snapshots in between (PRB-092).

## 0.1.0 - 2026-06-03

- Initial public release surface for the experimental Probe CLI.
- Daemon-first iOS runtime controller with simulator and real-device session work.
- npm distribution through `@skastr0/probe` plus macOS native binary packages.
- Source checkout plus local Bun install remains supported for development.
- Standalone GitHub Release binaries and Homebrew distribution are deferred until the package and release asset contracts are validated.
