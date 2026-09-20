/**
 * Simple native-CSS charts. No chart library is used.
 * All values come from the prepared JSON data (never hardcoded here).
 */

/**
 * Vertical bar chart built with plain CSS.
 * items: [{ label, value, sub }]
 */
export function BarChart({ items, title, max = null }) {
  if (!items || items.length === 0) {
    return <p className="empty-state">No chart data available.</p>;
  }
  const peak = max || Math.max(...items.map((i) => Number(i.value) || 0), 1);
  const ariaLabel = `${title}: ${items
    .map((i) => `${i.label} ${i.value}`)
    .join(', ')}`;
  return (
    <div
      className="chart-block"
      role="img"
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      {items.map((item) => {
        const value = Number(item.value) || 0;
        const height = Math.max((value / peak) * 100, 2);
        return (
          <div key={item.label} className="chart-col">
            <span className="chart-value">{item.value}</span>
            <div className="chart-bar-track">
              <div className="chart-bar" style={{ height: `${height}%` }} />
            </div>
            <span className="chart-label">{item.label}</span>
            {item.sub ? <span className="chart-sub">{item.sub}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Horizontal CSS bars, e.g. corrected vs conservative counts.
 * items: [{ label, value, sub }]
 */
export function HBarChart({ items, title }) {
  if (!items || items.length === 0) {
    return <p className="empty-state">No chart data available.</p>;
  }
  const peak = Math.max(...items.map((i) => Number(i.value) || 0), 1);
  return (
    <div
      className="hbar-block"
      role="img"
      aria-label={`${title}: ${items.map((i) => `${i.label} ${i.value}`).join(', ')}`}
    >
      {items.map((item) => (
        <div key={item.label} className="hbar">
          <span className="hbar-label">{item.label}</span>
          <div className="hbar-track">
            <div
              className="hbar-fill"
              style={{ width: `${(Number(item.value) / peak) * 100}%` }}
            >
              <span className="hbar-value">{item.value}</span>
            </div>
          </div>
          {item.sub ? <span className="hbar-sub">{item.sub}</span> : null}
        </div>
      ))}
    </div>
  );
}