import Section from './Section';
import StatusBadge from './StatusBadge';

const STAGES = (weatherReady, routeReady) => [
  { label: 'CCTV / Video', status: 'RECORDED', note: 'Pre-recorded demo footage, not live' },
  { label: 'YOLOv8n Detection', status: 'COMPLETED', note: 'Phase 9A model (unchanged)' },
  { label: 'ByteTrack Tracking', status: 'COMPLETED', note: 'Level 7 (unchanged)' },
  { label: 'Fragment Correction', status: 'COMPLETED', note: 'Level 8 (unchanged)' },
  { label: 'Traffic Intelligence', status: 'STATIC', note: 'STATIC dataset analysis' },
  {
    label: 'Weather Intelligence',
    status: weatherReady ? 'LIVE' : 'UNKNOWN',
    note: weatherReady ? 'Current provider data' : 'Provider data unavailable now',
  },
  { label: 'Road Intelligence', status: 'MOCK', note: 'STATIC / MOCK records' },
  {
    label: 'Route Analysis',
    status: routeReady ? 'LIVE' : 'UNKNOWN',
    note: routeReady ? 'Real Photon + OSRM provider data' : 'No real route generated yet',
  },
  { label: 'AI Assistant', status: 'LOCAL', note: 'Local deterministic parser' },
  { label: 'Voice Interface', status: 'BROWSER', note: 'Browser-native, no API' },
];

/**
 * Phase 9F-4 Part 6 — AI / system pipeline visibility.
 *
 * Truthful statuses only: the underlying ML pipeline is completed/static; only
 * weather and the real route are LIVE/provider-backed when they really are.
 */
export default function SystemPipelineSection({ weatherReady, routeReady }) {
  const stages = STAGES(weatherReady, routeReady);
  return (
    <Section
      id="pipeline"
      title="AI Pipeline"
      subtitle="How the control centre is assembled. Statuses are truthful — the finished detection/tracking stages are completed/static, and only live provider results are labelled LIVE."
      status={{ status: 'STATIC', note: 'Assembly view' }}
    >
      <ol className="pipeline-list" aria-label="System pipeline stages">
        {stages.map((stage, index) => (
          <li key={stage.label} className="pipeline-stage">
            {index > 0 ? <span className="pipeline-arrow" aria-hidden="true">↓</span> : null}
            <div className="pipeline-stage-row">
              <span className="pipeline-stage-label">{stage.label}</span>
              <StatusBadge status={stage.status} note={stage.note} />
            </div>
          </li>
        ))}
      </ol>
      <p className="footnote-note">
        The whole pipeline is intentionally NOT labelled "LIVE AI". Detection,
        tracking and fragment correction are completed analyses over a recorded
        dataset; weather and routing are live only when a provider request
        actually succeeded.
      </p>
    </Section>
  );
}