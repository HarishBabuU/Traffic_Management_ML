import StatusBadge from './StatusBadge';
import {
  getTraffic,
  getWeather,
  getRoadConditions,
  getRoadScores,
  getRoutes,
  getLevel8,
} from '../services/dataService';

export default function DataFooter() {
  const sources = [
    { name: 'Level 8 statistics', source: getLevel8(), status: 'STATIC' },
    { name: 'Phase 9A traffic conditions', source: getTraffic(), status: 'STATIC' },
    { name: 'Phase 9B weather', source: getWeather(), status: getWeather().status.status },
    { name: 'Phase 9C road conditions', source: getRoadConditions(), status: 'MOCK' },
    { name: 'Phase 9D road scores', source: getRoadScores(), status: 'MOCK' },
    { name: 'Phase 9E routes', source: getRoutes(), status: 'MOCK' },
  ];

  return (
    <footer className="app-footer section" id="data-status">
      <header className="section-head">
        <div>
          <h2>Data / Status</h2>
          <p className="section-sub">Prototype system — underlying data source information</p>
        </div>
        <StatusBadge status="PROTOTYPE" note="Not a production system" />
      </header>
      <div className="status-legend" aria-label="Status legend">
        <span className="legend-title">Status legend:</span>
        <StatusBadge status="LIVE" note="Point-in-time observation" />
        <StatusBadge status="MOCK" note="Mock/test data — not real" />
        <StatusBadge status="STATIC" note="Processed analysis" />
        <StatusBadge status="MANUAL" note="Manually entered" />
        <StatusBadge status="UNKNOWN" note="No data available" />
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <caption className="sr-only">Data sources and their data status</caption>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Files</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((item) => (
              <tr key={item.name}>
                <td>{item.name}</td>
                <td>
                  {Array.isArray(item.source.source)
                    ? item.source.source.join(', ')
                    : item.source.source}
                </td>
                <td>
                  <StatusBadge
                    status={item.status}
                    note={(item.source.status && item.source.status.note) || ''}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="footer-note">
        MOCK data is displayed as MOCK. No live traffic, live weather or real road data is
        fabricated. This dashboard is a prototype, not a calibrated traffic-engineering or
        navigation product.
      </p>
    </footer>
  );
}