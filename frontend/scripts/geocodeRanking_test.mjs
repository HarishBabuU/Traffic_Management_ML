/**
 * Geocoding-result ranking + geolocation-accuracy tests.
 *
 * Covers the two geolocation fixes:
 *   1. Photon returns several candidates for one query and the FIRST one is
 *      frequently the wrong place. These tests prove the ranking never prefers
 *      a candidate just because Photon put it first.
 *   2. The browser-reported accuracy is classified and poor fixes are labelled
 *      approximate instead of being presented as exact.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLocationService,
  errorKindFor,
  geocodeConfidence,
  geocodeTextUrl,
  parseGeocodeCandidates,
  parseGeocodeResponse,
  rankGeocodeCandidates,
  resolveGeocodeQuery,
  scoreGeocodeCandidate,
  PHOTON_CANDIDATE_LIMIT,
} from '../src/services/locationProviders.js';
import {
  accuracyBand,
  createLocationProvider,
  isApproximateFix,
  isPreciseFix,
  LOCATION_PRECISION,
  LOCATION_STATES,
  locationCard,
  precisionLabel,
} from '../src/services/geolocation.js';
import { ANALYSIS_MESSAGES, mapViewState } from '../src/services/controlCenter.js';

// ---------------------------------------------------------------------------
// A real-shaped Photon payload for "Chennai Institute of Technology Kundrathur".
// Photon ranked "Vellore Institute of Technology" (Kandigai) first, which is the
// bug being fixed. Field values follow the documented Photon properties:
// name, street, district, city, county, state, postcode, country, type, osm_*.
// ---------------------------------------------------------------------------
const CIT_QUERY = 'Chennai Institute of Technology Kundrathur';

const PHOTON_CIT_SEARCH = {
  features: [
    {
      geometry: { type: 'Point', coordinates: [79.3392, 12.9676] },
      properties: {
        name: 'Vellore Institute of Technology',
        street: 'Kandigai',
        district: 'Vellore',
        city: 'Vellore',
        county: 'Vellore',
        state: 'Tamil Nadu',
        postcode: '632602',
        country: 'India',
        countrycode: 'IN',
        osm_id: 'way/21074963',
        osm_key: 'highway',
        osm_value: 'residential',
        type: 'street',
        layer: 'street',
      },
    },
    {
      geometry: { type: 'Point', coordinates: [80.2263, 12.9676] },
      properties: {
        name: 'VIT Chennai Campus',
        district: 'Chennai',
        city: 'Chennai',
        state: 'Tamil Nadu',
        country: 'India',
        countrycode: 'IN',
        osm_key: 'amenity',
        osm_value: 'university',
        type: 'other',
        layer: 'osm',
      },
    },
    {
      geometry: { type: 'Point', coordinates: [80.1936, 12.9712] },
      properties: {
        name: 'Chennai Institute of Technology',
        street: 'Kundrathur',
        district: 'Kancheepuram',
        city: 'Chennai',
        county: 'Tamil Nadu',
        state: 'Tamil Nadu',
        postcode: '600063',
        country: 'India',
        countrycode: 'IN',
        osm_id: 'relation/310826',
        osm_key: 'amenity',
        osm_value: 'university',
        type: 'other',
        layer: 'osm',
      },
    },
    {
      geometry: { type: 'Point', coordinates: [80.2707, 13.0827] },
      properties: {
        name: 'Chennai',
        district: 'Chennai',
        city: 'Chennai',
        state: 'Tamil Nadu',
        country: 'India',
        countrycode: 'IN',
        osm_key: 'place',
        osm_value: 'city',
        type: 'city',
        layer: 'address',
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Issue 1 — candidate ranking
// ---------------------------------------------------------------------------

test('Photon asks for more than one candidate so ranking has something to rank', () => {
  assert.ok(PHOTON_CANDIDATE_LIMIT > 1, 'more than a single candidate is requested');
  const url = geocodeTextUrl(CIT_QUERY);
  assert.match(url, /^https:\/\/photon\.komoot\.io\/api\/\?q=/);
  assert.match(url, new RegExp(`limit=${PHOTON_CANDIDATE_LIMIT}$`));
  assert.match(url, /^https:\/\/photon\.komoot\.io\//, 'Photon is still the provider');
});

test('every Photon candidate is preserved with its locality fields intact', () => {
  const candidates = parseGeocodeCandidates(PHOTON_CIT_SEARCH);
  assert.equal(candidates.length, 4);
  assert.equal(candidates[0].name, 'Vellore Institute of Technology');
  assert.equal(candidates[0].city, 'Vellore');
  assert.equal(candidates[0].street, 'Kandigai');
  assert.equal(candidates[0].state, 'Tamil Nadu');
  assert.equal(candidates[0].type, 'street');
  assert.equal(candidates[2].name, 'Chennai Institute of Technology');
  assert.equal(candidates[2].city, 'Chennai');
  assert.equal(candidates[2].district, 'Kancheepuram');
  assert.equal(candidates[2].street, 'Kundrathur');
  assert.equal(candidates[2].lat, 12.9712);
  assert.equal(candidates[2].lon, 80.1936);
  assert.equal(parseGeocodeCandidates({ features: [] }).length, 0);
  assert.equal(parseGeocodeCandidates(null).length, 0);
});

test('the CIT Kundrathur query does not rank "Vellore Institute of Technology" first', () => {
  const ranked = rankGeocodeCandidates(CIT_QUERY, parseGeocodeCandidates(PHOTON_CIT_SEARCH));

  assert.equal(ranked[0].name, 'Chennai Institute of Technology');
  assert.notEqual(ranked[0].name, 'Vellore Institute of Technology');
  assert.notEqual(ranked[0].providerRank, 0, 'the winner is NOT the first Photon feature');
  assert.ok(
    ranked[0].score > ranked.find((c) => c.name === 'Vellore Institute of Technology').score,
    'the correct institution outscores the first Photon hit'
  );
  assert.ok(ranked[0].score - ranked[1].score > 0.8, 'the winner is clearly separated from the runner-up');
});

test('a locality-only hit (Chennai city) cannot outrank the named institution', () => {
  const ranked = rankGeocodeCandidates(CIT_QUERY, parseGeocodeCandidates(PHOTON_CIT_SEARCH));
  const city = ranked.find((c) => c.name === 'Chennai');
  const cit = ranked.find((c) => c.name === 'Chennai Institute of Technology');
  assert.ok(city.score < cit.score, 'the plain city is ranked below the searched institution');
});

test('name coverage and locality coverage both raise the score', () => {
  const vellore = parseGeocodeCandidates(PHOTON_CIT_SEARCH)[0];
  const cit = parseGeocodeCandidates(PHOTON_CIT_SEARCH)[2];
  assert.ok(
    scoreGeocodeCandidate(CIT_QUERY, cit) > scoreGeocodeCandidate(CIT_QUERY, vellore),
    'matching the searched institution and its locality scores highest'
  );
});

test('resolveGeocodeQuery returns the correct place, not the first Photon feature', () => {
  const resolution = resolveGeocodeQuery(CIT_QUERY, PHOTON_CIT_SEARCH);
  assert.equal(resolution.status, 'ok');
  assert.deepEqual(resolution.place, {
    name: 'Chennai Institute of Technology',
    lat: 12.9712,
    lon: 80.1936,
  });
  assert.ok(geocodeConfidence(resolution.candidates) > 0.8, 'a confident pick has high confidence');
});

test('an institution query never resolves to a road or waterway', () => {
  const roadsFirst = {
    features: [
      {
        geometry: { type: 'Point', coordinates: [80.0, 13.0] },
        properties: { name: 'Kundrathur Road', type: 'highway', osm_value: 'residential', city: 'Chennai' },
      },
      {
        geometry: { type: 'Point', coordinates: [80.19, 12.97] },
        properties: {
          name: 'Chennai Institute of Technology',
          type: 'other',
          osm_value: 'university',
          city: 'Chennai',
          street: 'Kundrathur',
        },
      },
    ],
  };
  const resolution = resolveGeocodeQuery(CIT_QUERY, roadsFirst);
  assert.equal(resolution.place.name, 'Chennai Institute of Technology');
});

test('a close call is reported as ambiguous instead of silently picking one', () => {
  // Two near-identical campuses: the ranking cannot justify either one.
  const ambiguousResponse = {
    features: [
      {
        geometry: { type: 'Point', coordinates: [80.19, 12.97] },
        properties: { name: 'Chennai Institute of Technology', city: 'Chennai', state: 'Tamil Nadu' },
      },
      {
        geometry: { type: 'Point', coordinates: [80.2, 12.98] },
        properties: { name: 'Chennai Institute of Technology', city: 'Chennai', state: 'Tamil Nadu' },
      },
    ],
  };
  const resolution = resolveGeocodeQuery('Chennai Institute of Technology', ambiguousResponse);
  assert.equal(resolution.status, 'ambiguous');
  assert.equal(resolution.place, null, 'no place is selected on a close call');
  assert.equal(resolution.candidates.length, 2, 'both candidates are offered to the user');
});

test('a completely unrelated hit is ambiguous, not a confident wrong answer', () => {
  const unrelated = {
    features: [
      {
        geometry: { type: 'Point', coordinates: [77.2, 28.6] },
        properties: { name: 'Connaught Place', city: 'New Delhi', state: 'Delhi', country: 'India' },
      },
    ],
  };
  const resolution = resolveGeocodeQuery(CIT_QUERY, unrelated);
  assert.equal(resolution.status, 'ambiguous');
  assert.equal(resolution.place, null);
  assert.ok(geocodeConfidence(resolution.candidates) < 0.8);
});

test('an empty Photon response is not-found, never a fabricated place', () => {
  const resolution = resolveGeocodeQuery(CIT_QUERY, { features: [] });
  assert.equal(resolution.status, 'not-found');
  assert.equal(resolution.place, null);
  assert.equal(resolution.candidates.length, 0);
});

test('single-candidate and plain-city searches still resolve (no false ambiguity)', () => {
  const single = {
    features: [
      {
        geometry: { type: 'Point', coordinates: [80.2707, 13.0827] },
        properties: { name: 'Chennai', city: 'Chennai', state: 'Tamil Nadu', country: 'India' },
      },
    ],
  };
  assert.equal(resolveGeocodeQuery('Chennai', single).status, 'ok');

  const bare = {
    features: [
      { geometry: { type: 'Point', coordinates: [80.1131, 12.9251] }, properties: { name: 'Madurai' } },
    ],
  };
  assert.equal(resolveGeocodeQuery('Madurai', bare).status, 'ok');
});

test('parseGeocodeResponse keeps its documented {name,lat,lon} first-hit contract', () => {
  const place = parseGeocodeResponse(PHOTON_CIT_SEARCH);
  assert.deepEqual(Object.keys(place).sort(), ['lat', 'lon', 'name']);
  assert.equal(place.name, 'Vellore Institute of Technology');
  assert.equal(parseGeocodeResponse({ features: [] }), null);
});

test('geocode() selects the ranked winner through the injectable provider', async () => {
  const requested = [];
  const service = createLocationService({
    fetchImpl: async (url) => {
      requested.push(url);
      return { ok: true, status: 200, json: async () => PHOTON_CIT_SEARCH };
    },
  });
  const place = await service.geocode(CIT_QUERY);
  assert.equal(place.name, 'Chennai Institute of Technology');
  assert.equal(place.lon, 80.1936);
  assert.equal(place.lat, 12.9712);
  assert.equal(requested.length, 1);
  assert.match(requested[0], /photon\.komoot\.io/);
});

test('an ambiguous geocode surfaces a typed error carrying the candidate list', async () => {
  const service = createLocationService({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        features: [
          { geometry: { type: 'Point', coordinates: [78.0, 13.0] }, properties: { name: 'Somewhere Else', city: 'Vellore' } },
        ],
      }),
    }),
  });
  await assert.rejects(service.geocode(CIT_QUERY), (error) => {
    assert.equal(errorKindFor(error), 'geocode-ambiguous');
    assert.ok(Array.isArray(error.candidates) && error.candidates.length > 0);
    assert.ok(error.candidates[0].candidates === undefined);
    return true;
  });
});

test('analyzeTrip attributes the ambiguity to the field that failed', async () => {
  const queryOf = (url) => decodeURIComponent((url.match(/[?&]q=([^&]+)/) || [])[1] || '');
  const MADURAI_OK = {
    features: [{ geometry: { type: 'Point', coordinates: [78.1198, 9.9252] }, properties: { name: 'Madurai' } }],
  };
  const UNRELATED_WEAK = {
    features: [
      { geometry: { type: 'Point', coordinates: [77.2, 28.6] }, properties: { name: 'Connaught Place', city: 'New Delhi' } },
    ],
  };
  const serviceWith = (map) =>
    createLocationService({
      fetchImpl: async (url) => {
        if (!url.includes('photon.komoot.io')) {
          return { ok: true, status: 200, json: async () => ({ code: 'Ok', routes: [] }) };
        }
        return { ok: true, status: 200, json: async () => map[queryOf(url)] || UNRELATED_WEAK };
      },
    });

  await assert.rejects(
    serviceWith({ Madurai: MADURAI_OK, [CIT_QUERY]: UNRELATED_WEAK }).analyzeTrip({
      origin: 'Madurai',
      destination: CIT_QUERY,
    }),
    (error) => {
      assert.equal(errorKindFor(error), 'geocode-ambiguous');
      assert.equal(error.field, 'destination');
      return true;
    }
  );
  await assert.rejects(
    serviceWith({ [CIT_QUERY]: UNRELATED_WEAK }).analyzeTrip({
      origin: CIT_QUERY,
      destination: 'Madurai',
    }),
    (error) => {
      assert.equal(errorKindFor(error), 'geocode-ambiguous');
      assert.equal(error.field, 'origin');
      return true;
    }
  );
});

test('the UI maps geocode-ambiguous to a location-error state with guidance', () => {
  assert.equal(mapViewState('geocode-ambiguous').mode, 'location-error');
  assert.match(ANALYSIS_MESSAGES['geocode-ambiguous'], /Several locations match/i);
});

// ---------------------------------------------------------------------------
// Issue 2 — browser geolocation accuracy
// ---------------------------------------------------------------------------

function fakeGeolocation(result) {
  return {
    getCurrentPosition: (ok, err) => {
      if (result instanceof Error || (result && result.code)) err(result);
      else ok(result);
    },
  };
}

test('accuracy is requested at high accuracy and never from a stale cache', async () => {
  let optionsSeen = null;
  const provider = createLocationProvider({
    geolocation: {
      getCurrentPosition: (ok, err, options) => {
        optionsSeen = options;
        ok({ coords: { latitude: 12.9712, longitude: 80.1936, accuracy: 8 }, timestamp: 1700000000000 });
      },
    },
  });
  const result = await provider.detect();
  assert.equal(optionsSeen.enableHighAccuracy, true, 'the best available fix is requested');
  assert.equal(optionsSeen.maximumAge, 0, 'a cached, potentially stale fix is not reused');
  assert.ok(optionsSeen.timeout > 0);
  assert.equal(result.coords.accuracy, 8);
  assert.equal(result.coords.accuracyRadiusMeters, 8);
});

test('accuracy bands classify the browser-reported radius', () => {
  assert.equal(accuracyBand(8), LOCATION_PRECISION.high);
  assert.equal(accuracyBand(50), LOCATION_PRECISION.high);
  assert.equal(accuracyBand(120), LOCATION_PRECISION.fair);
  assert.equal(accuracyBand(750), LOCATION_PRECISION.low);
  assert.equal(accuracyBand(12000), LOCATION_PRECISION.poor);
  assert.equal(accuracyBand(null), LOCATION_PRECISION.unknown);
  assert.equal(accuracyBand(undefined), LOCATION_PRECISION.unknown);
  assert.equal(accuracyBand(-5), LOCATION_PRECISION.unknown);
});

test('only a high-accuracy fix is presented as precise', () => {
  assert.equal(isPreciseFix(10), true);
  assert.equal(isPreciseFix(500), false);
  assert.equal(isApproximateFix(500), true);
  assert.equal(isApproximateFix(null), true, 'an unknown accuracy is never called precise');
});

test('a poor fix is labelled approximate and keeps the raw accuracy', async () => {
  const provider = createLocationProvider({
    geolocation: fakeGeolocation({
      coords: { latitude: 12.9712, longitude: 80.1936, accuracy: 2400 },
      timestamp: 1700000000000,
    }),
  });
  const result = await provider.detect();
  assert.equal(result.status, LOCATION_STATES.live);
  assert.equal(result.coords.lat, 12.9712, 'coordinates are reported exactly as given');
  assert.equal(result.coords.accuracy, 2400);
  assert.equal(result.precision, LOCATION_PRECISION.poor);
  assert.equal(result.isApproximate, true);

  const card = locationCard(result);
  assert.equal(card.isApproximate, true);
  assert.equal(card.accuracyMeters, 2400);
  assert.notEqual(card.status, 'LIVE', 'a rough fix is not advertised as an exact LIVE position');
  assert.match(card.note, /[Aa]pproximate/);
  assert.match(card.note, /±2400 m/);
  assert.match(card.note, /not a precise point/i);
});

test('a high-accuracy fix is still reported with its accuracy, never as "exact"', async () => {
  const provider = createLocationProvider({
    geolocation: fakeGeolocation({
      coords: { latitude: 12.9712, longitude: 80.1936, accuracy: 12 },
      timestamp: 1700000000000,
    }),
  });
  const result = await provider.detect();
  const card = locationCard(result);
  assert.equal(card.isApproximate, false);
  assert.equal(card.status, 'LIVE');
  assert.match(card.note, /±12 m/);
  assert.doesNotMatch(card.note, /exact/i);
});

test('precisionLabel never overstates the reported accuracy', () => {
  assert.match(precisionLabel(9), /Precise to ±9 m/);
  assert.match(precisionLabel(120), /Approximate · accurate to ±120 m/);
  assert.match(precisionLabel(300), /only accurate to ±300 m/);
  assert.match(precisionLabel(9000), /very rough position/i);
  assert.match(precisionLabel(9000), /Approximate/);
  assert.match(precisionLabel(null), /did not report an accuracy/);
  assert.match(precisionLabel(null), /Approximate/);
});

test('a fix with no accuracy value is surfaced as approximate, not as exact', async () => {
  const provider = createLocationProvider({
    geolocation: fakeGeolocation({ coords: { latitude: 12.97, longitude: 80.19 }, timestamp: null }),
  });
  const result = await provider.detect();
  assert.equal(result.status, LOCATION_STATES.live);
  assert.equal(result.coords.accuracy, null);
  assert.equal(result.precision, LOCATION_PRECISION.unknown);
  const card = locationCard(result);
  assert.equal(card.isApproximate, true);
  assert.match(card.note, /did not report an accuracy/);
});

test('geolocation failures are reported per reason and never as a fake position', async () => {
  const cases = [
    { code: 1, status: LOCATION_STATES.denied, errorCode: 'permission-denied', note: /Permission was refused/ },
    { code: 2, status: LOCATION_STATES.unavailable, errorCode: 'position-unavailable', note: /could not determine a position/ },
    { code: 3, status: LOCATION_STATES.unavailable, errorCode: 'timeout', note: /timed out/ },
  ];
  for (const testCase of cases) {
    const provider = createLocationProvider({ geolocation: fakeGeolocation(testCase) });
    const result = await provider.detect();
    assert.equal(result.status, testCase.status);
    assert.equal(result.code, testCase.errorCode);
    assert.equal(result.coords, null, 'no coordinates are invented on failure');
    const card = locationCard(result);
    assert.match(card.note, testCase.note);
  }
});

test('a success payload with unusable coordinates degrades gracefully', async () => {
  const provider = createLocationProvider({
    geolocation: fakeGeolocation({ coords: { latitude: NaN, longitude: 80.19, accuracy: 5 }, timestamp: 1 }),
  });
  const result = await provider.detect();
  assert.equal(result.status, LOCATION_STATES.unavailable);
  assert.equal(result.code, 'position-unavailable');
  assert.equal(result.coords, null);
});

test('no hardcoded fallback location exists in the geolocation provider', async () => {
  const unsupported = await createLocationProvider({ geolocation: null }).detect();
  assert.equal(unsupported.status, LOCATION_STATES.unavailable);
  assert.equal(unsupported.coords, null);
  const thrown = await createLocationProvider({
    geolocation: { getCurrentPosition: () => { throw new Error('boom'); } },
  }).detect();
  assert.equal(thrown.status, LOCATION_STATES.unavailable);
  assert.equal(thrown.code, 'exception');
  assert.equal(thrown.coords, null);
});

test('coordinates are passed through byte-for-byte and never modified', async () => {
  // Deliberately awkward values: negative latitude, long fraction, tiny accuracy.
  // Any rounding, snapping to a "known place" or hardcoded fallback would break
  // these exact-equality assertions.
  const cases = [
    { latitude: -33.868821, longitude: 151.2092955, accuracy: 4.5 },
    { latitude: 0.0000001, longitude: -0.0000002, accuracy: 3 },
    { latitude: 77.209023, longitude: 28.613939, accuracy: 27.25 },
  ];
  for (const coords of cases) {
    const provider = createLocationProvider({
      geolocation: fakeGeolocation({ coords, timestamp: 1700000000000 }),
    });
    const result = await provider.detect();
    assert.equal(result.coords.lat, coords.latitude, `latitude preserved exactly (${coords.latitude})`);
    assert.equal(result.coords.lon, coords.longitude, `longitude preserved exactly (${coords.longitude})`);
    assert.equal(result.coords.accuracy, coords.accuracy, 'accuracy preserved exactly, not rounded');
    assert.equal(result.coords.accuracyRadiusMeters, coords.accuracy, 'the drawn radius is the raw value');
  }
});

test('the source never rounds, snaps or overrides the browser coordinates', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'services', 'geolocation.js'),
    'utf-8'
  );
  // No coordinate rounding/snapping expressions on the reported lat/lon.
  assert.doesNotMatch(source, /toFixed\(\s*\d\s*\)/, 'coordinates are never rounded via toFixed');
  assert.doesNotMatch(source, /Math\.(round|floor|ceil)\(\s*[^)]*lat/i, 'latitude is never rounded');
  assert.doesNotMatch(source, /Math\.(round|floor|ceil)\(\s*[^)]*lon/i, 'longitude is never rounded');
  assert.doesNotMatch(
    source,
    /lat\s*[:=]\s*\d{2}\.\d/,
    'no hardcoded latitude anywhere in the provider'
  );
  assert.doesNotMatch(
    source,
    /lon\s*[:=]\s*\d{2,3}\.\d/,
    'no hardcoded longitude anywhere in the provider'
  );
  assert.match(source, /lat:\s*Number\(c\.latitude\)/, 'latitude comes straight from the browser fix');
  assert.match(source, /lon:\s*Number\(c\.longitude\)/, 'longitude comes straight from the browser fix');
});

test('the map derives its approximate state from the shared accuracy bands', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'components', 'MapView.jsx'),
    'utf-8'
  );
  // The band thresholds must live in one place, not be re-declared on the map.
  assert.match(source, /isApproximateFix/, 'approximate state reuses the shared band logic');
  assert.doesNotMatch(source, /accuracy\s*>\s*50/, 'the map does not hardcode its own accuracy threshold');
  assert.doesNotMatch(source, /radius\s*<=\s*\d+/, 'the map does not re-declare band cut-offs');
});

test('the map and the provider agree on every accuracy band', () => {
  // A single bad fix anywhere on the map is what this whole change is about.
  for (const accuracy of [5, 40, 80, 190, 400, 900, 1800, 40000, null]) {
    const shouldBeApproximate = isApproximateFix(accuracy);
    const card = locationCard({
      status: LOCATION_STATES.live,
      coords: { lat: 12.9712, lon: 80.1936, accuracy, timestamp: 1700000000000 },
    });
    assert.equal(card.isApproximate, shouldBeApproximate, `accuracy=${accuracy} is classified consistently`);
  }
});

test('MapView renders the browser accuracy radius and never claims exactness', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'components', 'MapView.jsx'),
    'utf-8'
  );
  assert.match(source, /L\.circle\(/, 'an accuracy circle is drawn around the fix');
  assert.match(source, /radius,/, 'the browser-reported accuracy is used as the radius');
  assert.match(source, /approximate/i, 'the marker says the position is approximate');
  assert.doesNotMatch(source, /My current location'/i, 'the bare label without an accuracy qualifier is gone');
  assert.doesNotMatch(source, /12\.97|80\.19|chennai/i, 'no hardcoded fallback coordinates on the map');
});