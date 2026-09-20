import { useMemo } from 'react';
import Section from './Section';
import StatusBadge from './StatusBadge';
import { getRoutes } from '../services/dataService';
import { routeCandidates, selectableRoute, tripStage } from '../services/controlCenter';
import { displayValue } from '../utils/formatting';

/**
 * Route-selection area — DEMO / MOCK layer only.
 *
 * Candidates are the Phase 9E prototype rows, disclosed ONLY after destination
 * + route analysis. Every candidate is clearly labelled MOCK / prototype and
 * is NEVER drawn on the real map. The REAL route lives in the separate
 * "Real Route" section (Phase 9F-4 Part 2); selecting it does not change this
 * demo layer.
 */
export default function RouteSelectionArea({
  destinationEntered,
  analyzed,
  selectedRouteId,
  onSelectRoute,
  trip,
  mapReady = false,
}) {
  const data = getRoutes();
  const rows = data.rows;
  const state = { destinationEntered, analyzed };
  const stage = tripStage(state);
  const candidates = useMemo(
    () => routeCandidates(rows, state),
    [rows, destinationEntered, analyzed]
  );

  return (
    <Section
      id="routes"
      title="Demo Route Intelligence"
      subtitle="Phase 9E prototype candidates only. These are fictional MOCK/TEST routes from the prepared dataset — NOT real navigation, and never drawn on the real map."
      status={{ status: 'MOCK', note: 'Demo candidates only' }}
    >
      {stage === 'no-destination' ? (
        <div className="panel-empty" aria-live="polite">
          <h3>No route context yet</h3>
          <p className="empty-state">
            Enter a destination above and run "Analyze Route" to generate route
            candidates.
          </p>
        </div>
      ) : stage === 'destination-set' ? (
        <div className="panel-empty" aria-live="polite">
          <h3>Destination set — analysis pending</h3>
          <p className="empty-state">
            Run "Analyze Route" to generate route candidates. They stay hidden
            until analysis is triggered.
          </p>
        </div>
      ) : (
        <div className="mock-warning">
          <StatusBadge status="MOCK" note="Prototype / Demo candidates" />
          <p>
            These are <strong>demo route candidates</strong> from the existing
            Phase 9E mock data, so that the control-centre flow can be explored
            end to end. They are <strong>NOT real navigation</strong>, are not
            drawn on the real map, and do not correspond to real city roads.
            {mapReady ? (
              <>
                {' '}
                A separate real route has been generated from live map services
                in the <em>Real Route</em> section above — this demo layer is
                intentionally not connected to it.
              </>
            ) : (
              <>
                {' '}
                If the real map analysis succeeds, its real route appears in the{' '}
                <em>Real Route</em> section.
              </>
            )}
          </p>
        </div>
      )}

      {stage !== 'routes-ready' || !candidates ? (
        <p className="placeholder-note" aria-live="polite">
          Route candidates are not shown before route analysis.
        </p>
      ) : (
        <>
          {trip ? (
            <div className="trip-context" aria-live="polite">
              <StatusBadge status="MOCK" note="Routing context" />
              <span className="trip-context-route">
                {trip.origin || 'Origin'} → {trip.destination}
              </span>
            </div>
          ) : null}

          <div className="route-select-grid" aria-live="polite">
            {candidates.map((route) => {
              const selectable = selectableRoute(route);
              const selected = selectedRouteId === route.route_id;
              return (
                <article
                  key={route.route_id}
                  className={`route-select-card${selected ? ' route-select-card-selected' : ''}`}
                >
                  <div className="route-card-head">
                    <span className="route-card-id">{route.route_id}</span>
                    <StatusBadge status={route.recommendation_status} />
                    <StatusBadge status="MOCK" note="Fictional demo" />
                  </div>
                  <div className="route-metrics">
                    <div className="route-metric">
                      <span className="stat-label">Score</span>
                      <span>{displayValue(route.route_score)}/100</span>
                    </div>
                    <div className="route-metric">
                      <span className="stat-label">Category</span>
                      <span>{displayValue(route.route_category)}</span>
                    </div>
                    <div className="route-metric">
                      <span className="stat-label">Confidence</span>
                      <span>{displayValue(route.route_confidence)}</span>
                    </div>
                    <div className="route-metric">
                      <span className="stat-label">Status</span>
                      <span>{displayValue(route.recommendation_status)}</span>
                    </div>
                    <div className="route-metric">
                      <span className="stat-label">Known segments</span>
                      <span>
                        {displayValue(route.known_segment_count)}/
                        {displayValue(route.total_segment_count)}
                      </span>
                    </div>
                  </div>
                  <p className="route-reason">{displayValue(route.reason)}</p>
                  {selectable ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      aria-pressed={selected}
                      onClick={() => onSelectRoute(route.route_id)}
                    >
                      {selected ? 'Route selected' : 'Select this route'}
                    </button>
                  ) : (
                    <p className="route-disabled-note">
                      {route.recommendation_status === 'INSUFFICIENT_DATA'
                        ? 'No score — insufficient data. Cannot be used as a routing context.'
                        : 'No score — invalid duplicate or unknown road. Cannot be used as a routing context.'}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
    </Section>
  );
}