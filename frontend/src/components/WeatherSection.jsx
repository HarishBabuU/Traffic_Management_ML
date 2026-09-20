import Section from './Section';
import DataTable from './DataTable';
import StatusBadge from './StatusBadge';
import { getWeather } from '../services/dataService';
import { displayValue } from '../utils/formatting';

export default function WeatherSection() {
  const weather = getWeather();
  const row = weather.first;

  const columns = [
    { key: 'location_id', label: 'Location' },
    { key: 'temperature_c', label: 'Temperature (°C)' },
    { key: 'weather_condition', label: 'Condition' },
    { key: 'wind_speed_kmh', label: 'Wind (km/h)' },
    { key: 'visibility_km', label: 'Visibility (km)' },
    { key: 'humidity_pct', label: 'Humidity (%)' },
    { key: 'precipitation_mm', label: 'Precip. (mm)' },
    { key: 'weather_category', label: 'Category' },
    { key: 'weather_traffic_impact', label: 'Traffic Impact' },
    { key: 'source', label: 'Source' },
    { key: 'is_mock', label: 'Mock' },
  ];

  const location = row
    ? `${displayValue(row.location_id)} (${displayValue(row.latitude)}, ${displayValue(row.longitude)})`
    : null;

  return (
    <Section
      id="weather"
      title="Weather"
      subtitle="Weather-impact analysis (not attached to any real road or video)"
      status={weather.status}
    >
      {row ? (
        <>
          <div className="status-banner">
            <StatusBadge status={weather.status?.status} note={weather.status?.note} />
            <span className="section-sub">
              Point-in-time observation: {displayValue(row.timestamp)} at {location}.
            </span>
          </div>

          <div className="kv-grid">
            <div className="kv-item">
              <span className="kv-label">Weather condition</span>
              <span className="kv-value">{displayValue(row.weather_condition)}</span>
            </div>
            <div className="kv-item">
              <span className="kv-label">Temperature</span>
              <span className="kv-value">{displayValue(row.temperature_c)} °C</span>
            </div>
            <div className="kv-item">
              <span className="kv-label">Wind</span>
              <span className="kv-value">{displayValue(row.wind_speed_kmh)} km/h</span>
            </div>
            <div className="kv-item">
              <span className="kv-label">Visibility</span>
              <span className="kv-value">{displayValue(row.visibility_km)} km</span>
            </div>
            <div className="kv-item">
              <span className="kv-label">Humidity</span>
              <span className="kv-value">{displayValue(row.humidity_pct)} %</span>
            </div>
            <div className="kv-item">
              <span className="kv-label">Precipitation</span>
              <span className="kv-value">{displayValue(row.precipitation_mm)} mm</span>
            </div>
            <div className="kv-item">
              <span className="kv-label">Weather category</span>
              <span className="kv-value">{displayValue(row.weather_category)}</span>
            </div>
            <div className="kv-item">
              <span className="kv-label">Weather impact</span>
              <span className="kv-value">
                {displayValue(row.weather_traffic_impact)} (score {displayValue(row.impact_score)})
              </span>
            </div>
          </div>

          <p className="section-sub">
            Impact basis: {displayValue(row.impact_rule_basis)}. Observed via {displayValue(row.provider)}.
          </p>

          <DataTable columns={columns} rows={[row]} />
        </>
      ) : (
        <p className="empty-state">Location not configured — no weather data available.</p>
      )}
    </Section>
  );
}