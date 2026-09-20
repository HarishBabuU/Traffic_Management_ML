import Section from './Section';
import StatusBadge from './StatusBadge';
import {
  describeLayers,
  routeEvidenceStatus,
  ROUTE_INTELLIGENCE_LAYER_NOTE,
} from '../services/routeIntelligence.js';

/**
 * Intelligence view — why this route. Every statement rendered here is derived
 * from the service-layer intelligence snapshot (never recomputed in the UI),
 * and each provider layer keeps its honest mode label (REAL / LIVE / DEMO /
 * SIMULATED / RECORDED).
 *
 * The per-route intelligence summary strip above lists EVERY provider-returned
 * route in provider order (nothing hidden, nothing re-ranked by the UI): each
 * compact card shows route name + provider distance/duration + recorded CCTV
 * evidence + simulated route weather + simulated road condition + the existing
 * route-intelligence assessment. Selecting a card drills into that route's
 * full reasoning below.
 */
function activityConditionLabel(condition) {
  if (!condition) return null;
  return String(condition).replace(/_/g, ' ').toUpperCase();
}

function dominantActivityCondition(traffic) {
  const conditions = (
    traffic && Array.isArray(traffic.segments) ? traffic.segments : []
  )
    .map((s) => (s && s.activityCondition ? String(s.activityCondition).toUpperCase() : null))
    .filter(Boolean);
  if (conditions.length === 0) return null;
  const counts = {};
  conditions.forEach((c) => {
    counts[c] = (counts[c] || 0) + 1;
  });
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
}

export default function RouteReasoningPanel({
  trip,
  route,
  intel,
  assessment,
  weather,
  recommendation,
  routes = null,
  onSelectRoute = null,
}) {
  if (!trip || !route) {
    return (
      <Section
        id="reasoning"
        title="Route reasoning"
        subtitle="Analyze a trip first — reasoning is only produced when routes and intelligence are available."
        status={{ status: 'UNKNOWN', note: 'No trip analyzed' }}
      >
        <div className="panel-empty" aria-live="polite">
          <h3>No active trip</h3>
          <p className="empty-state">
            Set an origin and destination on the Command Center and run route
            analysis to see the reasoning behind each option here.
          </p>
        </div>
      </Section>
    );
  }

  if (!intel) {
    return (
      <Section
        id="reasoning"
        title="Route reasoning"
        subtitle={`${route.name} · provider routing geometry`}
        status={{ status: 'STATIC', note: 'Intelligence pending' }}
      >
        <div className="panel-empty" aria-live="polite">
          <h3>Intelligence not yet available</h3>
          <p className="empty-state">
            The route is real, but the intelligence layers (traffic, road,
            CCTV, weather) have not produced a reasoned assessment yet. No
            fabricated score is shown.
          </p>
        </div>
      </Section>
    );
  }

  const traffic = intel.traffic && intel.traffic.byRoute
    ? intel.traffic.byRoute[route.id] || null
    : null;
  const road = intel.road && intel.road.byRoute ? intel.road.byRoute[route.id] || null : null;
  const cameras = intel.cctv && intel.cctv.byRoute ? intel.cctv.byRoute[route.id] || [] : [];
  const factors = (assessment && assessment.factors) || null;
  const factorOrder = ['traffic', 'weather', 'road', 'travelTime'];
  const factorLabels = {
    traffic: 'Traffic (observed demo)',
    weather: 'Weather impact (LIVE)',
    road: 'Road condition (SIMULATED)',
    travelTime: 'Travel time efficiency (REAL)',
  };
  const evidence = routeEvidenceStatus({
    route,
    traffic,
    road,
    weatherImpact: intel ? intel.weatherImpact || null : null,
    cameras,
  });

  // Compact summary for EVERY provider-returned route, in provider order.
  // All values come from the existing tripIntel snapshot — nothing invented.
  const routeSummaries = (Array.isArray(routes) ? routes : []).map((r, idx) => {
    const rCameras =
      (intel.cctv && intel.cctv.byRoute ? intel.cctv.byRoute[r.id] : null) || [];
    const rTraffic =
      (intel.traffic && intel.traffic.byRoute ? intel.traffic.byRoute[r.id] : null) || null;
    const rRoad =
      (intel.road && intel.road.byRoute ? intel.road.byRoute[r.id] : null) || null;
    const rWeather =
      (intel.routeWeather && intel.routeWeather.byRoute
        ? intel.routeWeather.byRoute[r.id]
        : null) || null;
    const rAssessment = (intel.assessments ? intel.assessments[r.id] : null) || null;
    const rWeatherState =
      rWeather && Array.isArray(rWeather.segments) && rWeather.segments.length > 0
        ? rWeather.segments[0].state || null
        : null;
    const rRoadStates =
      rRoad && rRoad.knownSegments > 0
        ? rRoad.segments.map((s) => s.condition).filter(Boolean)
        : [];
    return {
      route: r,
      index: idx,
      cameras: rCameras,
      traffic: rTraffic,
      road: rRoad,
      routeWeather: rWeather,
      assessment: rAssessment,
      activityCondition: dominantActivityCondition(rTraffic),
      weatherState: rWeatherState,
      roadStates: rRoadStates,
      recommended: !!(intel.recommendation && intel.recommendation.routeId === r.id),
    };
  });

  return (
    <Section
      id="reasoning"
      title="Route reasoning"
      subtitle={`${route.name} · ${route.distanceKm} km · ${route.durationMin} min drive · ${trip.origin || 'Origin'} → ${trip.destination}`}
      status={
        recommendation && recommendation.routeId === route.id
          ? { status: 'LIVE', note: 'RECOMMENDED by route intelligence' }
          : assessment && assessment.score !== null
            ? { status: 'STATIC', note: 'Assessment computed from data' }
            : { status: 'UNKNOWN', note: 'Insufficient data' }
      }
    >
      {recommendation && recommendation.routeId === route.id ? (
        <div className="scenario-route-context route-recommendation-line" aria-live="polite">
          <StatusBadge status="LIVE" note="Recommended route" />
          <span className="trip-context-route">
            {recommendation.routeName} · assessment {recommendation.score}/100
          </span>
          {recommendation.why ? (
            <span className="section-sub recommendation-why">
              {recommendation.why}
            </span>
          ) : null}
        </div>
      ) : recommendation ? (
        <div className="scenario-route-context" aria-live="polite">
          <StatusBadge status="STATIC" note="Recommended alternative" />
          <span className="trip-context-route">
            The intelligence layer recommends {recommendation.routeName} (
            {recommendation.score}/100) for this trip.
          </span>
        </div>
      ) : null}

      {routeSummaries.length > 0 ? (
        <div className="route-intel-strip" aria-label="Per-route intelligence summary">
          <div className="route-intel-head">
            <h3 className="sub-heading">Every provider route — intelligence summary</h3>
            <span className="section-sub">
              All {routeSummaries.length} OSRM alternative
              {routeSummaries.length === 1 ? '' : 's'} stay visible in provider
              order. Select a card to inspect its full reasoning below.
            </span>
          </div>
          <div className="route-intel-scroll">
            {routeSummaries.map((r) => {
              const selected = route && route.id === r.route.id;
              return (
                <article
                  key={r.route.id}
                  className={`route-intel-card${
                    selected ? ' route-intel-card-selected' : ''
                  }${r.recommended ? ' route-intel-card-recommended' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  onClick={() => (onSelectRoute ? onSelectRoute(r.route.id) : null)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      if (onSelectRoute) onSelectRoute(r.route.id);
                    }
                  }}
                >
                  <header className="route-intel-card-head">
                    <span className="route-intel-card-title">
                      <strong>Route {r.index + 1}</strong>
                      <span>{r.route.name}</span>
                    </span>
                    {r.recommended ? (
                      <StatusBadge status="LIVE" note="RECOMMENDED" />
                    ) : r.assessment && r.assessment.score !== null ? (
                      <StatusBadge status="STATIC" note="Eligible" />
                    ) : (
                      <StatusBadge status="UNKNOWN" note="Insufficient data" />
                    )}
                  </header>
                  <dl className="route-intel-meta">
                    <div className="route-intel-row">
                      <dt>Distance</dt>
                      <dd>
                        {r.route.distanceKm} km <span className="section-sub">(OSRM)</span>
                      </dd>
                    </div>
                    <div className="route-intel-row">
                      <dt>Duration</dt>
                      <dd>
                        {r.route.durationMin} min <span className="section-sub">(OSRM)</span>
                      </dd>
                    </div>
                    <div className="route-intel-row">
                      <dt>CCTV evidence</dt>
                      <dd>
                        {r.cameras.length > 0 ? (
                          <span>
                            {r.cameras.length} recorded CCTV source
                            {r.cameras.length === 1 ? '' : 's'}
                            {r.activityCondition
                              ? ` · Recorded CCTV vehicle activity: ${activityConditionLabel(
                                  r.activityCondition
                                )}`
                              : ''}
                            {' · Recorded demo evidence'}
                          </span>
                        ) : (
                          'No recorded CCTV sources registered'
                        )}
                      </dd>
                    </div>
                    <div className="route-intel-row">
                      <dt>Route weather — SIMULATED / DEMO</dt>
                      <dd>{r.weatherState || 'Data unavailable'}</dd>
                    </div>
                    <div className="route-intel-row">
                      <dt>Road condition — SIMULATED / DEMO</dt>
                      <dd>
                        {r.roadStates.length > 0 ? r.roadStates.join(' · ') : 'Data unavailable'}
                      </dd>
                    </div>
                    <div className="route-intel-row">
                      <dt>Assessment</dt>
                      <dd>
                        {r.assessment && r.assessment.score !== null
                          ? `${r.assessment.score}/100 · ${r.assessment.recommendationStatus}`
                          : 'Data unavailable'}
                      </dd>
                    </div>
                  </dl>
                  <p className="footnote-note route-intel-note">
                    {r.recommended
                      ? 'RECOMMENDED by the existing route-intelligence assessment.'
                      : 'Recorded demo evidence only — not geographically verified.'}
                  </p>
                </article>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="route-evidence" aria-label="Route intelligence">
        <h3 className="sub-heading">Route intelligence</h3>
        <p className="section-sub">
          The recorded demo CCTV sources for this route, the ML evidence that is
          actually available for each source, and how that combines with the
          live weather, simulated road condition, simulated route weather and
          OSRM travel metrics — for the selected route only.
        </p>
        <dl className="route-evidence-grid">
          <div className="route-evidence-row">
            <dt>Traffic evidence</dt>
            <dd className="route-evidence-value">
              <StatusBadge
                status={evidence.traffic.status}
                note={
                  evidence.traffic.status === 'DEMO'
                    ? 'recorded ML analysis'
                    : 'no valid ML evidence mapping'
                }
              />
              <span>
                CCTV sources available:{' '}
                <strong>
                  {evidence.cctv.total}/{evidence.cctv.total}
                </strong>{' '}
                · ML evidence available:{' '}
                <strong>
                  {evidence.traffic.mlEvidenceAvailable}/{evidence.traffic.totalSources}
                </strong>
              </span>
              {evidence.traffic.observation ? (
                <span className="route-evidence-observation">
                  Observation: <strong>{evidence.traffic.observation.level}</strong> —{' '}
                  {evidence.traffic.observation.label}
                  {evidence.traffic.observation.vehicleEstimate !== null
                    ? ` (${evidence.traffic.observation.vehicleEstimate} vehicles, corrected)`
                    : ''}
                </span>
              ) : (
                <span className="route-evidence-observation">UNKNOWN / DEMO EVIDENCE ONLY</span>
              )}
            </dd>
          </div>
          <div className="route-evidence-row">
            <dt>Weather</dt>
            <dd className="route-evidence-value">
              <StatusBadge
                status={evidence.weather.status}
                note={evidence.weather.status === 'LIVE' ? 'Open-Meteo reading' : 'no live reading'}
              />
              <span>
                {evidence.weather.status === 'LIVE'
                  ? `impact ${evidence.weather.level}`
                  : 'UNKNOWN — no live reading retrieved'}
              </span>
            </dd>
          </div>
          <div className="route-evidence-row">
            <dt>Road</dt>
            <dd className="route-evidence-value">
              <StatusBadge
                status={evidence.road.status}
                note={evidence.road.status === 'SIMULATED' ? 'demo layer, not real roads' : 'no simulated row'}
              />
              <span>
                {evidence.road.status === 'SIMULATED'
                  ? `${evidence.road.condition} (simulated)`
                  : 'UNKNOWN'}
              </span>
            </dd>
          </div>
          <div className="route-evidence-row">
            <dt>Travel (OSRM)</dt>
            <dd className="route-evidence-value">
              <StatusBadge
                status={evidence.travel.status}
                note={evidence.travel.status === 'REAL' ? 'provider metrics' : 'unavailable'}
              />
              <span>
                {evidence.travel.status === 'REAL'
                  ? `${evidence.travel.distanceKm} km · ${evidence.travel.durationMin} min`
                  : 'UNKNOWN'}
              </span>
            </dd>
          </div>
        </dl>
        <div className="route-evidence-status" aria-label="Evidence status">
          <span className="section-sub">Evidence status:</span>
          <StatusBadge
            status="DEMO"
            note="Traffic · CCTV (recorded, not geographically verified)"
          />
          <StatusBadge status={evidence.weather.status} note="Weather" />
          <StatusBadge status={evidence.road.status} note="Road" />
          <StatusBadge status={evidence.travel.status} note="Travel (OSRM)" />
          {evidence.evidenceStatuses.unknown ? <StatusBadge status="UNKNOWN" note="No ML mapped" /> : null}
        </div>
        <p className="footnote-note route-intelligence-note">{evidence.associationNote}</p>
      </div>

      <div className="reasoning-grid">
        <div className="reasoning-block">
          <h3 className="sub-heading">Why this route is assessed this way</h3>
          {assessment && assessment.explanation ? (
            <p className="footnote-note">{assessment.explanation}</p>
          ) : (
            <p className="empty-state">
              Data unavailable — the assessment could not be computed from the
              available intelligence, so no reason is invented.
            </p>
          )}
          {recommendation && recommendation.routeId === route.id && recommendation.why ? (
            <p className="footnote-note recommendation-why">{recommendation.why}</p>
          ) : null}
        </div>

        <div className="reasoning-block">
          <h3 className="sub-heading">Factor breakdown</h3>
          {assessment && assessment.score !== null ? (
            <p className="footnote-note">
              Route assessment <strong>{assessment.score}/100</strong> · status{' '}
              {assessment.recommendationStatus} — computed from the configured
              weights over the known factors only.
            </p>
          ) : null}
          {factors ? (
            <div className="factor-card-grid" aria-label="Route factor breakdown">
              {factorOrder.map((key) => {
                const f = factors[key];
                if (!f) return null;
                return (
                  <article key={key} className={`factor-card${f.known ? '' : ' factor-card-unknown'}`}>
                    <header className="factor-card-head">
                      <h4>{factorLabels[key] || key}</h4>
                      <StatusBadge
                        status={f.known ? (f.mode && f.mode !== 'STATIC' ? f.mode : 'STATIC') : 'UNKNOWN'}
                        note={f.known ? String(f.level || (f.score ?? '')).toUpperCase() : 'UNKNOWN'}
                      />
                    </header>
                    <p className="factor-card-score">
                      {f.known && f.score !== null ? `${Math.round(f.score)}/100` : '—'}
                    </p>
                    <p className="factor-card-source">
                      {f.known ? (f.known && f.score !== null ? `weight ${f.weight}%` : '—') : 'excluded (not known)'}
                    </p>
                    <p className="footnote-note">{f.source || '—'}</p>
                  </article>
                );
              })}
              <article className={`factor-card${cameras.length > 0 ? '' : ' factor-card-unknown'}`}>
                <header className="factor-card-head">
                  <h4>CCTV (observed demo)</h4>
                  <StatusBadge
                    status={cameras.length > 0 ? 'STATIC' : 'UNKNOWN'}
                    note={cameras.length > 0 ? `${cameras.length} SOURCE${cameras.length === 1 ? '' : 'S'}` : 'UNKNOWN'}
                  />
                </header>
                <p className="factor-card-score">
                  {cameras.length > 0 ? `${cameras.length}` : '—'}
                </p>
                <p className="factor-card-source">
                  {cameras.length > 0 ? 'recorded demo segments, no score' : 'no demo sources for this route'}
                </p>
                <p className="footnote-note">
                  Recorded demo footage only — never a live feed and never
                  geographically mapped.
                </p>
              </article>
            </div>
          ) : (
            <p className="empty-state">
              No factors are available — the assessment could not be computed
              from the provided intelligence.
            </p>
          )}
          {assessment && assessment.explanation ? (
            <p className="footnote-note">{assessment.explanation}</p>
          ) : null}
        </div>

        <div className="reasoning-block">
          <h3 className="sub-heading">Segment traffic observations (DEMO, recorded)</h3>
          {traffic && traffic.segments && traffic.segments.length > 0 ? (
            <ul className="segment-list">
              {traffic.segments.map((seg) => (
                <li key={seg.segmentId} className={seg.known ? '' : 'factor-unknown'}>
                  <StatusBadge
                    status={seg.known ? 'STATIC' : 'UNKNOWN'}
                    note={seg.known ? seg.level : 'UNKNOWN'}
                  />
                  <span className="section-sub">
                    {seg.segmentId} · {seg.video}
                    {seg.known
                      ? ` · ${seg.activityRate ?? '—'} ids/sec · ${seg.vehicles ?? '—'} vehicles (corrected)`
                      : ' — no recorded observation'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">No recorded traffic observations exist for this route.</p>
          )}
        </div>
      </div>

      <div className="reasoning-grid">
        <div className="reasoning-block">
          <h3 className="sub-heading">Road conditions (SIMULATED / DEMO layer)</h3>
          {road && road.segments && road.segments.length > 0 ? (
            <ul className="segment-list">
              {road.segments.map((seg) => (
                <li key={seg.segmentId} className={seg.known ? '' : 'factor-unknown'}>
                  <StatusBadge
                    status={seg.known ? 'SIMULATED' : 'UNKNOWN'}
                    note={seg.known ? seg.condition : 'UNKNOWN'}
                  />
                  <span className="section-sub">
                    {seg.segmentId}
                    {seg.risk ? ` · risk: ${seg.risk}` : ''}
                    {seg.known ? '' : ' · no row available'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">No simulated road rows were available for this route.</p>
          )}
          <p className="footnote-note">
            {road ? road.source : 'Road condition layer unloaded.'} Not real roads —
            a simulated demo layer until a real provider replaces it.
          </p>
        </div>

        <div className="reasoning-block">
          <h3 className="sub-heading">Route weather (SIMULATED / DEMO)</h3>
          {intel.routeWeather && intel.routeWeather.byRoute &&
          intel.routeWeather.byRoute[route.id] &&
          intel.routeWeather.byRoute[route.id].segments.length > 0 ? (
            <ul className="segment-list">
              {intel.routeWeather.byRoute[route.id].segments.map((seg) => (
                <li key={seg.segmentId}>
                  <StatusBadge
                    status="SIMULATED"
                    note={seg.state}
                  />
                  <span className="section-sub">
                    {seg.segmentId} · {seg.state}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">No simulated route weather for this route.</p>
          )}
          <p className="footnote-note">
            {intel.routeWeather && intel.routeWeather.byRoute &&
             intel.routeWeather.byRoute[route.id]
              ? intel.routeWeather.byRoute[route.id].label
              : 'Route weather layer unloaded.'}
          </p>
        </div>

        <div className="reasoning-block">
          <h3 className="sub-heading">Weather impact (LIVE)</h3>
          {intel.weatherImpact && intel.weatherImpact.known ? (
            <p className="section-sub">
              Weather impact for this trip is{' '}
              <strong>{intel.weatherImpact.level}</strong>{' '}
              {weather && weather.data
                ? `— live reading ${weather.data.temperatureC}°C · ${weather.data.description} at ${trip.destination}.`
                : '— from the live provider reading.'}
            </p>
          ) : (
            <p className="section-sub">
              Weather is UNKNOWN — no live reading was retrieved, so the weather
              factor is excluded from the assessment rather than guessed.
            </p>
          )}
        </div>
      </div>

      <div className="reasoning-block">
        <h3 className="sub-heading">Observed CCTV sources (DEMO, recorded)</h3>
        {cameras.length > 0 ? (
          <div className="cctv-thumb-grid">
            {cameras.map((cam) => (
              <div className="cctv-thumb" key={cam.id}>
                <StatusBadge status="STATIC" note={cam.analysis_status} />
                <p className="section-sub">
                  <strong>{cam.id}</strong> · {cam.route_segment_id}
                </p>
                <p className="footnote-note">
                  {cam.video} — RECORDED demo footage, no geographic position.
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-state">No demo CCTV sources are associated with this route.</p>
        )}
      </div>

      <div className="reasoning-block">
        <h3 className="sub-heading">Provider layer disclosure</h3>
        <ul className="layer-list">
          {intel.layers && intel.layers.length > 0
            ? intel.layers.map((l) => (
                <li key={l.layer}>
                  <StatusBadge status={l.mode} note={l.layer} />
                  <span className="section-sub">
                    {l.provider} — {l.note}
                  </span>
                </li>
              ))
            : describeLayers(weather).map((l) => (
                <li key={l.layer}>
                  <StatusBadge status={l.mode} note={l.layer} />
                  <span className="section-sub">
                    {l.provider} — {l.note}
                  </span>
                </li>
              ))}
        </ul>
        <p className="footnote-note route-intelligence-note">{ROUTE_INTELLIGENCE_LAYER_NOTE}</p>
      </div>
    </Section>
  );
}