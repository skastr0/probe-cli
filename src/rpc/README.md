# Probe RPC control plane

This folder now contains the first real daemon/client contract for Probe.

Current contract:

- transport: local Unix domain socket
- framing: newline-delimited JSON
- compatibility: explicit `probe-rpc/v1` version tag on every frame
- lifecycle: one request per socket connection with optional progress events before the terminal response

Important caveat:

- the daemon-backed simulator vertical slice is real, but the runner transport inside the session is still the current honest mixed contract: file-backed command ingress plus stdout-framed event egress through the `xcodebuild` boundary
