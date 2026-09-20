import Section from './Section';
import StatusBadge from './StatusBadge';
import { getRoadScores } from '../services/dataService';

function isUnknown(value) {
  return value === undefined || value === null || String(value).toUpperCase() === 'UNKNOWN';
}

function isNumericScore(value) {
  if (isUnknown(value)) return false;
  return Number.isFinite(Number(value));
}

/**
 * A single traffic / weather / road contribution row.
 *
 * Only a real numeric score is drawn as a bar. Categorical values such as
 * LOW / MODERATE / HIGH (and UNKNOWN) are always shown as text — never
 * converted into a bar width or a valid score.
 */
function ScoreBar({ label, detail, score, weight }) {
  const unknown = isUnknown(score);
  const numeric = !unknown && isNumericScore(score);
  return (
    <div className="layer-bar-row">
      <span className="layer-label">
        {label}
        {detail ? <small className="layer-detail">{detail}</small> : null}
      </span>
      <div className="layer-bar-track">
        {unknown ? (
          <span className="layer-unknown">UNKNOWN</span>
        ) : numeric ? (
          <div
            className="layer-bar-fill"
            style={{ width: `${Math.max(Number(score), 2)}%` }}
          >
            <span className="layer-bar-value">{score}</span>
          </div>
        ) : (
          <span className="layer-unknown">{score}</span>
        )}
      </div>
      <span className="layer-weight">
        {numeric && Number(weight) > 0 ? `weight ${weight}%` : 'no weight'}
      </span>
    </div>
  );
}

export default function RoadScoreSection() {
  const data = getRoadScores();
  const rows = data.rows;

  return (
    <Section
      id="road-score"
      title="Road Suitability"
      subtitle="Explainable road scoring from Phase 9D. The UI only displays results — it never alters the scoring algorithm."
      status={data.status}
    >
      <div className="mock-warning">
        <StatusBadge status="MOCK" note="Prototype / Mock Data" />
        <p>
          These road scores are <strong>prototype</strong> explainable scores computed from
          fictional MOCK roads, and are not calibrated for real-world road engineering.
        </p>
      </div>

      <div className="stat-row">
        {data.top ? (
          <div className="stat-chip stat-chip-wide">
            <span className="stat-label">Best scored mock road</span>
            <span className="stat-value">
              {data.top.road_id} · {data.top.overall_score}/100 ({data.top.suitability_category})
            </span>
          </div>
        ) : (
          <p className="empty-state">No scored roads available.</p>
        )}
      </div>

      <div className="road-score-grid">
        {rows.map((r) => (
          <div key={r.road_id} className="road-score-card">
            <div className="road-score-head">
              <div>
                <span className="road-card-id">{r.road_id}</span>
                <span className="road-card-name">{r.road_name}</span>
              </div>
              <StatusBadge status="MOCK" note="Fictional" />
            </div>

            <div className="road-metrics">
              <div className="road-metric">
                <span className="stat-label">Score</span>
                <span className={isUnknown(r.overall_score) ? 'road-value-unknown' : 'road-value'}>
                  {r.overall_score}/100
                </span>
              </div>
              <div className="road-metric">
                <span className="stat-label">Category</span>
                <span>{r.suitability_category}</span>
              </div>
              <div className="road-metric">
                <span className="stat-label">Confidence</span>
                <span>{r.confidence}</span>
              </div>
              <div className="road-metric">
                <span className="stat-label">Data mode</span>
                <span>{r.data_mode}</span>
              </div>
            </div>

            <h4>Layer contributions</h4>
            <ScoreBar
              label="Traffic"
              detail={r.traffic_activity}
              score={r.traffic_score}
              weight={r.traffic_weight}
            />
            <ScoreBar
              label="Weather"
              detail={r.weather_impact}
              score={r.weather_score}
              weight={r.weather_weight}
            />
            <ScoreBar
              label="Road"
              detail={r.road_risk}
              score={r.road_score}
              weight={r.road_weight}
            />

            <h4>Why this score</h4>
            <p className="road-card-reason">{r.reason}</p>
          </div>
        ))}
      </div>

      <p className="footnote-note">
        UNKNOWN layers are never silently treated as good: they are excluded from the weighted
        average and lower the confidence. When every layer is UNKNOWN the overall score is
        UNKNOWN. Weight percentages shown are the values stored in the data.
      </p>
    </Section>
  );
}