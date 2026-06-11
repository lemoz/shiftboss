"use client";

import { useCallback, useEffect, useState } from "react";

type MergePolicy = "auto_merge" | "human_approve" | "pull_request";

type ProjectMergePolicyResponse = {
  project: {
    id: string;
    name: string;
    merge_policy: MergePolicy;
  };
  error?: string;
};

const MERGE_POLICY_OPTIONS: Array<{ value: MergePolicy; label: string; description: string }> = [
  {
    value: "auto_merge",
    label: "Auto-merge",
    description: "Merge to base branch automatically after AI reviewer approval.",
  },
  {
    value: "human_approve",
    label: "Human approve",
    description: "Pause after AI approval and require Merge or Reject in Shiftboss.",
  },
  {
    value: "pull_request",
    label: "Pull request",
    description: "Open a GitHub PR after AI approval for human merge on GitHub.",
  },
];

export function MergePolicyPanel({ repoId }: { repoId: string }) {
  const [mergePolicy, setMergePolicy] = useState<MergePolicy>("auto_merge");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}`, {
        cache: "no-store",
      });
      const json = (await res.json().catch(() => null)) as ProjectMergePolicyResponse | null;
      if (!res.ok) throw new Error(json?.error || "failed to load project settings");
      const next = json?.project?.merge_policy;
      setMergePolicy(
        next === "auto_merge" || next === "human_approve" || next === "pull_request"
          ? next
          : "auto_merge"
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load project settings");
    } finally {
      setLoading(false);
    }
  }, [repoId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next: MergePolicy) => {
      setSaving(true);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ merge_policy: next }),
        });
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) throw new Error(json?.error || "failed to update merge policy");
        setMergePolicy(next);
        setNotice("Saved.");
        setTimeout(() => setNotice(null), 2000);
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed to update merge policy");
      } finally {
        setSaving(false);
      }
    },
    [repoId]
  );

  const activeOption =
    MERGE_POLICY_OPTIONS.find((option) => option.value === mergePolicy) || MERGE_POLICY_OPTIONS[0];

  return (
    <section className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 10,
          alignItems: "baseline",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Merge Policy</h2>
          <div className="muted" style={{ fontSize: 13 }}>
            Choose how approved runs should land.
          </div>
        </div>
        <button className="btnSecondary" onClick={() => void load()} disabled={loading || saving}>
          Refresh
        </button>
      </div>

      {!!error && <div className="error">{error}</div>}
      {!!notice && <div className="badge">{notice}</div>}
      {loading && <div className="muted">Loading...</div>}

      {!loading && (
        <>
          <label className="field">
            <div className="fieldLabel muted">Policy</div>
            <select
              className="select"
              value={mergePolicy}
              disabled={saving}
              onChange={(event) => {
                const value = event.target.value as MergePolicy;
                void save(value);
              }}
            >
              {MERGE_POLICY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="muted" style={{ fontSize: 12 }}>
            {activeOption.description}
          </div>
        </>
      )}
    </section>
  );
}
