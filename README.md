# Shiftboss

**Mission control for the coding agents you already use.**

Shiftboss (formerly "Project Control Center") is a local-first Kanban board and dispatcher for your whole portfolio of repos. Work is written down as spec-file Work Orders. A builder agent implements each one in an isolated git worktree, and a fresh reviewer agent gates every run before a human sees it. Bounded autonomous "shifts" keep a project moving and write handoffs for the next session. The UI is an installable PWA, so you can drive all of it from your phone.

Shiftboss does **not** replace Claude Code, Codex CLI, or Gemini CLI — it orchestrates them. It shells out to the agent CLIs you already have installed and authenticated. Bring your own subscriptions and API keys.

## What you get

- **Portfolio dashboard** — scans your filesystem for git repos and tracks stage, status, priority, and per-repo metadata (`.control.yml` sidecar).
- **Work Orders** — markdown files with a YAML frontmatter contract (`goal`, `acceptance_criteria`, `stop_conditions`) rendered as a per-repo Kanban. See `docs/work_orders.md`.
- **Builder → Reviewer gate** — every run spawns a builder agent, runs tests, then spawns a *fresh* reviewer agent. Only approved diffs reach you.
- **Worktree isolation** — each run (and each chat thread that edits files) works in its own git worktree; nothing touches `main` until the merge step.
- **Merge policies** — per project: `auto_merge`, `human_approve` (pause for a click), or `pull_request` (push branch + open a GitHub PR). See `docs/merge-policy.md`.
- **Shifts** — bounded autonomous work sessions with context gathering, decision making, and written handoffs. See `docs/agent_shift_protocol.md`.
- **Scoped chat** — global, per-project, and per-work-order threads backed by an agent CLI.
- **Tech tree** — visualizes Work Order dependencies and progression.
- **Mobile PWA** — responsive UI, optionally exposed via ngrok with basic auth.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  SHIFT AGENT (optional — local `claude` CLI)                 │
│  Gathers context, picks the next Work Order, kicks off       │
│  runs, monitors, completes the shift with a handoff          │
└──────────────────────────────┬───────────────────────────────┘
                               │ drives via HTTP API
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  SHIFTBOSS SERVER (localhost:4010 — Express + SQLite)        │
│  Repo scanning · Work Order CRUD · run orchestration ·       │
│  shift lifecycle · chat · git worktree management            │
└──────────────────────────────┬───────────────────────────────┘
                               │ spawns agent CLIs locally
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  LOCAL RUNNER (one git worktree per run)                     │
│  Builder (codex / claude) → tests → fresh Reviewer →         │
│  merge policy: auto-merge · human approve · GitHub PR        │
└──────────────────────────────────────────────────────────────┘

UI: Next.js PWA on localhost:3010 — Kanban, runs, chat, tech tree
```

Everything runs on your machine. State lives in a local SQLite database (`shiftboss.db`) plus markdown files in each repo's `work_orders/` directory. There is no telemetry and no hosted dependency.

## Quickstart

### Prerequisites

- **Node.js 18+** and npm (CI runs on Node 20)
- **git**
- At least one agent CLI on your `PATH`:
  - [Codex CLI](https://github.com/openai/codex) (`codex`) — default builder/reviewer provider
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) — alternate provider; also required for the shift agent
- `jq` and `curl` — used by `scripts/start-shift.sh`
- Optional: `ngrok` for remote access

Provider support: `codex` and `claude_code` are implemented; `gemini_cli` is defined in the provider interface but not implemented yet.

### Run it

```bash
git clone https://github.com/lemoz/shiftboss
cd shiftboss
cp .env.example .env     # set OPENAI_API_KEY (Codex provider + utility LLM calls)
npm install
npm run server:dev       # API on http://localhost:4010
```

In a second terminal:

```bash
npm run dev              # UI on http://localhost:3010
```

Verify the server:

```bash
curl http://localhost:4010/health
```

### Point it at your repos

By default the scanner walks your home directory to a limited depth. To scope it:

```bash
# .env
SHIFTBOSS_SCAN_ROOTS=/path/to/your/projects
```

See `docs/repo_discovery.md` for ignore rules and the `.control.yml` sidecar schema, and `.env.example` for every option. Legacy `CONTROL_CENTER_*` / `PCC_*` variable names (and an existing `control-center.db`) still work via fallback.

### Pick your provider

Builder, reviewer, and chat providers/models are configured in the Settings page (or per project). The Codex provider looks for the `codex` binary; override the path with `SHIFTBOSS_CODEX_PATH` or the `cliPath` setting. Same idea for `claude` via `SHIFTBOSS_CLAUDE_PATH`.

## Work Orders

A Work Order is a markdown file in `work_orders/` with YAML frontmatter. A card is **Ready** — and runnable — only when it has a `goal`, `acceptance_criteria`, and `stop_conditions`. The full contract (statuses, `depends_on`, eras, optional fields) is in `docs/work_orders.md`.

A run then goes: **setup** (worktree) → **builder** → **tests** → **reviewer** → **merge policy**. If the reviewer requests changes, the builder iterates (bounded by `SHIFTBOSS_MAX_BUILDER_ITERATIONS`). Builder sandboxing is configurable via `SHIFTBOSS_BUILDER_SANDBOX` (default `workspace-write`); the reviewer defaults to read-only.

## Autonomous shifts

The shift agent runs a bounded work session against a project: gather context → decide → execute runs → hand off.

```bash
# server must be running; requires `claude` and `jq`
./scripts/start-shift.sh <project-id>
```

The script resolves the project path from the API, renders `prompts/shift_agent.md`, and launches the Claude CLI with the shift loop. **Note:** it passes `--dangerously-skip-permissions` — read the prompt and the allowed-tools list before running it on a repo you care about, and treat it as an agent with your local permissions.

Relevant API surface:

```
GET  /projects/:id/shift-context
POST /projects/:id/shifts
POST /projects/:id/shifts/:shiftId/complete
```

## Remote access via ngrok

The server is private by default: it binds to localhost and rejects non-loopback clients unless `SHIFTBOSS_ALLOW_LAN=1`. To use the PWA from your phone:

1. Install ngrok and add your authtoken (`ngrok config add-authtoken <token>`).
2. Reserve a domain in the ngrok dashboard.
3. Add to `.env` (gitignored):
   ```bash
   NGROK_DOMAIN=your-name.ngrok.app
   NGROK_BASIC_AUTH=youruser:strongpassword
   ```
4. Start the tunnel to the UI:
   ```bash
   set -a; source .env; set +a
   bash scripts/ngrok.sh
   ```

Treat it as internet-facing: use a strong password.

## Tests

```bash
npm test           # unit tests (fast, no build needed)
npm run test:e2e   # Playwright smoke suite — builds UI + server first
```

E2E runs the API on `127.0.0.1:4011` and the built UI on `127.0.0.1:3012` (plus an offline variant on `3013`). Override with `E2E_API_PORT`, `E2E_WEB_PORT`, and `E2E_OFFLINE_WEB_PORT` if those ports are taken. See `e2e/README.md` and `docs/e2e_testing.md`.

Production build:

```bash
npm run build && npm run server:build
npm run server:start   # API
npm start              # UI
```

## Shiftboss Cloud

Hosted and team-oriented features (managed runners, auth, billing) are developed separately and are not part of this repository. Everything in this repo runs locally and stays Apache-2.0.

## Status and roadmap

Working today: portfolio scanning, Work Order Kanban, builder→reviewer runs with worktree isolation, configurable merge policies, scoped chat with worktree merge, shifts with auto-generated handoffs, tech tree, cost/budget tracking, PWA + ngrok access, unit + Playwright e2e suites.

In progress / planned: Gemini CLI provider, cross-project global agent, escalation routing, run time estimation. Expect rough edges — this project is developed by running it on itself.

Developed on macOS; should work on Linux (shell scripts assume a POSIX environment).

## Repo layout

- `app/` – Next.js UI
- `server/` – local API + runner (Express, SQLite, providers)
- `docs/` – contracts, architecture notes, runbooks
- `work_orders/` – this repo's own Work Orders (dogfooding)
- `prompts/` – agent prompts (shift agent, etc.)
- `scripts/` – utility scripts (start-shift, ngrok, e2e)
- `e2e/` – Playwright tests

## Documentation

- `docs/work_orders.md` – Work Order contract and lifecycle
- `docs/merge-policy.md` – merge policies after reviewer approval
- `docs/repo_discovery.md` – repo discovery and sidecar schema
- `docs/agent_shift_protocol.md` – shift agent protocol
- `docs/system-architecture.md` – system architecture diagram
- `docs/SELF_HOSTED.md` – self-hosted setup guide
- `docs/e2e_testing.md` – e2e testing patterns
- `DECISIONS.md` – architectural decision log
- `CI_SETUP.md` – GitHub Actions notes

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
