# Probe Knowledge Base

This folder stores durable research packs for Apple/Xcode utilities, Effect/CLI design, and other integration seams used by Probe.

## Rules
- Check `knowledge/` before starting new utility or API research.
- Reuse and update existing packs instead of creating duplicates.
- Prefer official documentation and primary sources first.
- Distinguish observed facts from inferred guidance.
- Capture enough detail that later work items can integrate without redoing the same research pass.

## Recommended Pack Shape

```text
knowledge/
  <topic>/
    sources.md          # primary links, versions, doc pages, repos
    api-notes.md        # relevant commands, flags, APIs, schemas
    integration-notes.md# best practices, caveats, compatibility notes
    open-questions.md   # unresolved items that still need validation
```

## Workflow
1. Look for an existing topic folder.
2. If it exists and is sufficient, cite it and continue.
3. If it is missing or stale, update or create the topic folder first.
4. Keep research packs organized around reusable seams like `xctrace`, `xcuitest-runner`, `lldb-python`, or `effect-cli-daemon`.

## Current Expectation
The first batch of utility-facing SDLC items should produce reusable packs here before implementation expands.
