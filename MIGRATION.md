# Open-core split (historical note)

Shiftboss — formerly "Project Control Center" (PCC) — was split into two codebases:

- **`shiftboss` (this repo):** the open-source core — local-first UI, local runner, Work Orders, chat, constitution, tech tree, and project management. Apache-2.0.
- **A separately developed, closed-source cloud codebase:** hosted services (auth, billing, managed runners/VMs, integrations) and the marketing site. Not part of this repo.

## Status

The split is complete:

- The landing/marketing page was moved out of the core.
- Legacy GCP VM provisioning and remote-execution code was **removed** from the core. Runs execute locally, isolated in per-run git worktrees.
- Auth, billing, and GitHub/VM hosting integrations live only in the cloud codebase.

## What this means for the core

- The local SQLite database (`shiftboss.db`) and per-repo `work_orders/` files remain the source of truth for runtime state.
- Everything in this repo works standalone, offline, with no cloud dependency.
- Legacy `CONTROL_CENTER_*` / `PCC_*` environment variables and an existing `control-center.db` are still accepted for backward compatibility.

See `docs/CLOUD_ARCHITECTURE.md` for the intended core/cloud boundary and `docs/SELF_HOSTED.md` for running the core.
