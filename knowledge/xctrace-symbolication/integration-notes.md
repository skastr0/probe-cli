# Pragmatic leaf-PC symbolication for Probe

Updated: 2026-07-28

Legend: **Observed** = cited/tool-backed · **Inference** = Probe guidance

## Problem

Time Profiler `time-sample` export gives `cp-user-callstack` / `cp-kernel-callstack` as engineering type `kperf-bt`. Probe already parses leaf PCs:

- nested `<text-address>` decimal → `0x…`
- fallback first of `<text-addresses>` chain
- fallback `fmt` `PC:0x…`

Those PCs are runtime virtual addresses (ASLR-slid). Agents need function names, not hex soup — without building a full Instruments clone.

## What export already gives (and does not)

| Surface | Useful for symbols? | Notes |
| --- | --- | --- |
| `time-sample` + `kperf-bt` | raw PCs only | Probe baseline; leaf heat works for before/after diffs |
| `time-profile` | **maybe** named frames | TOC-present on Time Profiler; row data workload-dependent on ProbeFixture idle runs. Community (post-14.3) claims `<frame name="…">`. **Revalidate before depending.** |
| TOC `<processes>` | binary path (host for sim) | Path only — not load address |
| `export --xpath '…/processes'` | **load addr + UUID + arch + path** | Documented man-page example; **primary image map for atos** |
| `xctrace symbolicate` | mutates `.trace` with dSYMs | Good for opening in Instruments; do **not** assume it rewrites exported `kperf-bt` to names without a spike |
| `--har` | n/a | HTTP only |

**Observed (Probe):** export does **not** currently ship human-readable symbols in the `time-sample` path Probe uses. Analyzer explicitly notes "symbolication still needs binary/atos".

**Inference:** Do not promise “export is already symbolicated.” Treat symbols as a post-export, best-effort enrichment.

## atos contract (host macOS)

```bash
# Batch unique leaf PCs only (MVP)
xcrun atos \
  -arch arm64 \
  -o /path/to/App.app.dSYM \
  -l 0xLOAD_ADDRESS \
  -f /tmp/leaves.txt
# leaves.txt: one hex address per line (0x…)

# Equivalent: binary instead of dSYM (when not stripped / debug)
xcrun atos -arch arm64 -o /path/to/App.app/AppBinary -l 0xLOAD 0xPC1 0xPC2

# Interactive / stdin if no args: omit -f and trailing addrs
```

**Observed (man atos):**

- `-o` accepts Mach-O binary **or** `.dSYM` bundle
- `-l` load address is always hex (even without `0x`)
- `-arch` required for cross-arch (device arm64 from Apple Silicon host is fine with explicit arch)
- `-f` file of whitespace-separated addresses = batch mode
- `-p pid` is for **local** live processes — not useful for device PCs after the process is gone
- without matching symbols, atos echoes the address unchanged

**Apple crash-doc pattern:**

```bash
atos -arch arm64 \
  -o MyCoolApp.app.dSYM/Contents/Resources/DWARF/MyCoolApp \
  -l 0x102100000 \
  0x00000001021063c4
# -> -[ViewController loadData] (in MyCoolApp) (ViewController.m:38)
```

## Image map: where load address comes from

1. **Preferred:** `xctrace export … --xpath '/trace-toc/run[@number="1"]/processes'` (or process-filtered). Man page: UUID, binary path, load address, architecture per image.
2. **Do not** reuse load address across launches — ASLR changes every run.
3. **Do not** invent load address from PC high bits alone.
4. Fallback hacks (dyld `kdebug` UUID map events) are pre-modern and brittle; only if processes export is empty on a given Xcode — spike first.

Match leaf PC to an image by range when multi-image maps exist: `load <= pc < load+size` if size present; else try main app image first (MVP), leave unmatched PCs as hex.

## Where symbol files live

| Scenario | Runtime binary | Host symbols |
| --- | --- | --- |
| **Simulator** | TOC path under `CoreSimulator/.../App.app/<Binary>` is host-readable | Prefer sibling `.dSYM` from same build; or binary itself if debug DWARF embedded |
| **Device, Xcode install** | Binary on device only; TOC path is typically **not** a Mac path | `DerivedData/.../Build/Products/<Config>-iphoneos/App.app` + `App.app.dSYM` (need **DEBUG_INFORMATION_FORMAT = dwarf-with-dsym** for release-like configs) |
| **Archive / TestFlight build** | Device | `.xcarchive/dSYMs/` + Products Applications; UUID must match |
| **System frameworks** | On device / dyld shared cache | Partial: older `~/Library/Developer/Xcode/iOS DeviceSupport/<ios> <build> arm64e/Symbols/`; modern iOS often **redacts** many system frames. Out of MVP. |

**UUID is the ground truth.** Always verify:

```bash
dwarfdump --uuid /path/to/App.app/Binary
dwarfdump --uuid /path/to/App.app.dSYM
# Match UUID from processes export / Binary Images
```

Mismatch → wrong build → silent wrong or empty symbols. Fail closed with `symbolication: uuid-mismatch`.

**Device vs host:** there is no durable dSYM on the phone. MVP never “pulls dSYM from device.” Optional later: `devicectl` copy of **binary** only for non-stripped debug apps — still weaker than dSYM.

## MVP ship scope (Probe)

### In scope

1. Keep existing top-N leaf PC histogram (agent-actionable without symbols).
2. Optional enrichment after analyze (or as drill):
   - inputs: `.trace` artifact + optional `--binary` / `--dsym` / `--symbols-dir`
   - auto path (simulator): TOC process `path` if file exists
   - auto path (device): search DerivedData / user-provided roots by **UUID** only
   - one `processes` export for load address + arch
   - `atos` **only** on unique top-N leaves (default N=5–20), not every sample frame
3. Output shape (compact):
   ```json
   {
     "topLeaves": [
       { "pc": "0x1010fcb70", "samples": 42, "symbol": "-[AppDelegate application:didFinishLaunchingWithOptions:]", "symbolStatus": "resolved" }
     ],
     "symbolication": {
       "status": "partial",
       "binary": "...",
       "loadAddress": "0x...",
       "uuid": "...",
       "arch": "arm64",
       "unresolved": 2
     }
   }
   ```
4. Honest statuses: `resolved | unresolved | skipped-no-binary | uuid-mismatch | atos-failed | not-attempted`.

### Out of scope (do not build)

- Full call-tree / flamegraph product
- Symbolicating every frame of every sample
- Scanning hundreds of system dSYMs / DeviceSupport trees by default
- Reverse-engineering `.trace` internal stores
- In-process DWARF library when `atos` exists
- Assuming `xctrace symbolicate` replaces atos for XML exports without proof
- Kernel / arm64e panic-style `-textExecAddress` path for user app leaves
- Promising system-framework names on modern iOS

### TypeScript/Bun recipe (host)

```ts
// Pseudocode — Effect-friendly steps
async function enrichTopLeaves(args: {
  tracePath: string
  processName: string
  topLeaves: string[] // unique 0x… PCs, N small
  binaryOrDsym?: string
  archHint?: "arm64" | "arm64e" | "x86_64"
}) {
  // 1) Image map from trace (cached like other exports)
  const processesXml = await xctraceExport(
    args.tracePath,
    `/trace-toc/run[@number="1"]/processes/process[@name="${args.processName}"]`,
  )
  const images = parseProcessImages(processesXml) // uuid, path, loadAddress, arch
  const main = pickMainAppImage(images, args.processName)

  // 2) Resolve symbols file
  const symbolPath =
    args.binaryOrDsym
    ?? (await exists(main.path) ? main.path : undefined)
    ?? (await findDsymByUuid(main.uuid, derivedDataRoots()))

  if (!symbolPath) {
    return { status: "skipped-no-binary", leaves: args.topLeaves.map(pc => ({ pc, symbolStatus: "not-attempted" })) }
  }

  if (!(await uuidMatches(symbolPath, main.uuid))) {
    return { status: "uuid-mismatch", … }
  }

  // 3) Batch atos
  const addrFile = await writeTemp(args.topLeaves.join("\n"))
  const { stdout, exitCode } = await run([
    "xcrun", "atos",
    "-arch", main.arch ?? args.archHint ?? "arm64",
    "-o", symbolPath,
    "-l", main.loadAddress,
    "-f", addrFile,
  ])
  // 4) Zip line-by-line: input PC order == output line order
  const symbols = stdout.trim().split("\n")
  return zip(args.topLeaves, symbols).map(([pc, line]) => ({
    pc,
    symbol: line === pc || line.startsWith("0x") ? null : line,
    symbolStatus: line === pc || /^0x/i.test(line) ? "unresolved" : "resolved",
  }))
}
```

**Budget rules:**

- Never symbolicate inside the hot export path that already hits 4 MiB `time-sample` budgets.
- Cap atos input to top-N unique PCs; timeout ~5–10s.
- Cache atos results keyed by `(uuid, loadAddress, sortedPcs)`.

## Ordered implementation plan

1. **Spike (half day):** on one Simulator Time Profiler `.trace` from ProbeFixture:
   - export `…/processes` → confirm load/uuid/arch XML shape
   - `dwarfdump --uuid` on TOC path binary
   - `atos` top-5 leaves → names or echo
   - export `time-profile` with real workload → any `frame name=`?
2. **Spike (device):** same on device install; confirm host dSYM UUID match vs device path non-existence.
3. **Ship:** optional enrichment in `perf.analyze` time-profiler path or `perf symbolicate-leaves` drill; default off-or-best-effort; never fail analyze when symbols missing.
4. **Later only if spike proves it:** prefer `time-profile` named frames when populated; keep atos as fallback for raw `time-sample`.

## Failure modes (operator-facing)

| Failure | Symptom | Agent next step |
| --- | --- | --- |
| No binary/dSYM | `skipped-no-binary` | Pass `--dsym` / rebuild with dSYM / use Simulator path |
| UUID mismatch | wrong build | Rebuild, or point at matching archive dSYM |
| Wrong load address | all unresolved / nonsense | Re-export processes from **this** `.trace` |
| Leaf in system lib | unresolved against app dSYM | Expected; report as `outside-app-image` if range known |
| Stripped binary, no dSYM | unresolved | Enable dSYM generation |
| Export budget | analyze fails before leaves | Shorter `--time-limit` (existing) |
| atos missing / Xcode not selected | spawn fail | `xcode-select` / install CLT |

## Relation to `xctrace symbolicate`

Use when the human will open the `.trace` in Instruments and needs names there:

```bash
xcrun xctrace symbolicate --input run.trace --dsym /path/to/App.app.dSYM
# or directory of dSYMs; or omit --dsym for best-effort (slow)
```

For agent JSON, prefer **atos on top-N** — deterministic, small, no full-trace rewrite. Optionally run symbolicate as a separate “prepare for Instruments” command, not as the analyze dependency.

## Capability reporting

Surface honestly in perf capability / analyze notes:

- `leafPcHistogram: supported`
- `leafSymbolication: best-effort` (requires matching dSYM/binary + processes load map)
- `fullStackSymbolication: unsupported` (open Instruments / future)
- `systemFrameworkSymbols: unsupported` on modern iOS
