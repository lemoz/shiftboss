---
id: WO-2026-294
title: Configurable Merge Policy Per Project — Auto-Merge, Human Gate, or Pull Request
goal: |
  Replace the current auto-merge-on-approval behavior with a per-project merge policy.
  Different teams need different workflows: solo devs want auto-merge, teams with code review
  culture want PRs opened on GitHub, and some want a middle ground where PCC pauses for
  human approval before merging.

  Three policies:
  - auto_merge (current behavior): AI reviewer approves → merge to main automatically
  - human_approve: AI reviewer approves → run pauses at "approved" → human clicks "Merge" in PCC UI → merge
  - pull_request: AI reviewer approves → PCC opens a GitHub PR → human reviews and merges on GitHub
context:
  - "Current behavior: runner_agent.ts auto-merges after AI reviewer approval (line ~4188, ~4888)"
  - "projects table in db.ts has per-project config columns (auto_shift_enabled, isolation_mode, etc.)"
  - "GitHub integration exists via gh CLI — used in runner for git operations"
  - "Run status model: queued → building → you_review (with merge_status=merged)"
  - "A solo dev wants auto_merge, teams with code review culture want pull_request"
acceptance_criteria:
  - |
    Database schema:
    - Add merge_policy TEXT NOT NULL DEFAULT 'auto_merge' to projects table
    - Valid values: 'auto_merge', 'human_approve', 'pull_request'
    - Migration adds column with default 'auto_merge' (backward compatible — existing projects keep current behavior)
  - |
    auto_merge policy (current behavior, unchanged):
    - AI reviewer approves → code merges to main automatically
    - Run status becomes you_review with merge_status=merged
    - No behavior change for existing projects
  - |
    human_approve policy:
    - AI reviewer approves → run status becomes 'approved' (NEW status)
    - merge_status stays null (not yet merged)
    - Run sits in 'approved' state until human action
    - Human clicks "Merge" in PCC UI → triggers merge to main → status becomes you_review with merge_status=merged
    - Human can also click "Reject" → status becomes 'rejected' (run abandoned, worktree cleaned up)
    - API endpoint: POST /runs/:runId/approve-merge (triggers the merge)
    - API endpoint: POST /runs/:runId/reject (abandons the run)
  - |
    pull_request policy:
    - AI reviewer approves → PCC pushes the run branch to GitHub remote
    - PCC opens a GitHub PR using gh CLI: gh pr create --base main --head {branch} --title "{WO title}" --body "{summary}"
    - Run status becomes 'pr_open' (NEW status) with pr_url stored on the run record
    - merge_status stays null until PR is merged on GitHub
    - PCC does NOT merge locally — the human merges via GitHub
    - Optional: PCC polls or uses webhook to detect PR merge → updates run to you_review with merge_status=merged
    - If PR merge detection is too complex, just set status to pr_open and let the human confirm in PCC
  - |
    API and UI:
    - GET /repos/:id returns merge_policy field
    - PATCH /repos/:id accepts merge_policy updates
    - Project settings UI shows merge policy dropdown (auto_merge / human_approve / pull_request)
    - Run detail view shows appropriate actions based on policy:
      - auto_merge: no action needed (already merged)
      - human_approve: "Merge" and "Reject" buttons when status=approved
      - pull_request: link to GitHub PR when status=pr_open
  - |
    Runner changes (server/runner_agent.ts):
    - After AI reviewer approves, check project.merge_policy
    - auto_merge: proceed with current merge logic (no change)
    - human_approve: set status='approved', skip merge, return
    - pull_request: push branch, create PR via gh, set status='pr_open', store pr_url, return
  - |
    Tests:
    - Unit test: auto_merge policy proceeds with merge (existing behavior)
    - Unit test: human_approve policy stops at 'approved' status
    - Unit test: pull_request policy creates PR and sets pr_open status
    - Unit test: approve-merge endpoint triggers merge for human_approve runs
    - Unit test: reject endpoint abandons the run
    - All existing tests pass (auto_merge is default)
non_goals:
  - Branch protection rules or required reviewers on GitHub (that's GitHub config)
  - Webhook-based PR merge detection (polling or manual confirmation is fine for v1)
  - Per-WO merge policy overrides (project-level only)
  - Auto-assigning PR reviewers
stop_conditions:
  - If gh CLI is not available or not authenticated, fall back to human_approve (skip PR creation, log warning)
  - If GitHub push fails (permissions, branch protection), fall back to human_approve
priority: 1
tags:
  - workflow
  - teams
  - merge
  - v1
estimate_hours: 10
status: ready
created_at: 2026-02-20
updated_at: 2026-02-20
depends_on: []
era: v1
---
## Notes
- This is critical for multi-team usage — a solo dev can use auto_merge, but teams need code review
- The human_approve mode is the simplest to implement (just stop before merge, add API endpoint)
- The pull_request mode needs gh CLI integration which already exists in runner_agent.ts for git operations
- New run statuses: 'approved' (waiting for human merge) and 'pr_open' (PR created on GitHub)
- Default is auto_merge so this is fully backward compatible
