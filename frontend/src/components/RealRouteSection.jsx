import StatusBadge from './StatusBadge';
import { ROUTE_COLORS } from './MapView';
import {
  mapViewState,
  analysisMessageFor,
  routeDeltas,
  routeTags,
  ROUTE_INTELLIGENCE_NOTE,
} from '../services/controlCenter';

/**
 * Command Centre — REAL route strip.
 *
 * Composes over the single command map: EVERY OSRM alternative returned by the
 * live provider is shown as a compact, horizontally scrollable card so the
 * route options stay visible without becoming a report. Card and map stay
 * synchronised through the parent-selected route id (clicking either side
 * selects the same route). Deltas are computed strictly from the provider
 * numbers; "Fastest"/"Shortest" tags come from the same numbers and never
 * invent a ranking. Demo (Phase 9E) routes are deliberately NOT shown here.
 */
/**
 * Shown when the routing provider answered with exactly one route. OSRM only
 * returns alternatives that are meaningfully different, so a single result is
 * a normal provider outcome — it is disclosed rather than hidden, and no extra
 * route is ever invented to fill the strip.
 */
export const SINGLE_ROUTE_NOTE =
  'The routing provider returned 1 route for this origin and destination — no alternative path was available from OSRM.';

export default function RealRouteSection({
  analysis,
  selectedRealRouteId,
  onSelectRealRoute,
  trip,
  weather,
  intel = null,
}) {
  const view = mapViewState(analysis.status);
  const ready = analysis.status === 'ready';

  const selectedRealRoute =
    ready && Array.isArray(analysis.routes) && analysis.routes.length > 0
      ? analysis.routes.find((r) => r.id === selectedRealRouteId) ||
        analysis.routes[0]
      : null;

  const routes = ready && Array.isArray(analysis.routes) ? analysis.routes : [];
  const deltas = routeDeltas(routes, selectedRealRoute && selectedRealRoute.id);
  const tags = routeTags(routes);

  if (view.mode === 'idle') {
    return null;
  }

  if (view.mode === 'loading') {
    return (
      <div className="routes-loading-card" aria-live="polite">
        <span className="pulse-dot" aria-hidden="true" />
        <span className="status-line">{view.message || 'Routing across OSRM alternatives…'}</span>
      </div>
    );
  }

  if (view.mode === 'unavailable' || view.mode === 'location-error') {
    return (
      <div className="routes-error-card" role="alert" aria-live="polite">
        <StatusBadge status="UNKNOWN" note="Routing status: UNAVAILABLE" />
        <p className="status-line">{analysisMessageFor(analysis.status)}</p>
      </div>
    );
  }

  return (
    <div id="map" className="real-routes-container route-strip-panel">
      <div className="route-strip-head">
        <span className="route-strip-title">Live routes · OSRM</span>
        <span className="route-strip-meta">
          <span className="route-provider-count">
            {routes.length} route{routes.length === 1 ? '' : 's'} returned by provider
          </span>
          {intel && intel.recommendation ? (
            <span className="recommended-mini-pill">
              <span className="status-dot" aria-hidden="true" />
              RECOMMENDED · {intel.recommendation.routeName}
            </span>
          ) : null}
          <StatusBadge status="LIVE" note="Real alternatives" />
        </span>
      </div>

      {routes.length === 1 ? (
        <p className="route-single-note" role="status">
          {SINGLE_ROUTE_NOTE}
        </p>
      ) : null}

      <div className="route-strip-scroll" aria-live="polite">
        <div className="real-route-grid">
          {routes.map((route) => {
            const idx = routes.findIndex((r) => r.id === route.id);
            const selected = selectedRealRoute && selectedRealRoute.id === route.id;
            const delta = (deltas || []).find((d) => d.id === route.id);
            const routeTag = (tags || []).find((t) => t.id === route.id);
            const color =
              ROUTE_COLORS[idx % ROUTE_COLORS.length];
            const recommended =
              intel && intel.recommendation && intel.recommendation.routeId === route.id;

            return (
              <article
                key={route.id}
                className={`real-route-card${selected ? ' real-route-card-selected' : ''}${
                  recommended ? ' real-route-card-recommended' : ''
                }`}
              >
                <div className="route-card-top">
                  <span className="route-card-id">
                    <span
                      className="route-card-dot"
                      style={{ background: color }}
                      aria-hidden="true"
                    />
                    <span className="route-card-name">
                      <strong>Route {idx + 1}</strong>
                      <span>{route.name}</span>
                    </span>
                  </span>
                  {recommended ? (
                    <StatusBadge status="LIVE" note="RECOMMENDED by route intelligence" />
                  ) : (
                    <StatusBadge status="LIVE" note="OSRM route" />
                  )}
                </div>

                {routeTag && routeTag.tags ? (
                  <div className="route-tags">
                    {routeTag.tags.map((tag) => (
                      <StatusBadge key={tag} status="STATIC" note={tag} />
                    ))}
                  </div>
                ) : null}

                <div className="route-card-metrics">
                  <span className="route-metric-pair">
                    <span className="stat-label">Distance</span>
                    <strong>{route.distanceKm} km</strong>
                  </span>
                  <span className="route-metric-sep" aria-hidden="true">·</span>
                  <span className="route-metric-pair">
                    <span className="stat-label">Duration</span>
                    <strong>{route.durationMin} min</strong>
                  </span>
                  {selected ? null : delta && delta.durationDelta !== null ? (
                    <small
                      className={
                        delta.durationDelta > 0 ? 'delta delta-plus' : 'delta delta-minus'
                      }
                    >
                      {delta.durationDelta > 0 ? '+' : ''}
                      {delta.durationDelta} min
                    </small>
                  ) : null}
                </div>

                <button
                  type="button"
                  className="btn btn-primary route-card-select"
                  aria-pressed={selected}
                  onClick={() => onSelectRealRoute(route.id)}
                >
                  {selected ? 'Driving this route' : 'Select this route'}
                </button>
              </article>
            );
          })}
        </div>
      </div>

      <div className="route-decision-context" id="route-decision" aria-live="polite">
        {selectedRealRoute ? (
          <div className="scenario-route-context">
            <StatusBadge status="LIVE" note="Selected real route" />
            <span className="trip-context-route">
              {selectedRealRoute.name} · {selectedRealRoute.distanceKm} km ·{' '}
              {selectedRealRoute.durationMin} min drive
            </span>
          </div>
        ) : null}

        {intel && intel.recommendation ? (
          <div className="scenario-route-context route-recommendation-line">
            <StatusBadge status="LIVE" note="Recommended route" />
            <span className="trip-context-route">
              {intel.recommendation.routeName} · assessment{' '}
              {intel.recommendation.score}/100
            </span>
          </div>
        ) : null}

        {weather && weather.status === 'ready' && weather.data ? (
          <div className="route-context-chip">
            <StatusBadge status="LIVE" note="Weather context" />
            <span className="section-sub">
              {weather.data.temperatureC}°C · {weather.data.description} at the destination.
            </span>
          </div>
        ) : null}
      </div>

      <p className="footnote-note route-intelligence-note">{ROUTE_INTELLIGENCE_NOTE}</p>
    </div>
  );
}