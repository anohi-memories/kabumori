import type { SystemStatusItem } from "@/lib/system-status";

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
        </li>
      ))}
    </ul>
  );
}
