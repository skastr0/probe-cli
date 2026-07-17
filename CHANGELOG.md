# Changelog

All notable changes to Probe will be documented in this file.

Probe is pre-1.0. End users can install it from npm via `@skastr0/probe`; source checkout plus local Bun install remains the development path.

## Unreleased

- Removed the `probe.session-flow/v1` flow contract, its decoder, its `probe.session-flow/report-v1` result contract, and the v1 planner branch. `probe.session-flow/v2` is now the single canonical session-flow contract (PRB-082).
- Migration: re-tag a v1 flow's `"contract"` field as `"probe.session-flow/v2"` — existing v1 step shapes decode unchanged under v2. Old v1 input now fails closed with a typed `UnsupportedFlowContractError` (`code: "unsupported-flow-contract"`) instead of silently decoding through a compatibility adapter.

## 0.1.0 - 2026-06-03

- Initial public release surface for the experimental Probe CLI.
- Daemon-first iOS runtime controller with simulator and real-device session work.
- npm distribution through `@skastr0/probe` plus macOS native binary packages.
- Source checkout plus local Bun install remains supported for development.
- Standalone GitHub Release binaries and Homebrew distribution are deferred until the package and release asset contracts are validated.
