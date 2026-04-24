# Probe RPC control plane

This folder now contains the first real daemon/client contract for Probe.

Current contract:

- transport: local Unix domain socket
- framing: newline-delimited JSON
- compatibility: explicit `probe-rpc/v1` version tag on every frame
- lifecycle: one request per socket connection with optional progress events before the terminal response
- request frames: `{ kind, protocolVersion, requestId, method, params }`
- response frames: `{ kind, protocolVersion, requestId, method, result }`
- failure frames: `{ kind, protocolVersion, requestId, method, failure }`, where `failure` includes `nextStep`, `next_step`, `retryable`, `sessionId`, and `artifactKey` when available
- event frames: `{ kind, protocolVersion, requestId, method, type, sequence, timestamp, stage, message, data }`

Discovery:

- `probe schema show probe.rpc.frames/v1 --output-json`
- `probe schema list --output-json`

Important caveat:

- the daemon-backed simulator vertical slice is real, and runner ingress uses the validated HTTP POST seam; stdout remains the mixed-log observation path through the `xcodebuild` boundary
