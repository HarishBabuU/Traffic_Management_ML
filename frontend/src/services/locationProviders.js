/**
 * Phase 9F-4 Part 2 — location provider abstraction.
 *
 * Real, public, KEYLESS endpoints are used (documented interfaces only):
 *   - Geocoding : Photon (komoot) — https://photon.komoot.io/api/
 *   - Routing   : OSRM public demo server — https://router.project-osrm.org/route/v1/
 *   - Map tiles : OpenStreetMap standard tiles — https://tile.openstreetmap.org
 *
 * All network access lives in createLocationService() so that deterministic
 * tests can inject a mocked `fetch`. No API key is required or embedded.
 *
 * Honesty rules:
 *   - We never fabricate coordinates. If a provider fails, an error kind is
 *     produced and the UI shows an explicit UNAVAILABLE / error state.
 *   - Parsed route geometry is returned as-is (never replaced by a fake
 *     straight line).
 */

export const MAP_PROVIDERS = {
  map: 'OpenStreetMap',
  tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  geocoding: 'Photon (komoot public endpoint, no API key)',
  routing: 'OSRM public demo server (no API key)',
};

const PHOTON_BASE = 'https://photon.komoot.io/api/';
const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving/';

/**
 * Documented Photon geocoding URL (features in GeoJSON).
 */
export function geocodeTextUrl(text) {
  return `${PHOTON_BASE}?q=${encodeURIComponent(text)}&limit=3`;
}

/**
 * Documented OSRM driving URL with full GeoJSON geometry and (optional)
 * alternatives.
 */
export function routeUrl(origin, destination, { alternatives = true } = {}) {
  const from = `${origin.lon},${origin.lat}`;
  const to = `${destination.lon},${destination.lat}`;
  return `${OSRM_BASE}${from};${to}?overview=full&geometries=geojson&steps=false&alternatives=${
    alternatives ? 'true' : 'false'
  }`;
}

/**
 * Parses a Photon response into the first { name, lat, lon } candidate, or
 * null if nothing usable was returned. Pure — safe for tests.
 */
export function parseGeocodeResponse(json) {
  if (!json || !Array.isArray(json.features) || json.features.length === 0) return null;
  const feature = json.features[0];
  const coord = feature && feature.geometry && feature.geometry.coordinates;
  if (!Array.isArray(coord) || coord.length < 2) return null;
  const props = feature.properties || {};
  return {
    name: props.name ? String(props.name) : 'Resolved location',
    lat: Number(coord[1]),
    lon: Number(coord[0]),
  };
}

/**
 * Parses an OSRM response into real route objects:
 *   { id, name, distanceKm, durationMin, geometry: [{lat, lon}], source }
 * Returns [] for any response that is not a successful "Ok" route set. The
 * geometry is the provider's actual geometry — never faked.
 */
export function parseRoutesResponse(json) {
  if (
    !json ||
    json.code !== 'Ok' ||
    !Array.isArray(json.routes) ||
    json.routes.length === 0
  ) {
    return [];
  }
  return json.routes.map((route, index) => {
    const rawCoord = route.geometry && route.geometry.coordinates;
    const geometry = Array.isArray(rawCoord)
      ? rawCoord.map(([lon, lat]) => ({ lat: Number(lat), lon: Number(lon) }))
      : [];
    const summary =
      route.legs && route.legs[0] && route.legs[0].summary
        ? String(route.legs[0].summary)
        : `Real route ${index + 1}`;
    return {
      id: `real-route-${index + 1}`,
      name: summary,
      distanceKm: Number((Number(route.distance) / 1000).toFixed(1)),
      durationMin: Number((Number(route.duration) / 60).toFixed(0)),
      geometry,
      source: MAP_PROVIDERS.routing,
      providerRef: { provider: 'osrm', index },
    };
  });
}

/**
 * Maps an exception to a stable error kind used by the UI + tests:
 *   geocode-not-found | route-empty | geocode-http | route-http | network
 */
export function errorKindFor(error) {
  const code = error && error.code;
  if (
    code === 'geocode-not-found' ||
    code === 'route-empty' ||
    code === 'geocode-http' ||
    code === 'route-http'
  ) {
    return code;
  }
  return 'network';
}

/**
 * Factory for the real location service. `fetchImpl` is injectable so tests
 * can mock provider responses without touching any production data.
 */
export function createLocationService({
  fetchImpl = typeof fetch === 'function'
    ? fetch.bind(globalThis)
    : null,
} = {}) {
  async function getJson(url, httpErrorCode) {
    if (!fetchImpl) {
      throw Object.assign(new Error('network-unavailable'), { code: 'network' });
    }
    let response;
    try {
      response = await fetchImpl(url);
    } catch (err) {
      throw Object.assign(new Error('network-failure'), { code: 'network' });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`http-${response.status}`), { code: httpErrorCode });
    }
    return response.json();
  }

  async function geocode(text) {
    const normalized = String(text || '').trim();
    if (!normalized) {
      throw Object.assign(new Error('empty-location'), { code: 'geocode-not-found' });
    }
    const json = await getJson(geocodeTextUrl(normalized), 'geocode-http');
    const parsed = parseGeocodeResponse(json);
    if (!parsed) {
      throw Object.assign(new Error('not-found'), { code: 'geocode-not-found' });
    }
    return parsed;
  }

  async function route(origin, destination) {
    const json = await getJson(routeUrl(origin, destination), 'route-http');
    const routes = parseRoutesResponse(json);
    if (routes.length === 0) {
      throw Object.assign(new Error('no-route'), { code: 'route-empty' });
    }
    return routes;
  }

  /**
   * Full trip analysis: geocode origin → geocode destination → fetch real
   * routes. Throws typed errors that the caller maps to UI states.
   */
  async function analyzeTrip({ origin, destination }) {
    const originResolved = await geocode(origin);
    const destinationResolved = await geocode(destination);
    const routes = await route(originResolved, destinationResolved);
    return { originResolved, destinationResolved, routes };
  }

  return { geocode, route, analyzeTrip };
}