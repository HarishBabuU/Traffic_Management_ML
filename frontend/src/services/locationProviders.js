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
 *   - Photon returns candidates ranked by ITS OWN text index, which regularly
 *     puts a different city first ("Vellore Institute of Technology" for a
 *     "Chennai Institute of Technology" search). The first feature is therefore
 *     never trusted: every candidate is scored against the query and only a
 *     confident winner is selected (see rankGeocodeCandidates /
 *     resolveGeocodeQuery). Low-confidence queries surface the candidate list
 *     to the user instead of picking for them.
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
 * How many Photon candidates are requested. Ranking needs more than one hit:
 * Photon ranks by its own text index, so the top hit is frequently a
 * *different* place that merely shares words with the query (e.g. "Vellore
 * Institute of Technology" for a "Chennai Institute of Technology" search).
 */
export const PHOTON_CANDIDATE_LIMIT = 8;

/**
 * Documented Photon geocoding URL (features in GeoJSON).
 */
export function geocodeTextUrl(text, { limit = PHOTON_CANDIDATE_LIMIT } = {}) {
  return `${PHOTON_BASE}?q=${encodeURIComponent(text)}&limit=${limit}`;
}

/**
 * Documented OSRM driving URL with full GeoJSON geometry and (optional)
 * alternatives.
 *
 * `alternatives=true` is always requested so the provider can return every
 * viable path in `routes[]`. It is a REQUEST, not a guarantee: OSRM returns a
 * single route when no meaningfully different alternative exists (typically for
 * short trips), and that single route is shown as-is — never padded out.
 */
export function routeUrl(origin, destination, { alternatives = true } = {}) {
  const from = `${origin.lon},${origin.lat}`;
  const to = `${destination.lon},${destination.lat}`;
  return `${OSRM_BASE}${from};${to}?overview=full&geometries=geojson&steps=false&alternatives=${
    alternatives ? 'true' : 'false'
  }`;
}

/**
 * Photon `properties` fields that describe *where* a hit is. Used for locality
 * matching, in specificity order (most specific first).
 */
const PHOTON_PLACE_FIELDS = ['city', 'district', 'county', 'state', 'country', 'street', 'postcode'];

/**
 * Query words that describe the *kind* of place rather than its identity.
 */
const GENERIC_QUERY_WORDS = new Set([
  'the', 'of', 'and', 'at', 'in', 'near', 'to', 'for', 'a', 'an', 'from',
  'by', 'on', 'my', 'me', 'i', 'we', 'us', 'is', 'are', 'visit', 'visiting',
  'go', 'going', 'please', 'city', 'town', 'village', 'area', 'region',
]);

/**
 * Words that mark an institution / landmark query, so a highway or waterway
 * hit is never presented as the searched institution.
 */
const INSTITUTION_WORDS = new Set([
  'institute', 'institution', 'university', 'college', 'school', 'academy',
  'polytechnic', 'campus', 'hospital', 'temple', 'church', 'mosque', 'stadium',
  'museum', 'library', 'mall', 'market', 'airport', 'railway', 'station',
]);

/**
 * Photon `type` / `osm_value` values that can never be an institution or a
 * place name the user searched for.
 */
const NON_PLACE_TYPES = new Set([
  'highway', 'waterway', 'railway', 'aeroway', 'boundary', 'natural', 'water',
  'street', 'address', 'place', 'county', 'state', 'city', 'island', 'wood',
  'protected_area', 'peak', 'valley',
]);

/** Minimum score for a candidate to be selected without asking the user. */
export const GEOCODE_MIN_SCORE = 1.2;

/** Minimum gap between the best and the runner-up for an automatic pick. */
export const GEOCODE_MIN_MARGIN = 0.8;

/** Score that maps to full confidence. */
const GEOCODE_SCORE_TARGET = 4.5;

/** Weights of the individual ranking signals. */
const W_NAME_COVERAGE = 3;
const W_PLACE_COVERAGE = 1.5;
const W_MISSING_TOKENS = 2;
const W_INSTITUTION_BONUS = 1.2;
const W_TYPE_MISMATCH = 1.5;
const W_EXACT_NAME = 1;
const W_SUBSEQUENCE = 0.75;
const W_PLACE_ANCHOR = 0.5;

/**
 * Lower-cases, strips diacritics and punctuation so "Velankanni" and
 * "Velankanni." compare equal.
 */
export function normalizePlaceText(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Meaningful words of a query or of a Photon field.
 */
export function tokenizePlaceText(value) {
  return normalizePlaceText(value)
    .split(' ')
    .filter((token) => token.length > 1 && !GENERIC_QUERY_WORDS.has(token));
}

function tokenSet(value) {
  return new Set(tokenizePlaceText(value));
}

/**
 * Every Photon feature as a candidate that keeps ALL of the provider fields, so
 * ranking can read locality information instead of only the display name.
 * Features without usable coordinates are dropped. Pure — safe for tests.
 */
export function parseGeocodeCandidates(json) {
  if (!json || !Array.isArray(json.features)) return [];
  const candidates = [];
  for (const feature of json.features) {
    const coord = feature && feature.geometry && feature.geometry.coordinates;
    if (!Array.isArray(coord) || coord.length < 2) continue;
    const lat = Number(coord[1]);
    const lon = Number(coord[0]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const props = feature.properties || {};
    const name = props.name ? String(props.name) : 'Resolved location';
    const placeParts = PHOTON_PLACE_FIELDS.map((field) =>
      props[field] ? String(props[field]) : ''
    ).filter(Boolean);
    const type = props.type ? String(props.type) : '';
    const osmValue = props.osm_value ? String(props.osm_value) : '';
    candidates.push({
      name,
      lat,
      lon,
      street: props.street ? String(props.street) : '',
      housenumber: props.housenumber ? String(props.housenumber) : '',
      district: props.district ? String(props.district) : '',
      city: props.city ? String(props.city) : '',
      county: props.county ? String(props.county) : '',
      state: props.state ? String(props.state) : '',
      postcode: props.postcode ? String(props.postcode) : '',
      country: props.country ? String(props.country) : '',
      countryCode: props.countrycode ? String(props.countrycode) : '',
      type,
      osmValue,
      osmId: props.osm_id != null ? String(props.osm_id) : '',
      osmKey: props.osm_key ? String(props.osm_key) : '',
      region: placeParts.join(', '),
    });
  }
  return candidates;
}

/**
 * Turns a candidate into the public place shape consumed by the map, the
 * router and the weather layer: { name, lat, lon }.
 */
export function toResolvedPlace(candidate) {
  if (!candidate) return null;
  return { name: candidate.name, lat: candidate.lat, lon: candidate.lon };
}

/**
 * Parses a Photon response into the first { name, lat, lon } candidate, or
 * null if nothing usable was returned. Pure — safe for tests.
 *
 * NOTE: this is the raw "first Photon hit" reader and is kept only for
 * backwards compatibility. New code must go through resolveGeocodeQuery(),
 * which ranks and validates the candidates before selecting one.
 */
export function parseGeocodeResponse(json) {
  return toResolvedPlace(parseGeocodeCandidates(json)[0]);
}

/**
 * Scores one candidate against the query tokens.
 *
 * Signals (all derived from the Photon payload — nothing is hardcoded per
 * query):
 *   name coverage    how much of the query the candidate's name explains
 *   place coverage   how much of the query its city/district/state/... explain
 *   missing tokens   query words the candidate explains nowhere (penalty)
 *   institution      searched institution kind also present in the candidate
 *   type mismatch    a highway/waterway hit for an institution query (penalty)
 *   name shape       exact / contiguous-subsequence name matches (bonus)
 *   place anchor     the searched locality found in the locality fields
 */
export function scoreGeocodeCandidate(query, candidate) {
  const queryTokens = tokenizePlaceText(query);
  if (!candidate || queryTokens.length === 0) return 0;

  const nameTokens = tokenizePlaceText(candidate.name);
  const nameSet = new Set(nameTokens);
  const placeSet = new Set();
  for (const field of PHOTON_PLACE_FIELDS) {
    for (const token of tokenizePlaceText(candidate[field])) placeSet.add(token);
  }

  const nameHits = queryTokens.filter((token) => nameSet.has(token));
  const placeHits = queryTokens.filter((token) => placeSet.has(token));
  const explained = new Set([...nameHits, ...placeHits]);
  const missing = queryTokens.filter((token) => !explained.has(token));

  let score = 0;
  score += W_NAME_COVERAGE * (nameHits.length / queryTokens.length);
  score += W_PLACE_COVERAGE * (placeHits.length / queryTokens.length);
  score -= W_MISSING_TOKENS * (missing.length / queryTokens.length);

  // Kind of place: "… Institute …" must not resolve to a road or a river.
  const wantsInstitution = queryTokens.some((token) => INSTITUTION_WORDS.has(token));
  const candidateIsInstitution = nameTokens.some((token) => INSTITUTION_WORDS.has(token));
  const candidateType = normalizePlaceText(candidate.type || candidate.osmValue).replace(/\s+/g, '');
  if (wantsInstitution && candidateIsInstitution) score += W_INSTITUTION_BONUS;
  if (wantsInstitution && candidateIsInstitution === false && NON_PLACE_TYPES.has(candidateType)) {
    score -= W_TYPE_MISMATCH;
  }

  // Shape of the name: identical or contained verbatim is stronger evidence
  // than a scattered bag of matching words.
  const queryNorm = normalizePlaceText(query);
  const nameNorm = normalizePlaceText(candidate.name);
  if (queryNorm && nameNorm && queryNorm === nameNorm) score += W_EXACT_NAME;
  else if (nameNorm && queryNorm && nameNorm.replace(/\s/g, '').includes(queryNorm.replace(/\s/g, ''))) {
    score += W_SUBSEQUENCE;
  }

  // The searched locality really is this candidate's locality.
  if (placeHits.length > 0) score += W_PLACE_ANCHOR;

  return Number(score.toFixed(4));
}

/**
 * Scores and orders every candidate, best first. Ties keep Photon's order so a
 * perfect tie is reported as ambiguous rather than silently resolved.
 */
export function rankGeocodeCandidates(query, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  return list
    .map((candidate, index) => ({
      ...candidate,
      score: scoreGeocodeCandidate(query, candidate),
      providerRank: index,
    }))
    .sort((a, b) => (b.score - a.score) || (a.providerRank - b.providerRank));
}

/**
 * Picks a place for a query from a full Photon response, or reports that the
 * answer is not trustworthy.
 *
 * Returns:
 *   { status: 'not-found',  candidates: [], place: null, reason }
 *   { status: 'ok',         candidates: ranked, place, reason }
 *   { status: 'ambiguous',  candidates: ranked, place: null, reason }
 *
 * `ambiguous` means the best candidate is either too weak overall or too
 * close to the runner-up — the caller must offer the list to the user rather
 * than pick for them.
 */
export function resolveGeocodeQuery(query, json) {
  const ranked = rankGeocodeCandidates(query, parseGeocodeCandidates(json));
  if (ranked.length === 0) {
    return { status: 'not-found', candidates: [], place: null, reason: 'no-usable-candidate' };
  }
  const [best, runnerUp] = ranked;
  // A query with no comparable content words ("A", "12") cannot be validated,
  // but with a single matching place there is also no alternative to confuse it
  // with, so it is accepted rather than blocking the user for nothing.
  if (ranked.length === 1 && tokenizePlaceText(query).length === 0) {
    return { status: 'ok', candidates: ranked, place: toResolvedPlace(best), reason: 'single-unvalidatable-candidate' };
  }
  if (best.score < GEOCODE_MIN_SCORE) {
    return { status: 'ambiguous', candidates: ranked, place: null, reason: 'weak-match' };
  }
  if (
    runnerUp &&
    runnerUp.score >= GEOCODE_MIN_SCORE &&
    best.score - runnerUp.score < GEOCODE_MIN_MARGIN
  ) {
    return { status: 'ambiguous', candidates: ranked, place: null, reason: 'close-call' };
  }
  return { status: 'ok', candidates: ranked, place: toResolvedPlace(best), reason: 'confident' };
}

/**
 * 0…1 confidence of an automatic pick, from the winning score.
 */
export function geocodeConfidence(candidates) {
  const ranked = Array.isArray(candidates) ? candidates : [];
  if (ranked.length === 0) return 0;
  const score = Number(ranked[0].score);
  if (!Number.isFinite(score) || score <= 0) return 0;
  return Number(Math.min(1, score / GEOCODE_SCORE_TARGET).toFixed(3));
}

/**
 * Parses an OSRM response into real route objects:
 *   { id, name, distanceKm, durationMin, geometry: [{lat, lon}], source }
 *
 * EVERY entry in the provider's `routes[]` is returned, in provider order, with
 * its own geometry, distance, duration and index — the array is never sliced,
 * truncated, deduplicated or replaced by a single "best" route. The caller
 * decides what to highlight; this layer only reports what the provider gave.
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
    const weight = Number(route.weight);
    return {
      id: `real-route-${index + 1}`,
      name: summary,
      distanceKm: Number((Number(route.distance) / 1000).toFixed(1)),
      durationMin: Number((Number(route.duration) / 60).toFixed(0)),
      geometry,
      // Remaining provider metadata, kept so nothing from the response is lost.
      weightMeters: Number.isFinite(weight) ? Number((weight / 1000).toFixed(3)) : null,
      weightName: route.weight_name ? String(route.weight_name) : null,
      waypointCount: Array.isArray(json.waypoints) ? json.waypoints.length : null,
      source: MAP_PROVIDERS.routing,
      providerRef: { provider: 'osrm', index },
    };
  });
}

/**
 * Maps an exception to a stable error kind used by the UI + tests:
 *   geocode-not-found | geocode-ambiguous | route-empty | geocode-http
 *   route-http | network
 */
export function errorKindFor(error) {
  const code = error && error.code;
  if (
    code === 'geocode-not-found' ||
    code === 'geocode-ambiguous' ||
    code === 'route-empty' ||
    code === 'geocode-http' ||
    code === 'route-http'
  ) {
    return code;
  }
  return 'network';
}

/**
 * Typed error for a low-confidence geocode. Carries the ranked Photon
 * candidates so the UI can ask the user which one was meant — it never
 * silently selects one.
 */
export function ambiguousGeocodeError(resolution) {
  const resolutionSafe = resolution || {};
  return Object.assign(new Error('ambiguous-location'), {
    code: 'geocode-ambiguous',
    reason: resolutionSafe.reason || 'weak-match',
    candidates: resolutionSafe.candidates || [],
  });
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

  /**
   * Resolves free text to a real place. Multiple Photon candidates are ranked
   * and validated; only a confident winner is returned. An ambiguous query
   * throws a `geocode-ambiguous` error carrying the candidate list instead of
   * silently returning whatever Photon happened to rank first.
   */
  async function geocode(text) {
    const normalized = String(text || '').trim();
    if (!normalized) {
      throw Object.assign(new Error('empty-location'), { code: 'geocode-not-found' });
    }
    const json = await getJson(geocodeTextUrl(normalized), 'geocode-http');
    const resolution = resolveGeocodeQuery(normalized, json);
    if (resolution.status === 'not-found') {
      throw Object.assign(new Error('not-found'), { code: 'geocode-not-found' });
    }
    if (resolution.status === 'ambiguous') {
      throw ambiguousGeocodeError(resolution);
    }
    return resolution.place;
  }

  /**
   * Non-throwing variant used by the search UI: always reports the ranked
   * candidates plus the confidence, so the caller can decide between an
   * automatic pick and asking the user.
   */
  async function suggest(text) {
    const normalized = String(text || '').trim();
    if (!normalized) {
      return { status: 'not-found', candidates: [], place: null, confidence: 0, reason: 'empty-query' };
    }
    const json = await getJson(geocodeTextUrl(normalized), 'geocode-http');
    const resolution = resolveGeocodeQuery(normalized, json);
    return {
      status: resolution.status,
      candidates: resolution.candidates,
      place: resolution.place,
      confidence: geocodeConfidence(resolution.candidates),
      reason: resolution.reason,
    };
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
   *
   * When geocoding is ambiguous the candidates are attached to the error so a
   * single UI message can offer the alternatives for the field that failed.
   */
  async function analyzeTrip({ origin, destination }) {
    let originResolved;
    let destinationResolved;
    try {
      originResolved = await geocode(origin);
    } catch (error) {
      if (error && error.code === 'geocode-ambiguous') error.field = 'origin';
      throw error;
    }
    try {
      destinationResolved = await geocode(destination);
    } catch (error) {
      if (error && error.code === 'geocode-ambiguous') error.field = 'destination';
      throw error;
    }
    const routes = await route(originResolved, destinationResolved);
    return { originResolved, destinationResolved, routes };
  }

  return { geocode, suggest, route, analyzeTrip };
}