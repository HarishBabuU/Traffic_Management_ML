/**
 * Status badge. Always shows a text label (never colour alone).
 * status: LIVE | MOCK | STATIC | MANUAL | UNKNOWN
 */
export default function StatusBadge({ status, note }) {
  const label = status || 'UNKNOWN';
  const cls = label.toLowerCase();
  return (
    <span className={`badge badge-${cls}`} title={note || label}>
      <span className="badge-dot" aria-hidden="true" />
      {label}
      {note ? <span className="badge-note"> · {note}</span> : null}
    </span>
  );
}