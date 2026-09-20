import { useMemo } from 'react';
import Section from './Section';
import StatusBadge from './StatusBadge';
import VideoInvestigationPanel from './VideoInvestigationPanel';
import VehicleIntelligencePanel from './VehicleIntelligencePanel';
import TrackExplorerPanel from './TrackExplorerPanel';
import { getLevel8 } from '../services/dataService';
import {
  DEMO_LABEL,
  RECORDED_LABEL,
  GEO_CCTV_NOTE,
  INVESTIGATION_SOURCE_NOTE,
} from '../services/controlCenter';

/**
 * Command Centre — Evidence view: recorded ML video evidence.
 *
 * The recorded Level 8 dataset clips are TECHNICAL evidence here: analysis
 * status, observed activity metrics, per-vehicle intelligence and trajectories.
 * They are explicitly NOT live CCTV and NOT geographically mapped to the
 * selected real route. The CCTV view exposes the recorded-demo registry with
 * playback; this section keeps the recorded clips inspectable as evidence.
 */
export default function RecordedVideoEvidenceSection({
  trip,
  realRoute = null,
  sources = [],
  selectedResourceId = null,
  onSelectResource = null,
  onCloseResource = null,
}) {
  const level8 = getLevel8();
  const resources = Array.isArray(sources) ? sources : [];

  const selectedResource = useMemo(
    () => resources.find((r) => r.id === selectedResourceId) || null,
    [resources, selectedResourceId]
  );

  const countFor = (resource) => {
    const row = level8.classByVideo.find((r) => r.video === resource.video);
    return row ? row.total : null;
  };

  return (
    <Section
      id="ml-video-evidence"
      title="Recorded ML video evidence"
      subtitle="Documentary evidence from the Level 8 analysis for the selected route's demo segments. This is recorded footage — never a live feed and never geographically mapped — inspected here as technical evidence."
      status={{ status: 'STATIC', note: 'Recorded evidence' }}
    >
      <div className="status-banner">
        <StatusBadge status="MOCK" note={DEMO_LABEL} />
        <StatusBadge status="STATIC" note={RECORDED_LABEL} />
        <StatusBadge status="RECORDED" note="NOT geographically mapped" />
        <span className="section-sub">
          Clips are listed for the selected real route only, and each keeps its
          honest provenance. The CCTV view plays the recorded-demo registry's
          per-route cameras; these clips remain inspectable here as evidence.
        </span>
      </div>

      {!trip || !realRoute ? (
        <div className="panel-empty" aria-live="polite">
          <p className="empty-state">
            No trip analysed or no route selected — recorded ML evidence is
            contextual to the selected real route.
          </p>
          <p className="section-sub">{GEO_CCTV_NOTE}</p>
        </div>
      ) : (
        <>
          <div className="trip-context" aria-live="polite">
            <StatusBadge status="LIVE" note="Selected real route context" />
            <span className="trip-context-route">
              {trip.origin || 'Origin'} → {trip.destination} · {realRoute.name} ·{' '}
              {realRoute.distanceKm} km · {realRoute.durationMin} min (live)
            </span>
          </div>

          {resources.length === 0 ? (
            <p className="empty-state">
              No recorded ML evidence is available for this route.
            </p>
          ) : (
            <div className="cctv-card-grid" aria-live="polite">
              {resources.map((resource) => {
                const total = countFor(resource);
                const open = selectedResourceId === resource.id;
                return (
                  <article
                    key={resource.id}
                    className={`cctv-card${open ? ' cctv-card-open' : ''}`}
                  >
                    <div className="cctv-card-head">
                      <span className="cctv-card-id">{resource.id}</span>
                      <StatusBadge status="MOCK" note={DEMO_LABEL} />
                      <StatusBadge status="STATIC" note={RECORDED_LABEL} />
                    </div>
                    <h4>{resource.title}</h4>
                    <ul className="cctv-meta">
                      <li>
                        <span className="stat-label">Route segment (demo)</span>
                        <span>{resource.route_segment_id || '—'}</span>
                      </li>
                      <li>
                        <span className="stat-label">Source type</span>
                        <span>{resource.source_type || 'Recorded demo footage — not a live camera'}</span>
                      </li>
                      <li>
                        <span className="stat-label">Analysis status</span>
                        <span>{resource.analysis_status || '—'}</span>
                      </li>
                      <li>
                        <span className="stat-label">Recorded clip</span>
                        <span>{resource.video}</span>
                      </li>
                      <li>
                        <span className="stat-label">Observed activity</span>
                        <span>
                          {resource.traffic_metrics
                            ? `${String(
                                resource.traffic_metrics.activity_condition || 'UNKNOWN'
                              ).replace(/_/g, ' ')} · ${
                                resource.traffic_metrics.conservative_tracks ?? '—'
                              } tracks · ${
                                resource.traffic_metrics.activity_rate_tracks_per_min ?? '—'
                              } tracks/min · ${
                                resource.traffic_metrics.activity_index_per_1000_frames ?? '—'
                              } / 1000 frames`
                            : 'UNKNOWN'}
                        </span>
                      </li>
                      <li>
                        <span className="stat-label">Vehicles in clip</span>
                        <span>{total == null ? 'UNKNOWN' : `${total} (corrected)`}</span>
                      </li>
                      <li>
                        <span className="stat-label">Geographic position</span>
                        <span>{resource.geographicallyMapped ? 'Mapped' : 'None — not on this route'}</span>
                      </li>
                    </ul>
                    <p className="footnote-note">
                      Recorded dataset footage offered as technical evidence,
                      not a live camera; {INVESTIGATION_SOURCE_NOTE.toLowerCase()}
                    </p>
                    <button
                      type="button"
                      className="btn btn-primary"
                      aria-pressed={open}
                      onClick={() => (onSelectResource ? onSelectResource(resource.id) : null)}
                    >
                      {open ? 'Inspection open' : 'Open inspection'}
                    </button>
                  </article>
                );
              })}
            </div>
          )}

          {selectedResource ? (
            <>
              <VideoInvestigationPanel
                resource={selectedResource}
                onClose={onCloseResource}
              />
              <VehicleIntelligencePanel resource={selectedResource} />
              <TrackExplorerPanel resource={selectedResource} />
            </>
          ) : (
            <div className="panel-empty" id="intelligence" aria-live="polite">
              <h4>Vehicle Intelligence & Track Explorer</h4>
              <p className="empty-state">
                Open a recorded source above to reveal its vehicle intelligence
                and per-vehicle trajectories from the validated Level 8 data.
              </p>
            </div>
          )}
        </>
      )}
    </Section>
  );
}