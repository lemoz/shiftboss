"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { KanbanBoard } from "./KanbanBoard";
import { TechTreeView } from "./TechTreeView";
import { ConstitutionPanel } from "./ConstitutionPanel";
import { VMPanel } from "./VMPanel";
import { AutoShiftPanel } from "./AutoShiftPanel";
import { MergePolicyPanel } from "./MergePolicyPanel";
import { AutopilotPanel } from "./AutopilotPanel";
import { SuccessPanel } from "./SuccessPanel";
import { CostPanel } from "./CostPanel";
import { BudgetPanel } from "./BudgetPanel";

type ViewMode = "kanban" | "tech-tree";

type SecondarySectionProps = {
  title: string;
  description: string;
  children: ReactNode;
  initiallyOpen?: boolean;
};

function SecondarySection({
  title,
  description,
  children,
  initiallyOpen = false,
}: SecondarySectionProps) {
  return (
    <details className="card" open={initiallyOpen}>
      <summary style={{ cursor: "pointer", userSelect: "none" }}>
        <div style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontWeight: 700 }}>{title}</span>
          <span className="muted" style={{ fontSize: 12 }}>
            {description}
          </span>
        </div>
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
        {children}
      </div>
    </details>
  );
}

export default function ProjectPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const searchParams = useSearchParams();
  const viewParam = searchParams.get("view");
  const [view, setView] = useState<ViewMode>("kanban");

  useEffect(() => {
    if (viewParam === "tech-tree") {
      setView("tech-tree");
      return;
    }
    if (viewParam === "kanban") {
      setView("kanban");
    }
  }, [viewParam]);

  return (
    <>
      <main style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <section className="card" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Link href="/" className="badge">
            &larr; Portfolio
          </Link>
          <Link href={`/projects/${encodeURIComponent(id)}/chat`} className="badge">
            Chat
          </Link>
          <Link href={`/projects/${encodeURIComponent(id)}/tracks`} className="badge">
            Tracks
          </Link>
          <div className="muted" style={{ fontSize: 13 }}>
            {id}
          </div>

          <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            <button
              className={view === "kanban" ? "btn" : "btnSecondary"}
              onClick={() => setView("kanban")}
              style={{ padding: "6px 12px" }}
            >
              Kanban
            </button>
            <button
              className={view === "tech-tree" ? "btn" : "btnSecondary"}
              onClick={() => setView("tech-tree")}
              style={{ padding: "6px 12px" }}
            >
              Tech Tree
            </button>
          </div>
        </section>

        <KanbanBoard repoId={id} />
        <SecondarySection
          title="Run Controls"
          description="VM, autopilot, and shift scheduling controls."
        >
          <VMPanel repoId={id} />
          <AutopilotPanel repoId={id} />
          <AutoShiftPanel repoId={id} />
          <MergePolicyPanel repoId={id} />
        </SecondarySection>
        <SecondarySection
          title="Budget & Cost"
          description="Allocation, runway, and recent spend."
        >
          <BudgetPanel repoId={id} />
          <CostPanel repoId={id} />
        </SecondarySection>
        <SecondarySection
          title="Project Direction"
          description="Success criteria and constitution guidance."
        >
          <SuccessPanel repoId={id} />
          <ConstitutionPanel repoId={id} />
        </SecondarySection>
      </main>

      {/* Tech Tree Modal */}
      {view === "tech-tree" && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "#0a0a14",
            zIndex: 1000,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <TechTreeView repoId={id} onClose={() => setView("kanban")} />
        </div>
      )}
    </>
  );
}
