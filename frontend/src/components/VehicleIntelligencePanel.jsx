import { getLevel8, getTraffic } from '../services/dataService';
import { videoIntelligence } from '../services/controlCenter';
import { displayValue } from '../utils/formatting';
import { BarChart } from './Charts';

const CLASS_KEYS = ['car', 'motorcycle', 'bus', 'truck', 'bicycle'];

const EVIDENCE_IMAGES = [
  {
    src: 'level8/traffic_activity_over_time.png',
    alt: 'Traffic activity over time per video',
    caption: 'Traffic activity over time (Phase 8 evidence)',
  },
  {
    src: 'level8/vehicle_count_by_class.png',
    alt: 'Vehicle count by class',
    caption: 'Vehicle count by class (Phase 8 evidence)',
  },
  {
    src: 'level8/conservative_vs_corrected.png',
    alt: 'Conservative vs corrected counts',
    caption: 'Conservative vs corrected counts (Phase 8 evidence)',
  },
];

/**
 * Vehicle intelligence for the opened demo CCTV resource. Every figure is read
 * from the existing prepared data (Level 8 / Phase 9A) for the resource's
 * recorded clip — nothing is recomputed or hardcoded here.
 */
export default function VehicleIntelligencePanel({ resource, route }) {
  const level8 = getLevel8();
  const traffic = getTraffic();
  const { byVideo, overview } = videoIntelligence(
    resource.video,
    level8.classByVideo,
    traffic.overview
  );

  const classItems = CLASS_KEYS.map((key) => ({
    label: key,
    value: byVideo && byVideo[key] ? byVideo[key] : 'UNKNOWN',
  }));

  return (
    <section className="panel intelligence-panel" id="intelligence" aria-label="Vehicle Intelligence">
      <header className="section-head">
        <div>
          <h3>Vehicle Intelligence</h3>
          <p className="section-sub">
            Existing processed intelligence for the recorded clip "{resource.video}"
            (Level 8 + Phase 9A). AI-assisted, historical — not live detection.
          </p>
        </div>
      </header>

      <div className="stat-row">
        <div className="stat-chip">
          <span className="stat-label">Corrected vehicles (all videos)</span>
          <span className="stat-value">{displayValue(level8.metrics.total_corrected_identities)}</span>
        </div>
        <div className="stat-chip">
          <span className="stat-label">Conservative count</span>
          <span className="stat-value">{displayValue(level8.metrics.total_conservative_identities)}</span>
        </div>
        <div className="stat-chip">
          <span className="stat-label">Videos analysed</span>
          <span className="stat-value">{displayValue(level8.metrics.number_of_videos)}</span>
        </div>
        <div className="stat-chip">
          <span className="stat-label">Trajectory rows</span>
          <span className="stat-value">{displayValue(level8.metrics.total_trajectory_rows)}</span>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat-chip">
          <span className="stat-label">This clip — recorded footage</span>
          <span className="stat-value">{displayValue(resource.video)}</span>
        </div>
        <div className="stat-chip">
          <span className="stat-label">Vehicles in this clip</span>
          <span className="stat-value">{displayValue(byVideo ? byVideo.total : 'UNKNOWN')}</span>
        </div>
        <div className="stat-chip">
          <span className="stat-label">Dataset-relative activity</span>
          <span className="stat-value">
            {displayValue(overview ? overview.traffic_condition : 'UNKNOWN')}
          </span>
        </div>
        <div className="stat-chip">
          <span className="stat-label">Activity rate (ids/s)</span>
          <span className="stat-value">
            {displayValue(overview ? overview.activity_rate_ids_per_sec : 'UNKNOWN')}
          </span>
        </div>
      </div>

      <h4>Vehicle classes in this clip (from prepared Level 8 data)</h4>
      <div className="chart-panel">
        <BarChart title="Vehicle classes in clip" items={classItems} />
      </div>

      <h4>Evidence — Phase 8 visualisations (unchanged copies)</h4>
      <div className="viz-grid">
        {EVIDENCE_IMAGES.map((img) => (
          <figure key={img.src}>
            <img src={img.src} alt={img.alt} loading="lazy" />
            <figcaption>{img.caption}</figcaption>
          </figure>
        ))}
      </div>

      <p className="footnote-note">
        All figures are read from the existing prepared JSON data
        (dataService → Level 8 / Phase 9A). No value is hardcoded and no new ML
        result was generated for this panel.
      </p>
    </section>
  );
}