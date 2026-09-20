import Section from './Section';
import StatusBadge from './StatusBadge';

const LEGEND = [
  { status: 'LIVE', meaning: 'Current external/provider data (weather, real route).' },
  { status: 'STATIC', meaning: 'Previously generated/local dataset or fixed analysis.' },
  { status: 'MOCK', meaning: 'Fictional demonstration data (roads, routes, scores).' },
  { status: 'RECORDED', meaning: 'Previously captured video; not live CCTV.' },
  { status: 'UNKNOWN', meaning: 'Data unavailable; not inferred.' },
];

/**
 * Phase 9F-4 Part 6 — data-label legend for the demo stand.
 */
export default function ProvenanceLegend() {
  return (
    <Section
      id="provenance-legend"
      title="Data Labels Legend"
      subtitle="Every value in this control centre is labelled with the truth about where it came from."
      status={{ status: 'STATIC', note: 'Legend' }}
    >
      <ul className="provenance-legend-list">
        {LEGEND.map((item) => (
          <li key={item.status} className="provenance-legend-row">
            <StatusBadge status={item.status} />
            <span className="section-sub">{item.meaning}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}