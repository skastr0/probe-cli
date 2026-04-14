# Commerce validation open questions

- What is the preferred App Store Connect integration seam for agreement status and first-submission gate checks in Probe?
- Should Apple-side checks be direct API calls, imported JSON snapshots, or both?
- Which local build artifacts give the strongest inspectable signal for StoreKit capability beyond checked-in `project.pbxproj` markers?
- When the StoreKit control lane lands, should commerce control steps execute through session RPC, a dedicated daemon lane, or a hybrid artifact-driven seam?
