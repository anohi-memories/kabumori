"use client";

import { useRef, useState, useTransition } from "react";
import { setSystemEnabled } from "@/lib/actions/system-toggle";
import type { SystemStatusItem, SystemToggleControl } from "@/lib/system-status";

export function SystemStatusList({ systems }: { systems: SystemStatusItem[] }) {
  return (
    <ul className="system-status-list">
      {systems.map((system) => (
        <li className={`system-status-item system-status-${system.tone}`} key={system.key}>
          <div className="system-status-heading">
            <strong>{system.name}</strong>
            <span className={`status status-${system.tone}`}>{system.stateLabel}</span>
          </div>

          {system.state === "unavailable" ? (
            <p className="system-status-reason">{system.unavailableReason}</p>
          ) : (
            <dl className="system-status-details">
              {system.details.map((detail) => (
                <div key={detail.label}>
                  <dt>{detail.label}</dt>
                  <dd>{detail.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {system.note ? <p className="system-status-note">{system.note}</p> : null}

          {system.toggles.length > 0 ? (
            <div className="system-status-toggles">
              {system.toggles.map((toggle) => (
                <ToggleControl key={toggle.key} toggle={toggle} systemName={system.name} />
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ToggleControl({
  toggle,
  systemName,
}: {
  toggle: SystemToggleControl;
  systemName: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [isPending, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(toggle.enabled);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(
    null,
  );

  const nextEnabled = !enabled;
  const isDangerOn = toggle.kind === "danger" && nextEnabled;
  const actionLabel = `${toggle.label}を${nextEnabled ? "ON" : "OFF"}にする`;
  // tip covers three independent posting_windows rows updated together —
  // make that explicit in the confirmation instead of the generic phrasing.
  const confirmMessage =
    toggle.key === "tip"
      ? `${systemName}3枠をすべて${nextEnabled ? "ON" : "OFF"}にしますか？`
      : `${systemName}の${toggle.label}を${nextEnabled ? "ON" : "OFF"}にしますか？`;

  function openConfirm() {
    setFeedback(null);
    dialogRef.current?.showModal();
  }

  function closeConfirm() {
    dialogRef.current?.close();
  }

  function handleConfirm() {
    closeConfirm();
    startTransition(async () => {
      const result = await setSystemEnabled(toggle.key, nextEnabled);
      if (result.ok) {
        setEnabled(result.value);
        setFeedback({
          type: "success",
          text: `${toggle.label}を${result.value ? "ON" : "OFF"}にしました`,
        });
      } else {
        setFeedback({ type: "error", text: "設定を変更できませんでした" });
      }
    });
  }

  return (
    <div className="toggle-control">
      <button
        type="button"
        className={`toggle-button${isDangerOn ? " toggle-button-danger" : ""}`}
        onClick={openConfirm}
        disabled={isPending}
      >
        {isPending ? "変更中…" : actionLabel}
      </button>
      {feedback ? (
        <p className={`toggle-feedback toggle-feedback-${feedback.type}`} role="status">
          {feedback.text}
        </p>
      ) : null}

      <dialog ref={dialogRef} className="toggle-dialog">
        <p className="toggle-dialog-message">{confirmMessage}</p>
        {isDangerOn ? (
          <p className="toggle-dialog-warning">
            ONにすると、重要ニュースが条件成立時に自動的にXへ投稿されます。
          </p>
        ) : null}
        <div className="toggle-dialog-actions">
          <button type="button" className="secondary-button" onClick={closeConfirm}>
            キャンセル
          </button>
          <button
            type="button"
            className={`primary-button${isDangerOn ? " primary-button-danger" : ""}`}
            onClick={handleConfirm}
          >
            {actionLabel}
          </button>
        </div>
      </dialog>
    </div>
  );
}
