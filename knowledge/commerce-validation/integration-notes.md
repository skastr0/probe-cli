# Commerce validation integration notes

## Durable facts used by the current implementation

- Local StoreKit is useful for deterministic smoke, but it is **not authoritative** for Apple-backed commerce readiness.
- Apple sandbox is the authoritative pre-release lane only when the app is running on a **real device**.
- TestFlight is also authoritative, but subscription renewal timing is compressed relative to production.
- RevenueCat catalog resolution and Apple product fetchability are separate failure boundaries and should be reported separately.
- Purchase-cancel, restore, offline fallback, and double-tap-buy belong in the validation contract even when the current runtime can only stub some of them.

## What Probe now does

- Defines a reusable commerce domain contract in `src/domain/commerce.ts`.
- Implements workspace-local doctor checks for bundle id, In-App Purchase capability markers, `.storekit` discovery, and inspectable flavor hints.
- Implements RevenueCat-aware local doctor checks for public SDK key prefixes, parseable local offerings/package hints, entitlement hints, and `.storekit` product-id consistency.
- Reports Apple-side and RevenueCat-side gaps honestly as `unknown` stubs instead of pretending to verify them.
- Writes a durable `commerce-report` artifact for `probe validate commerce` runs.

## Current hard walls

- No App Store Connect provider integration yet for Paid Applications Agreement, first-submission gate, or Apple-side catalog status.
- No RevenueCat API integration yet for dashboard offering resolution, store-connection health, Apple IAP key status, or entitlement verification beyond local structural hints.
- No StoreKit control-plane integration yet for deterministic control steps like clear-transactions, force-failure, expiry, or time-rate mutation.
