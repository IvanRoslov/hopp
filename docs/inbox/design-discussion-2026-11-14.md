---
last-verified: 2026-11-15
---

# hopp design discussion, 14 November 2026

Notes from the first discussion that are not settled yet. Everything else from that discussion is now in the tree (`docs/daemon/`, `docs/overview`) or in `internal/PORTED.md`; it was moved out on 2026-11-15.

## Proposed by Claude, not approved

- A scenario subscribes to daemon events and keeps its own state in its own database. The event log and per-event labels exist; the live stream a scenario would subscribe to does not yet.
- Split harness and provider in the profile, so that "Claude Code + DeepSeek" is a registry row and not a separate adapter. Deferred: `deepseek` is ported as the adapter it is.
