/**
 * Phase 9F-4 Part 3 — current-weather provider (Open-Meteo).
 *
 * Public, keyless endpoint:
 *   https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..
 *     &current=temperature_2m,relative_humidity_2m,weather_code,
 *              precipitation,wind_speed_10m,wind_direction_10m
 *     &timezone=auto
 *
 * All network access lives in createWeatherService() so tests can inject a
 * mocked fetch. No API key is required or embedded.
 *
 * The result is strictly LIVE current-weather data only when the provider
 * responds successfully. There is no silent fallback to the Phase 9B
 * historical evidence; if the request fails, the UI shows UNAVAILABLE.
 */

export const WEATHER_PROVIDER = {
  name: 'Open-Meteo (no API key)',
  map: 'OpenStreetMap',
  endpoint: 'https://api.open-meteo.com/v1/forecast',
  fields: [
    'temperature_2m',
    'relative_humidity_2m',
    'weather_code',
    'precipitation',
    'wind_speed_10m',
    'wind_direction_10m',
  ],
};

const WMO_DESCRIPTIONS = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Freezing drizzle (light)',
  57: 'Freezing drizzle (dense)',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Freezing rain (light)',
  67: 'Freezing rain (heavy)',
  71: 'Slight snowfall',
  73: 'Moderate snowfall',
  75: 'Heavy snowfall',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm (slight/moderate)',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

/**
 * Pure — maps a WMO weather code to a human-readable description.
 */
export function weatherCodeDescription(code) {
  const n = Number(code);
  if (Number.isNaN(n)) return 'Unknown';
  return WMO_DESCRIPTIONS[n] || `Weather code ${n}`;
}

/**
 * Pure — converts a wind direction in degrees to a cardinal label (N, NE, E, …).
 */
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function windDirectionLabel(deg) {
  if (deg === null || deg === undefined || !Number.isFinite(Number(deg))) return null;
  const n = Number(deg);
  const idx = Math.round(((n % 360) + 360) % 360 / 45) % 8;
  return COMPASS[idx];
}

/**
 * Pure — validates latitude / longitude. Both must be finite numbers within
 * valid ranges. Returns true if valid.
 */
export function isValidCoordinate(lat, lon) {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/**
 * Pure — builds the documented Open-Meteo URL for a given coordinate.
 */
export function weatherUrl(lat, lon) {
  const fields = WEATHER_PROVIDER.fields.join(',');
  return `${WEATHER_PROVIDER.endpoint}?latitude=${lat}&longitude=${lon}&current=${fields}&timezone=auto`;
}

/**
 * Pure — parses a successful Open-Meteo response into a small frontend-
 * friendly object. Returns null if the response shape is unusable.
 */
export function parseWeatherResponse(json) {
  if (!json) return null;
  const current = json.current;
  if (!current) return null;
  const temperatureC =
    current.temperature_2m !== undefined && current.temperature_2m !== null
      ? Number(current.temperature_2m)
      : null;
  const weatherCode =
    current.weather_code !== undefined && current.weather_code !== null
      ? Number(current.weather_code)
      : null;
  const precipitationMm =
    current.precipitation !== undefined && current.precipitation !== null
      ? Number(current.precipitation)
      : null;
  const windSpeedKmh =
    current.wind_speed_10m !== undefined && current.wind_speed_10m !== null
      ? Number(current.wind_speed_10m)
      : null;
  const windDirectionDeg =
    current.wind_direction_10m !== undefined && current.wind_direction_10m !== null
      ? Number(current.wind_direction_10m)
      : null;
  const humidityPct =
    current.relative_humidity_2m !== undefined && current.relative_humidity_2m !== null
      ? Number(current.relative_humidity_2m)
      : null;
  const asOf = current.time || null;

  if (temperatureC === null && weatherCode === null) return null;

  return {
    temperatureC,
    weatherCode,
    description: weatherCode !== null ? weatherCodeDescription(weatherCode) : 'Unknown',
    precipitationMm,
    windSpeedKmh,
    windDirectionDeg,
    humidityPct,
    asOf,
    latitude: json.latitude !== undefined ? Number(json.latitude) : null,
    longitude: json.longitude !== undefined ? Number(json.longitude) : null,
  };
}

/**
 * Maps an error kind to a deterministic UI status. Never falls back to
 * historical Phase 9B data.
 */
export function weatherUiState(kind) {
  if (kind === 'ready') {
    return { status: 'LIVE', note: 'Live provider data (retrieved on demand)' };
  }
  if (kind === null || kind === undefined) {
    return { status: 'IDLE', note: 'No destination resolved yet' };
  }
  return {
    status: 'UNAVAILABLE',
    note:
      kind === 'invalid-coordinates'
        ? 'Missing or invalid coordinates'
        : 'Weather provider unavailable',
  };
}

export function weatherErrorKindFor(error) {
  const code = error && error.code;
  if (code === 'invalid-coordinates' || code === 'http' || code === 'no-data') {
    return code;
  }
  return 'network';
}

/**
 * Factory for the weather service. `fetchImpl` is injectable so tests can
 * mock provider responses without touching any production data.
 */
export function createWeatherService({
  fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
} = {}) {
  async function getCurrentWeather({ lat, lon }) {
    if (!isValidCoordinate(lat, lon)) {
      throw Object.assign(new Error('invalid-coordinates'), { code: 'invalid-coordinates' });
    }
    if (!fetchImpl) {
      throw Object.assign(new Error('network-unavailable'), { code: 'network' });
    }
    const url = weatherUrl(lat, lon);
    let response;
    try {
      response = await fetchImpl(url);
    } catch {
      throw Object.assign(new Error('network-failure'), { code: 'network' });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`http-${response.status}`), { code: 'http' });
    }
    const json = await response.json();
    const parsed = parseWeatherResponse(json);
    if (!parsed) {
      throw Object.assign(new Error('no-data'), { code: 'no-data' });
    }
    return {
      ...parsed,
      provider: WEATHER_PROVIDER.name,
      tileMap: WEATHER_PROVIDER.map,
    };
  }

  return { getCurrentWeather };
}