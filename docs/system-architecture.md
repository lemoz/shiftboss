# Shiftboss System Architecture

Note: Runtime components are split across two repos. Core UI/runner live in
`shiftboss`, while hosted services (auth, billing, VM provisioning,
VM monitoring) live in the closed-source cloud codebase. See `docs/CLOUD_ARCHITECTURE.md`.

Everything in this repo executes locally: the server spawns agent CLIs
(`codex`, `claude`) as local processes, and each run is isolated in its own
git worktree. There is no remote execution layer.

```mermaid
flowchart TB
    subgraph USER["User Layer"]
        UI[Web UI / PWA<br/>Next.js, localhost:3010]
        SHIFT_CLI[Shift Agent<br/>claude CLI via scripts/start-shift.sh]
        API_CLIENT[API Client]
    end

    subgraph API["API Layer (Express :4010)"]
        REPO_API["/repos/*"]
        WO_API["/repos/:id/work-orders/*"]
        RUN_API["/runs/*"]
        SHIFT_API["/projects/:id/shifts/*"]
        CHAT_API["/chat/*"]
    end

    subgraph ORCHESTRATION["Orchestration Layer"]
        subgraph SHIFT_SYSTEM["Shift System"]
            SHIFT_START[Start Shift]
            SHIFT_CONTEXT[Gather Context]
            SHIFT_DECIDE[Assess & Decide]
            SHIFT_EXECUTE[Execute]
            SHIFT_HANDOFF[Handoff]

            SHIFT_START --> SHIFT_CONTEXT
            SHIFT_CONTEXT --> SHIFT_DECIDE
            SHIFT_DECIDE --> SHIFT_EXECUTE
            SHIFT_EXECUTE --> SHIFT_HANDOFF
        end

        subgraph WO_LIFECYCLE["Work Order Lifecycle"]
            WO_BACKLOG[backlog]
            WO_READY[ready]
            WO_BUILDING[building]
            WO_AI_REVIEW[ai_review]
            WO_YOU_REVIEW[you_review]
            WO_DONE[done]
            WO_BLOCKED[blocked]
            WO_PARKED[parked]

            WO_BACKLOG --> WO_READY
            WO_READY --> WO_BUILDING
            WO_BUILDING --> WO_AI_REVIEW
            WO_AI_REVIEW --> WO_YOU_REVIEW
            WO_YOU_REVIEW --> WO_DONE
            WO_YOU_REVIEW --> WO_PARKED
            WO_BACKLOG --> WO_BLOCKED
            WO_BLOCKED --> WO_READY
            WO_DONE -.->|cascadeAutoReady| WO_READY
        end

        SHIFT_SCHEDULER["Shift Scheduler<br/>(auto-shift, 60s tick)"]
        AUTOPILOT["Autopilot<br/>(per-project run policy)"]

        SHIFT_SCHEDULER --> SHIFT_START
        AUTOPILOT --> WO_READY
    end

    subgraph RUN_SYSTEM["Run Execution System"]
        RUN_QUEUE[Enqueue Run]
        SPAWN_WORKER[Spawn Detached Worker<br/>server/runner_worker.ts]

        subgraph RUN_PHASES["Run Phases"]
            PHASE_SETUP[Setup Phase<br/>worktree + baseline tests]
            PHASE_BUILDER[Builder Phase<br/>agent CLI in worktree]
            PHASE_TEST[Test Phase<br/>repo test suite]
            PHASE_REVIEWER[Reviewer Phase<br/>fresh agent, read-only]
            PHASE_MERGE[Merge Phase<br/>merge policy]

            PHASE_SETUP --> PHASE_BUILDER
            PHASE_BUILDER --> PHASE_TEST
            PHASE_TEST --> PHASE_REVIEWER
            PHASE_REVIEWER -->|approved| PHASE_MERGE
            PHASE_REVIEWER -->|changes_requested| PHASE_BUILDER
        end

        RESUME_API[POST /runs/:runId/resume]
        RESUME_API -->|skip to checkpoint| RUN_PHASES

        subgraph BUILDER_LOOP["Builder Loop (max 10 iter, configurable)"]
            CLI_EXEC[codex exec --sandbox &lt;mode&gt;]
            GEN_CODE[Generate Code]
            CHECK_ESCALATION{Escalation?}
            WAIT_INPUT[waiting_for_input<br/>POST /runs/:runId/provide-input]

            CLI_EXEC --> GEN_CODE
            GEN_CODE --> CHECK_ESCALATION
            CHECK_ESCALATION -->|yes| WAIT_INPUT
            WAIT_INPUT --> CLI_EXEC
            CHECK_ESCALATION -->|no| PHASE_TEST
        end

        RUN_QUEUE --> SPAWN_WORKER
        SPAWN_WORKER --> PHASE_SETUP
        PHASE_BUILDER --> CLI_EXEC
    end

    subgraph EXECUTION_ENV["Execution Environment (local)"]
        SANDBOX["Agent CLI Sandbox<br/>read-only / workspace-write /<br/>workspace-write-whitelist / danger-full-access"]
        NET_GUARD["Network Whitelist<br/>(proxy + firewall, optional)"]
        STREAM_MON["Stream Monitor<br/>(optional, threat detection)"]
        SEC_HOLD[security_hold<br/>resume or abort]

        SANDBOX --> NET_GUARD
        STREAM_MON --> SEC_HOLD
    end

    subgraph STORAGE["Storage Layer"]
        subgraph SQLITE["SQLite (shiftboss.db)"]
            DB_PROJECTS[(projects)]
            DB_WOS[(work_orders)]
            DB_RUNS[(runs)]
            DB_SHIFTS[(shifts)]
            DB_HANDOFFS[(shift_handoffs)]
            DB_METRICS[(run_phase_metrics)]
            DB_MERGE_LOCKS[(merge_locks)]
            DB_ESCALATIONS[(escalations)]
            DB_COSTS[(cost_records)]
        end

        subgraph FILES["File System (per repo)"]
            WO_FILES[work_orders/*.md]
            RUN_DIRS[.system/runs/&lt;runId&gt;/]
            SHIFT_LOGS[.system/shifts/&lt;shiftId&gt;/agent.log]
            CHAT_WTS[.system/chat-worktrees/]
        end

        subgraph GIT["Git Repository"]
            GIT_WORKTREE[Worktree per Run<br/>.system/runs/&lt;runId&gt;/worktree]
            GIT_BRANCH[Feature Branch]
            GIT_MAIN[Base Branch]
        end
    end

    subgraph CONTEXT["Context Layer"]
        SHIFT_CTX_BUILDER[Shift Context Builder]
        HANDOFF_GEN[Handoff Generator]
        CONSTITUTION[Constitution Manager]

        SHIFT_CTX_BUILDER --> SHIFT_CONTEXT
        HANDOFF_GEN --> SHIFT_HANDOFF
    end

    subgraph PLANNED_FEATURES["In Progress / Planned"]
        GEMINI_PROVIDER["Gemini CLI Provider<br/>(PLANNED)"]:::planned
        GLOBAL_AGENT["Cross-Project Global Agent<br/>(IN PROGRESS)"]:::planned
        ESCALATION_ROUTING["Escalation Routing<br/>(IN PROGRESS)"]:::planned
    end

    %% Connections
    UI --> API
    SHIFT_CLI --> API
    API_CLIENT --> API

    WO_API --> WO_LIFECYCLE
    RUN_API --> RUN_SYSTEM
    SHIFT_API --> SHIFT_SYSTEM
    CHAT_API --> CHAT_WTS

    SHIFT_EXECUTE --> RUN_QUEUE

    CLI_EXEC --> SANDBOX
    CLI_EXEC --> STREAM_MON

    %% Storage connections
    RUN_SYSTEM --> DB_RUNS
    RUN_SYSTEM --> DB_METRICS
    RUN_SYSTEM --> DB_ESCALATIONS
    RUN_SYSTEM --> DB_COSTS
    PHASE_MERGE --> DB_MERGE_LOCKS
    SHIFT_SYSTEM --> DB_SHIFTS
    SHIFT_HANDOFF --> DB_HANDOFFS

    WO_LIFECYCLE --> WO_FILES
    RUN_SYSTEM --> RUN_DIRS
    SHIFT_SYSTEM --> SHIFT_LOGS

    PHASE_SETUP --> GIT_WORKTREE
    PHASE_MERGE --> GIT_BRANCH
    GIT_BRANCH --> GIT_MAIN

    %% Context connections
    DB_RUNS --> SHIFT_CTX_BUILDER
    DB_SHIFTS --> SHIFT_CTX_BUILDER
    WO_FILES --> SHIFT_CTX_BUILDER
    CONSTITUTION --> SHIFT_CTX_BUILDER
    CONSTITUTION --> PHASE_BUILDER

    RUN_DIRS --> HANDOFF_GEN
    PHASE_MERGE --> HANDOFF_GEN

    classDef planned fill:#fff3cd,stroke:#ffc107,stroke-width:2px,stroke-dasharray: 5 5
```

## Component Details

### Work Order Lifecycle
| Status | Description |
|--------|-------------|
| `backlog` | Not ready for work |
| `ready` | Ready to be picked up |
| `building` | Run in progress |
| `ai_review` | AI reviewing changes |
| `you_review` | Awaiting human review |
| `done` | Completed |
| `blocked` | Dependencies not met |
| `parked` | Paused/deferred |

When a Work Order is marked `done`, `cascadeAutoReady` promotes its dependent
Work Orders from `backlog` to `ready` — provided all of their dependencies are
done and they satisfy the ready contract (`goal`, `acceptance_criteria`,
`stop_conditions`).

### Run Phases

Each run executes in a detached worker process (`server/runner_worker.ts`),
spawned per run so a server restart does not kill in-flight work. Progress is
checkpointed to `runs.last_completed_phase`, and `POST /runs/:runId/resume`
restarts a failed run from the last checkpoint instead of from scratch.

| Phase | Checkpoint | What happens |
|-------|------------|--------------|
| Setup | `setup` | Create git worktree from the base branch, symlink `node_modules`, copy context files into a gitignored `.context/` dir, run baseline tests (run aborts as `baseline_failed` if the repo is already broken) |
| Builder | `builder` | Agent CLI (`codex exec`) works inside the worktree against the Work Order prompt; output validated against a JSON schema; diff captured per iteration |
| Test | `test` | Repo test suite runs in the worktree; failures feed back into the next builder iteration |
| Reviewer | `reviewer_approved` | A *fresh* agent reviews a repo snapshot plus the diff (read-only sandbox by default); verdict is `approved` or `changes_requested` |
| Merge | `committed` | Apply the project's merge policy (see below); safe staging skips deletions and protects `work_orders/` and other configured paths |

The builder/test/reviewer loop is bounded by `SHIFTBOSS_MAX_BUILDER_ITERATIONS`
(default 10, hard cap 20). Phase durations are not hardcoded — every phase is
recorded in `run_phase_metrics`, and per-project averages drive run-time
estimates (`GET /repos/:id/run-metrics/summary`,
`GET /repos/:id/estimation-context`). Estimates and a live ETA are stored on
the run row and updated as phases complete.

### Sandboxing and Network Access

Builders and reviewers run as local CLI processes under the agent CLI's
sandbox:

| Setting | Values | Default |
|---------|--------|---------|
| `SHIFTBOSS_BUILDER_SANDBOX` (or per-project `builder_sandbox_mode`) | `read-only`, `workspace-write`, `workspace-write-whitelist`, `danger-full-access` | `workspace-write` |
| `SHIFTBOSS_REVIEWER_SANDBOX` | `read-only`, `workspace-write`, `danger-full-access` | `read-only` |

Optional guardrails on top of the sandbox:

- **Network whitelist** — egress proxy + firewall restricting builder network
  access to approved hosts (`/settings/network-whitelist`).
- **Stream monitor** — watches live agent output for threats; can auto-kill
  the process and place the run in `security_hold`
  (`POST /runs/:runId/security-hold/resume` or `.../abort`).

### Merge Policies

After reviewer approval, the per-project merge policy decides what happens
(see `docs/merge-policy.md`):

| Policy | Behavior |
|--------|----------|
| `auto_merge` | Commit in the worktree, merge the base branch into the run branch (a conflict spawns a dedicated conflict-resolution builder plus re-review), take the per-project merge lock, merge into the base branch, clean up the worktree |
| `human_approve` | Run pauses in `approved`; a human triggers `POST /runs/:runId/approve-merge` |
| `pull_request` | Push the run branch and open a GitHub PR via `gh`; run moves to `pr_open` |

### Escalations

A builder that hits a stop condition or needs a decision emits an escalation.
The run moves to `waiting_for_input` and blocks until a human responds via
`POST /runs/:runId/provide-input`; the resolution is injected into the next
builder attempt.

### Shift Lifecycle
1. **Start** — Create shift with timeout (default 120 min) via `POST /projects/:id/shifts`
2. **Context** — Gather project state, WOs, runs, git status (`GET /projects/:id/shift-context`)
3. **Assess & Decide** — Choose which WO to work on
4. **Execute** — Kick off runs, monitor progress
5. **Handoff** — Document work done, blockers, recommendations (`POST /projects/:id/shifts/:shiftId/complete`)

The shift agent is the local `claude` CLI, launched either manually
(`scripts/start-shift.sh`) or by the shift scheduler, which checks
auto-shift-enabled projects every 60 seconds and spawns shift agents subject
to a minimum interval, cooldown, daily cap, and quiet hours. Shift logs go to
`.system/shifts/<shiftId>/agent.log` (`GET /projects/:id/shifts/:shiftId/logs`).
Handoffs are auto-generated from run artifacts (`server/handoff_generator.ts`)
and stored in `shift_handoffs`.

### Chat

Chat threads are scoped (global, per-project, per-work-order) and backed by an
agent CLI worker. Threads that edit files get their own git worktree under
`.system/chat-worktrees/`, with diff review and merge-back endpoints
(`GET /chat/threads/:threadId/worktree/diff`).

### Run Artifacts

Each run writes to `.system/runs/<runId>/` inside the target repo:

- `worktree/` — the isolated git worktree for the run
- `builder/iter-N/`, `reviewer/iter-N/` — per-iteration prompts, logs, results
- `tests/` — baseline and per-iteration test results
- `baseline/` — pre-build snapshot used to compute diffs
- `diff.patch`, `iteration_history.json`, `run.log`, `escalation.json`

`GET /runs/:runId/logs/tail` serves the live run log to the UI.

### In Progress / Planned (Yellow/Dashed)
- **Gemini CLI provider** — defined in the provider interface (`server/providers/`), not yet runnable
- **Cross-project global agent** — global sessions/initiatives APIs exist and are maturing
- **Escalation routing** — routing escalations to the right person/channel

## Data Flow

```
User Request (UI / shift agent / API client)
    ↓
API Endpoint (Express :4010)
    ↓
Orchestration (Shift decision / Autopilot / manual WO selection)
    ↓
Run Enqueue → Detached Runner Worker
    ↓
Worktree Setup → Baseline Tests
    ↓
Builder → Test → Reviewer (loop until approved or max iterations)
    ↓
Merge Policy (auto-merge | human approve | GitHub PR)
    ↓
Handoff Generated → Shift Complete → Next Shift
```
