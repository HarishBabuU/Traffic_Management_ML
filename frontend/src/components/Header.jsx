import StatusBadge from './StatusBadge';

export const VIEWS = [
  { id: 'home', label: 'MAP / HOME' },
  { id: 'cctv', label: 'CCTV' },
  { id: 'intelligence', label: 'INTELLIGENCE' },
  { id: 'evidence', label: 'EVIDENCE' },
];

/**
 * Command Centre header — brand bar + view tabs.
 *
 * Navigation switches whole views (MAP / HOME → CCTV → INTELLIGENCE →
 * EVIDENCE) instead of scrolling through one long page, so each job has a
 * focused workspace and the recent view stack powers "go back".
 */
export default function Header({ currentView = 'home', onNavigate }) {
  return (
    <header className="app-header">
      <div className="app-header-brand">
        <span className="app-brand-icon" aria-hidden="true">🚦</span>
        <div>
          <h1 className="app-brand-title">Traffic Intelligence Ops</h1>
          <p className="app-brand-tag">Live Traffic &amp; Route Command Center</p>
        </div>
      </div>
      <nav className="nav-bar" aria-label="Command center views">
        {VIEWS.map((view) => (
          <button
            key={view.id}
            type="button"
            className={`nav-link${currentView === view.id ? ' nav-link-active' : ''}`}
            aria-current={currentView === view.id ? 'true' : undefined}
            onClick={() => (onNavigate ? onNavigate(view.id) : undefined)}
          >
            {view.label}
          </button>
        ))}
      </nav>
      <div className="app-header-badges">
        <StatusBadge status="LIVE" note="OSRM / Open-Meteo" />
        <StatusBadge status="LOCAL" note="Local Assistant" />
      </div>
    </header>
  );
}