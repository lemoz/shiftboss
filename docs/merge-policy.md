# Configurable Merge Policy

Per-project merge policies control what happens after the AI reviewer approves a build. Different teams have different workflows — solo developers want instant merges, while teams with code review culture want GitHub PRs.

## Policies

### `auto_merge` (default)

AI reviewer approves, code merges to main automatically. This is the original Shiftboss behavior. No human intervention required.

Run status flow: `building` → `you_review` (merge_status=merged)

### `human_approve`

AI reviewer approves, but Shiftboss pauses before merging. The run enters an `approved` state and waits for a human to click **Merge** or **Reject** in the Shiftboss UI.

Run status flow: `building` → `approved` → (human action) → `you_review` (merge_status=merged) or `rejected`

Use this when you want to review the AI's work before it hits main, but don't need full GitHub PR review.

### `pull_request`

AI reviewer approves, Shiftboss pushes the branch to GitHub and opens a PR. The human reviews and merges on GitHub using their normal code review workflow.

Run status flow: `building` → `pr_open` (pr_url stored) → (human merges on GitHub)

Use this for team projects where multiple people review code, or when you want GitHub's review tooling (inline comments, required reviewers, CI checks).

If the GitHub push or PR creation fails (auth issues, branch protection), Shiftboss falls back to `human_approve` automatically.

## Configuration

Set the merge policy in the project settings panel. The dropdown appears under **Merge Policy** on the project page.

**API:**

```
PATCH /repos/:id
{ "merge_policy": "auto_merge" | "human_approve" | "pull_request" }
```

```
GET /repos/:id
# Returns merge_policy in the response
```

## Actions

### Approving a human_approve run

When a run is in `approved` status, click **Merge** in the run detail view, or call:

```
POST /runs/:runId/approve-merge
```

This performs a `--no-ff` merge to main, updates the work order, and cleans up the worktree.

### Rejecting a run

Click **Reject** to abandon the run, or call:

```
POST /runs/:runId/reject
```

This removes the worktree, deletes the branch, and marks the run as `rejected`.

## Database

The `merge_policy` column lives on the `projects` table with a default of `'auto_merge'`. Existing projects keep their current auto-merge behavior with no migration action needed.

## Recommended Setup

| Team type | Policy | Why |
|-----------|--------|-----|
| Solo developer | `auto_merge` | Fast iteration, no review overhead |
| Small team, high trust | `human_approve` | Glance at the diff before merge |
| Team with code review | `pull_request` | Full GitHub PR workflow |
