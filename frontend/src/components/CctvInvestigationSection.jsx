import { useMemo, useState } from 'react';
import Section from './Section';
import StatusBadge from './StatusBadge';
import MlVideoAnalysisPanel from './MlVideoAnalysisPanel';
import { ROUTE_CCTV_CONTRACT } from '../services/routeIntelligence';
import { getDemoCctvEvidence } from '../services/dataService';
import {
  DEMO_LABEL,
  GEO_CCTV_NOTE,
  INVESTIGATION_SOURCE_NOTE,
  demoCctvVideoUrl,
  findCameraEvidence,
} from '../services/controlCenter';

/**
 * Command Centre — CCTV investigation view.
 *
 * Route-centric recorded-demo CCTV registry with REAL playback. The selected
 * real route shows exactly the recorded-demo sources the registry registers for
 * it (route_a/b/c → CCTV-A01..A03 / CCTV-B01..B03 / CCTV-C01..C03) via
 * tripIntel.cctv.byRoute. Selecting a camera plays its ORIGINAL recorded clip
 * (streamed by the Vite dev/preview server from data/demo_cctv/<route>/…) and
 * shows the prepared evidence for that exact camera (matched by cctv_id).
 *
 * Every source is honest recorded footage: RECORDED DEMO, NOT LIVE, NOT
 * geographically mapped. A route beyond the registry shows no cameras (nothing
 * fabricated — no padding, no awaiting placeholders pretending sources exist).
 *
 * Compact investigation layout:
 *   LEFT/MAIN  – large video player + selected CCTV title + RECORDED DEMO /
 *                NOT LIVE badge
 *   RIGHT/SIDE – 3 CCTV source cards for the selected route (selected one
 *                highlighted) + concise evidence panel for the selected camera.
 */
function switchRoute(routes, selectedId, onSelect, direction) {
  if (!onSelect || routes.length < 2) return;
  const idx = routes.findIndex((r) => r.id === selectedId);
  const base = idx === -1 ? 0 : idx;
  const next = (base + direction + routes.length) % routes.length;
  onSelect(routes[next].id);
}

const ACTIVITY_LABEL_CACHE = {};

function activityLabel(condition) {
  if (!condition) return 'UNKNOWN';
  if (!ACTIVITY_LABEL_CACHE[condition]) {
    ACTIVITY_LABEL_CACHE[condition] = String(condition).replace(/_/g, ' ');
  }
  return ACTIVITY_LABEL_CACHE[condition];
}

export default function CctvInvestigationSection({
  trip,
  routes = null,
  selectedRealRouteId = null,
  onSelectRoute = null,
  intel = null,
}) {
  const routeList = Array.isArray(routes) ? routes : [];

  const selectedRealRoute =
    routeList.find((r) => r.id === selectedRealRouteId) ||
    (routeList.length > 0 ? routeList[0] : null) ||
    null;

  const selectedKey = selectedRealRoute ? selectedRealRoute.id : null;

  const cameras = useMemo(() => {
    if (!intel || !intel.cctv || !selectedKey) return [];
    const byRoute = intel.cctv.byRoute || {};
    return Array.isArray(byRoute[selectedKey]) ? byRoute[selectedKey] : [];
  }, [intel, selectedKey]);

  const cameraEvidence = useMemo(
    () => (getDemoCctvEvidence() || {}).cameraEvidence || [],
    []
  );

  // Camera selection is local to this view: the selected card keeps a clear
  // visual state and the video + evidence follow without any page reload. When
  // the route changes, the derived selection falls back to its first camera.
  const [selectedCameraId, setSelectedCameraId] = useState(null);
  const selectedCamera = useMemo(
    () => cameras.find((c) => c.id === selectedCameraId) || cameras[0] || null,
    [cameras, selectedCameraId]
  );

  const selectedEvidence = useMemo(
    () => (selectedCamera ? findCameraEvidence(selectedCamera.id, cameraEvidence) : null),
    [selectedCamera, cameraEvidence]
  );

  const videoUrl =
    selectedCamera && selectedEvidence
      ? demoCctvVideoUrl(selectedEvidence.route_id, selectedEvidence.source_video)
      : null;

  return (
    <Section
      id="cctv"
      title="Route CCTV"
      subtitle={`Route-centric recorded-demo CCTV registry — the selected route shows only the recorded-demo sources registered for it (${ROUTE_CCTV_CONTRACT.slotsPerRoute} per demo route, RECORDED DEMO footage). No route ever shows another route's cameras or fabricated slots. Recorded ML video evidence remains the same dataset behind the Evidence view.`}
      status={{ status: 'PROTOTYPE', note: 'Recorded demo sources' }}
    >
      <div className="status-banner">
        <StatusBadge status="RECORDED" note={DEMO_LABEL} />
        <StatusBadge status="PROTOTYPE" note={ROUTE_CCTV_CONTRACT.kind} />
        <span className="section-sub">
          Sources only appear once a trip is analysed and a real route is
          selected; then exactly the registered recorded-demo sources for that
          route are listed — RECORDED DEMO footage, never live CCTV and never
          geographically mapped.
        </span>
      </div>

      {!trip ? (
        <div className="panel-empty" aria-live="polite">
          <p className="empty-state">
            No trip analysed yet. Enter a destination and run route analysis on
            the MAP / HOME view to reveal the per-route recorded-demo CCTV
            sources.
          </p>
          <p className="section-sub">{GEO_CCTV_NOTE}</p>
        </div>
      ) : routeList.length === 0 ? (
        <div className="panel-empty" aria-live="polite">
          <p className="empty-state">
            The real route analysis failed, so no recorded-demo CCTV registry
            is revealed.
          </p>
          <p className="section-sub">{GEO_CCTV_NOTE}</p>
        </div>
      ) : !selectedRealRoute ? (
        <div className="panel-empty" aria-live="polite">
          <p className="empty-state">
            No route selected. Select a route on the map or via the switcher to
            reveal its recorded-demo CCTV sources.
          </p>
          <p className="section-sub">{GEO_CCTV_NOTE}</p>
        </div>
      ) : cameras.length === 0 ? (
        <div className="panel-empty" aria-live="polite">
          <p className="empty-state">
            This route has no recorded-demo CCTV registered. The registry
            defines sources for the 3 demo routes only — no fabricated cameras
            are shown for a route outside it.
          </p>
          <p className="section-sub">{GEO_CCTV_NOTE}</p>
        </div>
      ) : (
        <>
          {trip ? (
            <div className="trip-context" aria-live="polite">
              <StatusBadge status="LIVE" note="Selected real route context" />
              <span className="trip-context-route">
                {trip.origin || 'Origin'} → {trip.destination} ·{' '}
                {selectedRealRoute.name} · {selectedRealRoute.distanceKm} km ·{' '}
                {selectedRealRoute.durationMin} min (live)
              </span>
            </div>
          ) : null}

          {routeList.length > 1 ? (
            <div className="route-switcher" aria-label="CCTV route switcher">
              <span className="section-sub">Showing the CCTV registry for:</span>
              <div className="route-switcher-controls">
                <button
                  type="button"
                  className="route-switcher-step"
                  aria-label="Previous route"
                  onClick={() =>
                    switchRoute(routeList, selectedRealRouteId, onSelectRoute, -1)
                  }
                  disabled={routeList.length < 2}
                >
                  ‹
                </button>
                {routeList.map((route, i) => (
                  <button
                    key={route.id}
                    type="button"
                    className={`route-switcher-btn${
                      route.id === selectedRealRoute.id
                        ? ' route-switcher-btn-active'
                        : ''
                    }`}
                    aria-pressed={route.id === selectedRealRoute.id}
                    title={`${route.name} · ${route.distanceKm} km · ${route.durationMin} min`}
                    onClick={() => onSelectRoute(route.id)}
                  >
                    Route {i + 1}
                  </button>
                ))}
                <button
                  type="button"
                  className="route-switcher-step"
                  aria-label="Next route"
                  onClick={() =>
                    switchRoute(routeList, selectedRealRouteId, onSelectRoute, 1)
                  }
                  disabled={routeList.length < 2}
                >
                  ›
                </button>
              </div>
              <p className="section-sub route-switcher-caption">
                {selectedRealRoute.name} · {selectedRealRoute.distanceKm} km ·{' '}
                {selectedRealRoute.durationMin} min (live)
              </p>
            </div>
          ) : null}

          <div className="cctv-investigation" aria-live="polite">
            <div className="cctv-investigation-main">
              <figure className="video-frame cctv-player-frame">
                {videoUrl && selectedCamera ? (
                  <video
                    key={selectedCamera.id}
                    controls
                    preload="metadata"
                    src={videoUrl}
                    aria-label={`Recorded demo CCTV: ${selectedCamera.cctv_id}. Not live, not geographically mapped.`}
                  >
                    Your browser does not support the video element.
                  </video>
                ) : (
                  <div className="panel-empty">
                    <p className="empty-state">
                      No recorded clip is playable for this camera — none
                      fabricated for an unmatched source.
                    </p>
                  </div>
                )}
                <figcaption className="video-caption">
                  {videoUrl
                    ? `Recording: ${selectedEvidence.source_video} — RECORDED DEMO demo CCTV footage. NOT LIVE and NOT geographically mapped.`
                    : 'No playable recorded clip for this camera.'}
                </figcaption>
              </figure>

              <div className="cctv-player-title">
                <h4>{selectedCamera ? selectedCamera.title : 'No camera selected'}</h4>
                <StatusBadge status="RECORDED" note="RECORDED DEMO" />
                <StatusBadge status="STATIC" note="NOT LIVE" />
                <StatusBadge status="RECORDED" note="NOT geographically mapped" />
              </div>

              <p className="section-sub">
                {INVESTIGATION_SOURCE_NOTE} This is recorded demo footage
                associated with demo route segment{' '}
                {selectedCamera ? selectedCamera.route_segment_id : '—'} — it is
                not a live camera and carries no geographic position.
              </p>
            </div>

            <aside className="cctv-investigation-side">
              <h4>Sources — {selectedRealRoute.name}</h4>
              <div className="cctv-source-scroll">
                {cameras.map((camera) => {
                  const selected = camera.id === selectedCamera.id;
                  return (
                    <article
                      key={camera.id}
                      className={`cctv-card${selected ? ' cctv-card-open' : ''}`}
                      role="button"
                      tabIndex={0}
                      aria-pressed={selected}
                      onClick={() => setSelectedCameraId(camera.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedCameraId(camera.id);
                        }
                      }}
                    >
                      <div className="cctv-card-head">
                        <span className="cctv-card-id">{camera.cctv_id || camera.id}</span>
                        <StatusBadge status="RECORDED" note={DEMO_LABEL} />
                        {selected ? <StatusBadge status="STATIC" note="Selected" /> : null}
                      </div>
                      <h4>{camera.title}</h4>
                      <ul className="cctv-meta">
                        <li>
                          <span className="stat-label">Route segment</span>
                          <span>{camera.route_segment_id}</span>
                        </li>
                        <li>
                          <span className="stat-label">Recorded video</span>
                          <span>
                            {camera.traffic_metrics && camera.traffic_metrics.activity_condition
                              ? activityLabel(camera.traffic_metrics.activity_condition)
                              : 'Not yet analysed'}
                          </span>
                        </li>
                      </ul>
                    </article>
                  );
                })}
              </div>

              <div className="cctv-evidence-panel" aria-live="polite">
                <h4>Evidence — {selectedCamera ? selectedCamera.cctv_id : '—'}</h4>
                {selectedEvidence ? (
                  <>
                    <ul className="cctv-meta">
                      <li>
                        <span className="stat-label">CCTV ID</span>
                        <span>{selectedEvidence.cctv_id}</span>
                      </li>
                      <li>
                        <span className="stat-label">Route</span>
                        <span>
                          Route {selectedCamera.route_index} · {selectedCamera.registry_route_id}
                        </span>
                      </li>
                      <li>
                        <span className="stat-label">Segment</span>
                        <span>{selectedCamera.route_segment_id}</span>
                      </li>
                      <li>
                        <span className="stat-label">Recorded video</span>
                        <span>{selectedEvidence.source_video}</span>
                      </li>
                      <li>
                        <span className="stat-label">Activity</span>
                        <span>{activityLabel(selectedEvidence.activity_condition)}</span>
                      </li>
                      <li>
                        <span className="stat-label">Vehicle activity</span>
                        <span>{selectedEvidence.conservative_tracks} tracks</span>
                      </li>
                      <li>
                        <span className="stat-label">Activity rate</span>
                        <span>{selectedEvidence.activity_rate_tracks_per_min} tracks/min</span>
                      </li>
                      <li>
                        <span className="stat-label">Activity index</span>
                        <span>{selectedEvidence.activity_index_per_1000_frames} / 1000 frames</span>
                      </li>
                      <li>
                        <span className="stat-label">Duration</span>
                        <span>{selectedEvidence.duration_seconds} sec</span>
                      </li>
                      <li>
                        <span className="stat-label">Frames</span>
                        <span>{selectedEvidence.total_frames}</span>
                      </li>
                      <li>
                        <span className="stat-label">Geographic position</span>
                        <span>
                          {selectedCamera.geographicallyMapped
                            ? 'Mapped'
                            : 'None — not geographically mapped'}
                        </span>
                      </li>
                    </ul>
                    <p className="footnote-note">
                      {INVESTIGATION_SOURCE_NOTE} Demo activity values only —
                      never claimed as real-world congestion.
                    </p>
                  </>
                ) : (
                  <p className="empty-state">
                    No prepared evidence exists for this registered camera — none
                    is fabricated for an unmatched source.
                  </p>
                )}
              </div>
            </aside>
          </div>

          <div className="cctv-source-note">
            <StatusBadge status="RECORDED" note="NOT geographically mapped" />
            <span className="section-sub">
              {INVESTIGATION_SOURCE_NOTE} These recorded clips are presented as
              technical ML evidence in the Evidence view, never as live CCTV on
              this route.
            </span>
          </div>

          <MlVideoAnalysisPanel />

          <p className="section-sub" style={{ marginTop: 10 }}>
            No CCTV slot carries a coordinate and none is placed on a map. The
            demo activity metric is a vehicle-activity proxy, not direct
            real-world congestion. Live per-route CCTV feeds are next on the
            roadmap; until then the registry only lists recorded-demo sources
            that genuinely exist.
          </p>
        </>
      )}
    </Section>
  );
}