# Open questions — leaf symbolication

Updated: 2026-07-28

1. **Exact XML shape of `export …/processes` on Xcode 26.x**  
   Man page promises UUID / path / load / arch. Need one real export saved under this pack for parser fixtures (sim + device).

2. **Does `time-profile` export named frames when populated on current Xcode?**  
   Idle ProbeFixture left it empty. Re-run with CPU-heavy fixture; if `<frame name="…">` appears, prefer that over atos for stacks.

3. **Does `xctrace symbolicate` change subsequent `time-sample` XML `fmt`/`kperf-bt` content?**  
   Spike before wiring as analyze dependency. Likely Instruments-only improvement.

4. **Device TOC process `path`**  
   Confirm it is device-absolute and non-host-resolvable (expected). Document auto-search roots (DerivedData, custom `--symbols-dir`).

5. **Arch field for pure arm64 app on arm64e device**  
   Expect `arm64` for user apps; confirm processes export arch string.

6. **Multi-binary apps (extensions, frameworks inside .app)**  
   MVP = main executable only. When leaf lands in embedded framework, need image range match + that framework’s dSYM.
