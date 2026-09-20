import { useMemo, useState } from 'react';
import StatusBadge from './StatusBadge';
import {
  getTrackSummaries,
  getTrackTrajectories,
  getValidation,
} from '../services/dataService';
import { displayValue } from '../utils/formatting';

const CLASS_COLORS = {
  car: '#2563eb',
  motorcycle: '#d97706',
  bus: '#7c3aed',
  truck: '#b91c1c',
  bicycle: '#0d9488',
};

function resolutionFor(video, fpsSources) {
  const info = fpsSources && fpsSources[video];
  if (info && info.resolution) {
    const [w, h] = String(info.resolution).split('x').map(Number);
    if (w && h) return { width: w, height: h };
  }
  return { width: 1280, height: 720 };
}

/**
 * Command Centre — Track Explorer.
 *
 * Uses ONLY the prepared evidence (Level 8A corrected track summaries + Level
 * 7D centroid trajectories). It never reruns YOLO/ByteTrack and never invents
 * a trajectory. For tracks whose full points are not prepared (only the
 * longest tracks per clip have paths), the panel says so instead of guessing.
 */
export default function TrackExplorerPanel({ resource }) {
  const summaries = getTrackSummaries();
  const trajectories = getTrackTrajectories();
  const validation = getValidation();

  const video = resource.video;
  const tracks = useMemo(
    () =>
      (summaries.trackCountByVideo[video] || [])
        .slice()
        .sort((a, b) => Number(b.duration_frames) - Number(a.duration_frames)),
    [summaries.trackCountByVideo, video]
  );

  const [selectedTrackId, setSelectedTrackId] = useState(null);
  const selectedTrack = useMemo(
    () =>
      selectedTrackId == null
        ? tracks[0] || null
        : tracks.find((t) => String(t.track_id) === String(selectedTrackId)) || tracks[0] || null,
    [tracks, selectedTrackId]
  );

  const [scrubIndex, setScrubIndex] = useState(0);

  const trajectory = useMemo(
    () =>
      (trajectories.perVideo[video] || []).find(
        (t) => String(t.track_id) === String(selectedTrack && selectedTrack.track_id)
      ) || null,
    [trajectories.perVideo, video, selectedTrack]
  );

  const resolution = useMemo(
    () => resolutionFor(video, validation.level8 && validation.level8.fps_sources),
    [video, validation.level8]
  );

  const pathPoints = (trajectory && trajectory.centroidPath) || [];
  const pathPoint = pathPoints[Math.min(scrubIndex, pathPoints.length - 1)] || null;

  const pathD = pathPoints
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.centroid_x.toFixed(1)},${p.centroid_y.toFixed(1)}`)
    .join(' ');

  const className = selectedTrack ? selectedTrack.vehicle_class_stable : 'unknown';
  const trackColor = CLASS_COLORS[className] || '#64748b';

  const changeTrack = (trackId) => {
    setSelectedTrackId(trackId);
    setScrubIndex(0);
  };

  return (
    <section className="panel track-explorer-panel" id="track-explorer" aria-label="Track Explorer">
      <header className="section-head">
        <div>
          <h3>Track Explorer</h3>
          <p className="section-sub">
            Final corrected identities for the recorded clip "{video}" (Level 8A)
            with the centroid path and frame progression for the longest tracks
            (Level 7D trajectories, preserved verbatim).
          </p>
        </div>
        <StatusBadge status="RECORDED" note="Recorded dataset · read-only" />
      </header>

      <div className="stat-row">
        <div className="stat-chip">
          <span className="stat-label">Corrected tracks in this clip</span>
          <span className="stat-value">{displayValue(tracks.length)}</span>
        </div>
        <div className="stat-chip">
          <span className="stat-label">Total trajectory rows</span>
          <span className="stat-value">{displayValue(trajectories.totalTrajectoryRows)}</span>
        </div>
        <div className="stat-chip">
          <span className="stat-label">Merge-union artifact rows</span>
          <span className="stat-value">{displayValue(trajectories.artifactDuplicateRows)}</span>
        </div>
        <div className="stat-chip">
          <span className="stat-label">Trajectory source</span>
          <span className="stat-value">Level 7D (recorded)</span>
        </div>
      </div>

      <div className="track-selector" aria-label="Select a tracked vehicle">
        <span className="legend-title">Tracks (longest first)</span>
        <div className="track-chip-row">
          {tracks.map((t) => {
            const active = selectedTrack && String(t.track_id) === String(selectedTrack.track_id);
            return (
              <button
                key={t.track_id}
                type="button"
                className={`track-chip${active ? ' track-chip-active' : ''}`}
                aria-pressed={active}
                style={{
                  '--track-color': CLASS_COLORS[t.vehicle_class_stable] || '#64748b',
                }}
                onClick={() => changeTrack(t.track_id)}
              >
                <span className="track-chip-id">#{t.track_id}</span>
                <span className="track-chip-class">{t.vehicle_class_stable}</span>
                <span className="track-chip-dur">{displayValue(t.duration_seconds)}s</span>
              </button>
            );
          })}
        </div>
      </div>

      {selectedTrack ? (
        <div className="track-detail" aria-live="polite">
          <div className="stat-row">
            <div className="stat-chip">
              <span className="stat-label">Track ID</span>
              <span className="stat-value">#{selectedTrack.track_id}</span>
            </div>
            <div className="stat-chip">
              <span className="stat-label">Class (stable)</span>
              <span className="stat-value">{displayValue(selectedTrack.vehicle_class_stable)}</span>
            </div>
            <div className="stat-chip">
              <span className="stat-label">Frames tracked</span>
              <span className="stat-value">{displayValue(selectedTrack.tracked_rows)}</span>
            </div>
            <div className="stat-chip">
              <span className="stat-label">First → last frame</span>
              <span className="stat-value">
                {displayValue(selectedTrack.first_frame)} → {displayValue(selectedTrack.last_frame)}
              </span>
            </div>
            <div className="stat-chip">
              <span className="stat-label">Duration</span>
              <span className="stat-value">{displayValue(selectedTrack.duration_seconds)} s</span>
            </div>
          </div>

          {trajectory && pathPoints.length >= 2 ? (
            <>
              <div className="track-path-wrap">
                <svg
                  className="track-path"
                  viewBox={`0 0 ${resolution.width} ${resolution.height}`}
                  role="img"
                  aria-label={`Centroid path for track #${selectedTrack.track_id} (${selectedTrack.vehicle_class_stable}) with frame progression`}
                >
                  <rect
                    width={resolution.width}
                    height={resolution.height}
                    className="track-path-bg"
                  />
                  <path d={pathD} className="track-path-line" fill="none" stroke={trackColor} strokeWidth="2" />
                  <circle
                    cx={pathPoints[0].centroid_x}
                    cy={pathPoints[0].centroid_y}
                    r="6"
                    className="track-path-start"
                  />
                  <circle
                    cx={pathPoints[pathPoints.length - 1].centroid_x}
                    cy={pathPoints[pathPoints.length - 1].centroid_y}
                    r="6"
                    className="track-path-end"
                  />
                  {pathPoint ? (
                    <circle
                      cx={pathPoint.centroid_x}
                      cy={pathPoint.centroid_y}
                      r="9"
                      className="track-path-scrub"
                    />
                  ) : null}
                  {pathPoints.map((p, i) =>
                    i % 24 === 0 ? (
                      <circle key={`${p.frame}-${i}`} cx={p.centroid_x} cy={p.centroid_y} r="1.6" className="track-path-dot">
                        <title>{`frame ${p.frame}: (${p.centroid_x.toFixed(0)}, ${p.centroid_y.toFixed(0)})`}</title>
                      </circle>
                    ) : null
                  )}
                </svg>
                <p className="map-caption">
                  Centroid path (sampled to ≤220 verbatim points; every point keeps
                  its true frame number). Green = first frame, red = last frame.
                </p>
              </div>

              <div className="track-scrubber">
                <label className="sr-only" htmlFor={`track-scrubber-${selectedTrack.track_id}`}>
                  Frame progression
                </label>
                <input
                  id={`track-scrubber-${selectedTrack.track_id}`}
                  type="range"
                  min="0"
                  max={pathPoints.length - 1}
                  value={Math.min(scrubIndex, pathPoints.length - 1)}
                  onChange={(e) => setScrubIndex(Number(e.target.value))}
                />
                <div className="track-scrub-info">
                  <StatusBadge status="RECORDED" note={`Frame ${pathPoint ? pathPoint.frame : '—'}`} />
                  <span className="section-sub">
                    {pathPoint
                      ? `centroid (${pathPoint.centroid_x.toFixed(1)}, ${pathPoint.centroid_y.toFixed(1)}) · frame ${pathPoint.frame}/${selectedTrack.last_frame}`
                      : 'Frame progression for the recorded path.'}
                    {trajectory.sampled ? ' · path downsampled for display' : ''}
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div className="panel-empty" aria-live="polite">
              <h4>No prepared trajectory for this track</h4>
              <p className="empty-state">
                Full centroid points are only prepared for the longest tracks
                per clip. Track #{selectedTrack.track_id} is outside that set,
                so no path or frame progression is drawn — its summary values
                above are still the verified Level 8A record.
              </p>
            </div>
          )}

          <p className="footnote-note">
            All values come from the prepared evidence copies (Level 8A track
            summaries + Level 7D trajectories). No detection or tracking was
            rerun, and the 108 documented duplicate (frame, track) rows are
            retained exactly as recorded.
          </p>
        </div>
      ) : (
        <div className="panel-empty" aria-live="polite">
          <h4>No tracked vehicles in this clip</h4>
          <p className="empty-state">The prepared summary has no tracks for "{video}".</p>
        </div>
      )}
    </section>
  );
}