import Section from './Section';
import StatusBadge from './StatusBadge';
import { weatherUiState } from '../services/weatherProvider';
import { displayValue } from '../utils/formatting';

/**
 * Command Centre — trip-context weather.
 *
 * Live Open-Meteo snapshot for the resolved destination coordinates, shown as a
 * compact context strip. States: idle → nothing resolved; loading → fetching;
 * live → provider data retrieved on demand; unavailable → explicit error,
 * never a fabricated fallback.
 */
export default function CurrentWeatherSection({ weather, coords, destinationName }) {
  const status = weatherUiState(weather.kind);
  const loading = weather.status === 'loading';
  const ready = weather.status === 'ready';
  const data = weather.data || null;

  return (
    <Section
      id="live-weather"
      title="Trip Weather Context"
      subtitle={`Current weather at the resolved destination — fetched live from ${weather.provider || 'Open-Meteo'} when the trip is analysed. Real provider data when available, never fabricated, never replaced by a historical fallback.`}
      status={status}
    >
      <div className="status-banner">
        <StatusBadge status={status.status} note={status.note} />
        <span className="section-sub">
          {status.status === 'LIVE'
            ? `Retrieved from ${weather.provider || 'Open-Meteo'} for the current destination.`
            : 'No live weather displayed when the provider request fails or coordinates are missing.'}
        </span>
      </div>

      {weather.status === 'idle' ? (
        <div className="panel-empty" aria-live="polite">
          <h3>No destination resolved</h3>
          <p className="empty-state">
            Resolve a destination in the journey box above to see the current
            weather at that location.
          </p>
        </div>
      ) : loading ? (
        <div className="panel-empty" aria-live="polite">
          <h3>Fetching current weather…</h3>
          <p className="status-line">Requesting Open-Meteo current-weather snapshot…</p>
        </div>
      ) : !ready || !data ? (
        <div className="panel-empty" role="alert" aria-live="polite">
          <StatusBadge status="UNAVAILABLE" note={status.note} />
          <p className="status-line">
            {weather.kind === 'invalid-coordinates'
              ? 'Destination coordinates are missing or invalid. No weather was requested.'
              : 'Weather provider unavailable. No current weather was displayed and no historical weather was substituted.'}
          </p>
        </div>
      ) : (
        <div className="current-weather-wrap" aria-live="polite">
          <div className="current-weather-main">
            <span className="current-weather-temp">
              {data.temperatureC !== null ? `${data.temperatureC} °C` : '—'}
            </span>
            <div className="current-weather-desc">
              <span className="stat-label">Condition</span>
              <span className="current-weather-cond">{displayValue(data.description)}</span>
              {coords ? (
                <small className="section-sub">
                  {data.latitude !== null && data.longitude !== null
                    ? `${data.latitude.toFixed(4)}, ${data.longitude.toFixed(4)}`
                    : ''}
                </small>
              ) : null}
            </div>
          </div>
          <div className="kv-grid">
            <div className="kv-item">
              <span className="kv-label">Precipitation</span>
              <span className="kv-value">
                {data.precipitationMm !== null
                  ? data.precipitationMm === 0
                    ? 'None (0.0 mm)'
                    : `${data.precipitationMm} mm`
                  : '—'}
              </span>
            </div>
            <div className="kv-item">
              <span className="kv-label">Wind</span>
              <span className="kv-value">
                {data.windSpeedKmh !== null ? `${data.windSpeedKmh} km/h` : '—'}
                {data.windDirectionDeg !== null ? ` (${data.windDirectionDeg}°)` : ''}
              </span>
            </div>
            <div className="kv-item">
              <span className="kv-label">Humidity</span>
              <span className="kv-value">
                {data.humidityPct !== null ? `${data.humidityPct} %` : '—'}
              </span>
            </div>
          </div>
          <div className="current-weather-note">
            <StatusBadge status="LIVE" note="Open-Meteo current-weather snapshot" />
            <span className="section-sub">
              {data.asOf ? `Observation time: ${data.asOf}` : null}
              {destinationName ? ` · destination: ${destinationName}` : null}
            </span>
          </div>
        </div>
      )}

      <p className="section-sub" style={{ marginTop: 10 }}>
        Historical / evidence weather data remains in the separate{' '}
        <strong>Evidence</strong> view. The two weather layers are
        deliberately kept apart: this section is live provider data; that
        section is historical evidence from the prepared Phase 9B outputs.
      </p>
    </Section>
  );
}