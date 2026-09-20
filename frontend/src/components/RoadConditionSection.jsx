import Section from './Section';
import DataTable from './DataTable';
import StatusBadge from './StatusBadge';
import { getRoadConditions } from '../services/dataService';
import { displayValue } from '../utils/formatting';

export default function RoadConditionSection() {
  const data = getRoadConditions();
  const rows = data.rows;

  const columns = [
    { key: 'road_id', label: 'Road ID' },
    { key: 'road_name', label: 'Road' },
    { key: 'road_surface', label: 'Surface' },
    { key: 'construction_status', label: 'Construction' },
    { key: 'closure_status', label: 'Closure' },
    { key: 'flooding_status', label: 'Flooding' },
    { key: 'incident_status', label: 'Incident' },
    { key: 'overall_road_condition', label: 'Overall' },
    { key: 'road_risk', label: 'Risk' },
    { key: 'confidence', label: 'Confidence' },
  ];

  return (
    <Section
      id="road-condition"
      title="Road Condition"
      subtitle="Road-condition layer (Phase 9C). Values shown as-is, including UNKNOWN."
      status={data.status}
    >
      <div className="mock-warning">
        <StatusBadge status="MOCK" note="Prototype / Mock Data" />
        <p>
          These are fictional test roads (TEST-RD-*). They are NOT real roads and are NOT
          inferred from traffic videos.
        </p>
      </div>

      <div className="road-condition-grid">
        {rows.map((r) => (
          <div key={r.road_id} className="road-condition-card">
            <div className="road-card-head">
              <div>
                <span className="road-card-id">{r.road_id}</span>
                <span className="road-card-name">{displayValue(r.road_name)}</span>
              </div>
              <StatusBadge status="MOCK" note="Fictional" />
            </div>

            <div className="kv-grid kv-grid-small">
              <div className="kv-item">
                <span className="kv-label">Surface</span>
                <span className="kv-value">{displayValue(r.road_surface)}</span>
              </div>
              <div className="kv-item">
                <span className="kv-label">Construction</span>
                <span className="kv-value">{displayValue(r.construction_status)}</span>
              </div>
              <div className="kv-item">
                <span className="kv-label">Closure</span>
                <span className="kv-value">{displayValue(r.closure_status)}</span>
              </div>
              <div className="kv-item">
                <span className="kv-label">Flooding</span>
                <span className="kv-value">{displayValue(r.flooding_status)}</span>
              </div>
              <div className="kv-item">
                <span className="kv-label">Incident</span>
                <span className="kv-value">{displayValue(r.incident_status)}</span>
              </div>
              <div className="kv-item">
                <span className="kv-label">Overall</span>
                <span className="kv-value">{displayValue(r.overall_road_condition)}</span>
              </div>
              <div className="kv-item">
                <span className="kv-label">Risk</span>
                <span className="kv-value">{displayValue(r.road_risk)}</span>
              </div>
              <div className="kv-item">
                <span className="kv-label">Confidence</span>
                <span className="kv-value">{displayValue(r.confidence)}</span>
              </div>
            </div>

            <p className="road-card-reason">{displayValue(r.reason)}</p>
          </div>
        ))}
      </div>

      <DataTable columns={columns} rows={rows} emptyMessage="No road condition data available." />
    </Section>
  );
}