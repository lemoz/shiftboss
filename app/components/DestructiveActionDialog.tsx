"use client";

import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";

type DestructiveActionDialogProps = {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function DestructiveActionDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  busy = false,
  onConfirm,
  onCancel,
}: DestructiveActionDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    cancelButtonRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, open]);

  if (!open) return null;

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(5, 8, 16, 0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 60,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "min(420px, 100%)",
          borderRadius: 12,
          border: "1px solid rgba(255, 255, 255, 0.16)",
          background: "#0f131e",
          color: "#e6e8ee",
          boxShadow: "0 20px 70px rgba(2, 5, 12, 0.6)",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <h3 id={titleId} style={{ margin: 0, fontSize: 16 }}>
          {title}
        </h3>
        <div id={descriptionId} style={{ fontSize: 13, lineHeight: 1.5, color: "#c5cbdb" }}>
          {description}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            ref={cancelButtonRef}
            type="button"
            className="btnSecondary"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btnSecondary"
            onClick={onConfirm}
            disabled={busy}
            style={{
              borderColor: "#7f1d1d",
              color: "#fecaca",
              background: "rgba(127, 29, 29, 0.2)",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
