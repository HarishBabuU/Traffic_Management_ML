/**
 * Phase 9F-1 smoke test (run with: npm test)
 *
 * Verifies that the prepared JSON data copies exist and that MOCK / LIVE /
 * STATIC status information is preserved exactly as in the source outputs.
 * Nothing here transforms mock data into live data.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  tripStage,
  uniqueRoutes,
  routeCandidates,
  cctvPolicy,
  selectableRoute,
  demoCctvCatalog,
  resourcesForRoute,
  videoIntelligence,
  mapViewState,
  analysisMessageFor,
  GEO_CCTV_NOTE,
} from '../src/services/controlCenter.js';
import {
  createLocationService,
  parseGeocodeResponse,
  parseRoutesResponse,
  geocodeTextUrl,
  routeUrl,
  errorKindFor,
  MAP_PROVIDERS,
  PHOTON_CANDIDATE_LIMIT,
} from '../src/services/locationProviders.js';
import {
  createWeatherService,
  parseWeatherResponse,
  weatherCodeDescription,
  windDirectionLabel,
  isValidCoordinate,
  weatherUrl,
  weatherUiState,
  weatherErrorKindFor,
  WEATHER_PROVIDER,
} from '../src/services/weatherProvider.js';
import {
  classifyIntent,
  extractTripPlaces,
  buildReply,
  createAssistantService,
  scenarioTrafficHint,
scenarioReply,
  ASSISTANT_MODE,
  INTENT,
  HELP_TEXT,
} from '../src/services/aiAssistant.js';
import {
  runScenario,
  scenarioUiState,
  isMockRoute,
  layerScore,
  renormalizeWeights,
  LAYER_WEIGHTS,
  LAYER_SCORES,
  BASELINE_INPUTS,
  MIN_KNOWN_WEIGHT,
} from '../src/services/scenarioSimulator.js';
import {
  createVoiceAssistantService,
  detectRecognitionSupport,
  detectSpeechSynthesisSupport,
  detectVoiceMode,
  mapVoiceError,
  VOICE_MODE,
  VOICE_MODE_LABELS,
  VOICE_STATE,
VOICE_LABELS,
  DEFAULT_LANGUAGE,
  LANGUAGE_FALLBACKS,
} from '../src/services/voiceAssistant.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'src', 'data');

function readJson(name) {
  return JSON.parse(readFileSync(join(dataDir, name), 'utf-8'));
}

test('all prepared JSON files exist', () => {
  for (const name of [
    'traffic.json',
    'weather.json',
    'roadConditions.json',
    'roadScores.json',
    'routes.json',
    'level8.json',
  ]) {
    const payload = readJson(name);
    assert.ok(payload, `${name} parses as JSON`);
    assert.ok(payload.generated_from, `${name} records its source file`);
  }
});

test('Phase 9D road scores stay labelled mock', () => {
  const payload = readJson('roadScores.json');
  assert.ok(payload.rows.length >= 7, `expected >= 7 road scores, got ${payload.rows.length}`);
  for (const row of payload.rows) {
    assert.equal(row.data_mode, 'mock', `${row.road_id} data_mode must stay mock`);
    assert.equal(row.is_mock, 'True', `${row.road_id} is_mock must stay True`);
  }
});

test('Phase 9E routes stay labelled mock', () => {
  const payload = readJson('routes.json');
  assert.ok(payload.rows.length >= 7, `expected >= 7 routes, got ${payload.rows.length}`);
  for (const row of payload.rows) {
    assert.equal(row.data_mode, 'mock', `${row.route_id} data_mode must stay mock`);
    assert.equal(row.is_mock, 'True', `${row.route_id} is_mock must stay True`);
  }
});

test('Phase 9C road conditions keep original condition values', () => {
  const payload = readJson('roadConditions.json');
  const allowed = new Set([
    'GOOD', 'MODERATE', 'POOR', 'RESTRICTED', 'UNKNOWN', 'LOW', 'HIGH', '',
  ]);
  for (const row of payload.rows) {
    assert.equal(row.is_mock, 'True', `${row.road_id} is_mock must stay True`);
  }
  const surfaceValues = payload.rows.map((r) => r.road_surface);
  for (const v of surfaceValues) {
    assert.ok(allowed.has(v), `unexpected road_surface value: ${v}`);
  }
});

test('weather preserves live source (no mock-overwrites-live)', () => {
  const payload = readJson('weather.json');
  assert.ok(payload.rows.length === 1, 'expected exactly one weather row');
  const row = payload.rows[0];
  assert.equal(row.is_mock, 'False', 'weather is_mock must stay False');
  assert.equal(row.source, 'live', 'weather source must stay live');
  assert.equal(row.provider, 'open-meteo', 'weather provider must stay open-meteo');
});

test('Phase 9A + Level 8 values are preserved verbatim', () => {
  const traffic = readJson('traffic.json');
  assert.ok(traffic.rows.length >= 15, 'expected interval/traffic rows');
  const overview = traffic.rows.find((r) => r.row_type === 'video_overview');
  assert.ok(overview, 'video_overview row exists');
  assert.ok(overview.video, 'overview row carries video name');

  const level8 = readJson('level8.json');
  assert.ok(level8.traffic_statistics.length > 0, 'level8 statistics present');
  const total = level8.traffic_statistics.find((r) => r.metric === 'total_corrected_identities');
  assert.ok(total, 'total_corrected_identities present');
  assert.equal(Number(total.value), 122, 'total corrected vehicles preserved (122)');

  const conservative = level8.traffic_statistics.find((r) => r.metric === 'total_conservative_identities');
  assert.ok(conservative, 'total_conservative_identities present');
  assert.equal(Number(conservative.value), 108, 'conservative count preserved (108)');

  const trajectory = level8.traffic_statistics.find((r) => r.metric === 'total_trajectory_rows');
  assert.ok(trajectory, 'total_trajectory_rows present');
  assert.equal(Number(trajectory.value), 15491, 'trajectory rows preserved (15491)');
});

test('routes carry all four recommendation statuses', () => {
  const payload = readJson('routes.json');
  const statuses = new Set(payload.rows.map((r) => r.recommendation_status));
  assert.ok(statuses.has('RECOMMENDED'), 'RECOMMENDED status present');
  assert.ok(statuses.has('ELIGIBLE'), 'ELIGIBLE status present');
  assert.ok(statuses.has('INSUFFICIENT_DATA'), 'INSUFFICIENT_DATA status present');
  assert.ok(statuses.has('INVALID_ROUTE'), 'INVALID_ROUTE status present');
});

test('road scores carry layer contribution fields', () => {
  const payload = readJson('roadScores.json');
  for (const row of payload.rows) {
    assert.ok('traffic_score' in row, `${row.road_id} has traffic_score`);
    assert.ok('traffic_weight' in row, `${row.road_id} has traffic_weight`);
    assert.ok('weather_score' in row, `${row.road_id} has weather_score`);
    assert.ok('weather_weight' in row, `${row.road_id} has weather_weight`);
    assert.ok('road_score' in row, `${row.road_id} has road_score`);
    assert.ok('road_weight' in row, `${row.road_id} has road_weight`);
    assert.ok('overall_score' in row, `${row.road_id} has overall_score`);
  }
});

// ---------------- Phase 9F-4 Part 1: control-centre interaction tests ----------------

const routesPayload = () => readJson('routes.json').rows;
const level8Payload = () => readJson('level8.json');
const trafficPayload = () => readJson('traffic.json');

test('trip stage moves no-destination -> destination-set -> routes-ready', () => {
  assert.equal(tripStage({ destinationEntered: false, analyzed: false }), 'no-destination');
  assert.equal(tripStage({ destinationEntered: true, analyzed: false }), 'destination-set');
  assert.equal(tripStage({ destinationEntered: true, analyzed: true }), 'routes-ready');
});

test('CCTV resources are hidden before destination and before route analysis', () => {
  const beforeDestination = cctvPolicy({
    destinationEntered: false,
    analyzed: false,
    selectedRoute: null,
  });
  assert.equal(beforeDestination.visible, false, 'STATE 1: no CCTV before destination input');
  assert.equal(beforeDestination.kind, 'no-destination');

  const beforeAnalysis = cctvPolicy({
    destinationEntered: true,
    analyzed: false,
    selectedRoute: null,
  });
  assert.equal(beforeAnalysis.visible, false, 'STATE 2: no CCTV after destination but before analysis');
  assert.equal(beforeAnalysis.kind, 'not-analyzed');
});

test('route candidates appear only after route analysis', () => {
  const rows = routesPayload();
  assert.equal(
    routeCandidates(rows, { destinationEntered: false, analyzed: false }),
    null,
    'candidates hidden before destination'
  );
  assert.equal(
    routeCandidates(rows, { destinationEntered: true, analyzed: false }),
    null,
    'candidates hidden before analysis'
  );
  const candidates = routeCandidates(rows, { destinationEntered: true, analyzed: true });
  assert.ok(Array.isArray(candidates), 'candidates exposed after analysis');
  assert.ok(candidates.length >= 6, 'unique route candidates exposed');
});

test('duplicate route ids are collapsed for selection', () => {
  const rows = routesPayload();
  const unique = uniqueRoutes(rows);
  const ids = unique.map((r) => r.route_id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate route_id after collapse');
  const routeACount = rows.filter((r) => r.route_id === 'ROUTE-A').length;
  assert.ok(routeACount >= 2, 'source data still contains the duplicate (unchanged)');
});

test('selectable routes are limited to RECOMMENDED and ELIGIBLE', () => {
  assert.equal(selectableRoute({ recommendation_status: 'RECOMMENDED' }), true);
  assert.equal(selectableRoute({ recommendation_status: 'ELIGIBLE' }), true);
  assert.equal(selectableRoute({ recommendation_status: 'INSUFFICIENT_DATA' }), false);
  assert.equal(selectableRoute({ recommendation_status: 'INVALID_ROUTE' }), false);
  assert.equal(selectableRoute(null), false);
});

test('CCTV: no generic list before route selection, then ONLY route-relevant resources', () => {
  const noRoute = cctvPolicy({
    destinationEntered: true,
    analyzed: true,
    selectedRoute: null,
  });
  assert.equal(noRoute.visible, true, 'STATE 3: CCTV area available after analysis');
  assert.equal(noRoute.resources.length, 0, 'STATE 3: no generic CCTV list is shown');

  const routeD = routesPayload().find((r) => r.route_id === 'ROUTE-D');
  assert.ok(routeD, 'ROUTE-D exists in the dataset');
  const withRoute = cctvPolicy({
    destinationEntered: true,
    analyzed: true,
    selectedRoute: routeD,
  });
  assert.equal(withRoute.visible, true, 'STATE 4: resources available after route selection');
  assert.ok(withRoute.resources.length > 0, 'route-relevant demo resources returned');
  const expectedRoads = new Set(String(routeD.segment_sequence).split(';'));
  for (const res of withRoute.resources) {
    assert.ok(
      expectedRoads.has(res.roadId),
      `resource ${res.id} belongs to a segment road of the selected route`
    );
  }
});

test('demo CCTV catalog references only recorded videos present in the dataset', () => {
  const level8 = level8Payload();
  const knownVideos = new Set(level8.class_by_video.map((r) => r.video));
  for (const res of demoCctvCatalog) {
    assert.ok(knownVideos.has(res.video), `catalog video "${res.video}" exists in Level 8 data`);
    assert.equal(res.demo, true, 'every demo resource is flagged as demo');
    assert.equal(res.kind, 'recorded', 'every demo resource is recorded footage');
  }
});

test('resources for a route are a subset of the catalogue, never everything', () => {
  const routeD = routesPayload().find((r) => r.route_id === 'ROUTE-D');
  const subset = resourcesForRoute(routeD);
  assert.ok(subset.length > 0 && subset.length < demoCctvCatalog.length);
  assert.equal(resourcesForRoute(null).length, 0);
});

test('vehicle intelligence reads counts from the prepared Level 8 data (no hardcoding)', () => {
  const level8 = level8Payload();
  const traffic = trafficPayload();

  const dense = videoIntelligence('traffic.mp4', level8.class_by_video, traffic.rows);
  assert.equal(dense.byVideo.total, '73', 'traffic.mp4 corrected count from data');
  assert.equal(dense.overview.traffic_condition, 'CONGESTED');

  const calm = videoIntelligence('low traffic.mp4', level8.class_by_video, traffic.rows);
  assert.equal(calm.byVideo.total, '44', 'low traffic.mp4 corrected count from data');
  assert.equal(calm.overview.traffic_condition, 'MODERATE');

  const empty = videoIntelligence('no traffic video.mp4', level8.class_by_video, traffic.rows);
  assert.equal(empty.byVideo.total, '5', 'no traffic video.mp4 corrected count from data');
  assert.equal(empty.overview.traffic_condition, 'LOW');

  const metrics = new Map(level8.traffic_statistics.map((r) => [r.metric, r.value]));
  assert.equal(metrics.get('total_corrected_identities'), '122', 'global total preserved');
  assert.equal(metrics.get('total_conservative_identities'), '108', 'conservative preserved');
  assert.equal(metrics.get('total_trajectory_rows'), '15491', 'trajectory rows preserved');
});

test('recorded footage copies exist under public/recordings (unchanged bytes)', () => {
  const recordingsDir = join(__dirname, '..', 'public', 'recordings');
  const level8 = level8Payload();
  for (const row of level8.class_by_video) {
    const file = join(recordingsDir, row.video);
    assert.ok(existsSync(file), `recorded clip present in public/recordings: ${row.video}`);
  }
});

// ---------------- Phase 9F-4 Part 2: real map providers ----------------

function jsonOk(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

const PHOTON_AIRPORT = {
  features: [
    {
      geometry: { type: 'Point', coordinates: [80.1725867, 12.993374] },
      properties: { name: 'Chennai International Airport' },
    },
  ],
};

const PHOTON_MADURAI = {
  features: [
    {
      geometry: { type: 'Point', coordinates: [78.1198, 9.9252] },
      properties: { name: 'Madurai' },
    },
  ],
};

const PHOTON_CHENNAI = {
  features: [
    {
      geometry: { type: 'Point', coordinates: [80.2707, 13.0827] },
      properties: { name: 'Chennai' },
    },
  ],
};

const OSRM_ROUTES = {
  code: 'Ok',
  routes: [
    {
      distance: 11159,
      duration: 1064,
      legs: [{ summary: 'NH 32' }],
      geometry: {
        type: 'LineString',
        coordinates: [
          [80.1726, 12.9934],
          [80.1601, 12.9802],
          [80.1131, 12.9251],
        ],
      },
    },
    {
      distance: 12900,
      duration: 1420,
      legs: [{ summary: '' }],
      geometry: {
        type: 'LineString',
        coordinates: [
          [80.1726, 12.9934],
          [80.1131, 12.9251],
        ],
      },
    },
  ],
};

test('provider endpoints use only the documented public URLs (no invented API)', () => {
  assert.equal(
    geocodeTextUrl('Chennai Airport'),
    `https://photon.komoot.io/api/?q=Chennai%20Airport&limit=${PHOTON_CANDIDATE_LIMIT}`
  );
  assert.ok(
    PHOTON_CANDIDATE_LIMIT > 1,
    'more than one Photon candidate is requested so results can be ranked'
  );
  const url = routeUrl({ lat: 1, lon: 2 }, { lat: 3, lon: 4 });
  assert.ok(
    url.startsWith('https://router.project-osrm.org/route/v1/driving/2,1;4,3?'),
    'OSRM public demo endpoint only'
  );
  assert.match(url, /overview=full/);
  assert.match(url, /alternatives=true/);
  assert.equal(MAP_PROVIDERS.routing, 'OSRM public demo server (no API key)');
  assert.equal(MAP_PROVIDERS.geocoding, 'Photon (komoot public endpoint, no API key)');
  assert.equal(MAP_PROVIDERS.map, 'OpenStreetMap');
});

test('geocoding response parses into a real {name,lat,lon} place', () => {
  const place = parseGeocodeResponse(PHOTON_AIRPORT);
  assert.deepEqual(place, {
    name: 'Chennai International Airport',
    lat: 12.993374,
    lon: 80.1725867,
  });
  assert.equal(parseGeocodeResponse({ features: [] }), null);
  assert.equal(parseGeocodeResponse(null), null);
});

test('routing response parses real geometry and metrics (never fabricated)', () => {
  const routes = parseRoutesResponse(OSRM_ROUTES);
  assert.equal(routes.length, 2);
  assert.equal(routes[0].id, 'real-route-1');
  assert.equal(routes[0].name, 'NH 32');
  assert.equal(routes[0].distanceKm, 11.2);
  assert.equal(routes[0].durationMin, 18);
  assert.equal(routes[1].name, 'Real route 2', 'empty summary falls back to a label');
  assert.equal(routes[1].distanceKm, 12.9);
  assert.deepEqual(routes[0].geometry, [
    { lat: 12.9934, lon: 80.1726 },
    { lat: 12.9802, lon: 80.1601 },
    { lat: 12.9251, lon: 80.1131 },
  ]);
  assert.ok(routes[0].source.includes('OSRM'), 'real route cites the OSRM provider');
  assert.notEqual(routes[0].source.toLowerCase(), 'mock');
  assert.equal(parseRoutesResponse({ code: 'NoRoute', routes: [] }).length, 0);
});

const mockProviderFetch = async (url) => {
  if (url.includes('photon.komoot.io')) {
    if (url.includes('Airport')) return jsonOk(PHOTON_AIRPORT);
    if ((url.match(/q=([^&]+)/) || [])[1] === encodeURIComponent('Madurai')) {
      return jsonOk(PHOTON_MADURAI);
    }
    if (url.includes('q=Chennai')) return jsonOk(PHOTON_CHENNAI);
    return jsonOk({ features: [] });
  }
  if (url.includes('router.project-osrm.org')) return jsonOk(OSRM_ROUTES);
  throw new Error('unexpected url in mock: ' + url);
};

test('location service resolves real coords and routes via the injectable provider', async () => {
  const service = createLocationService({ fetchImpl: mockProviderFetch });
  const result = await service.analyzeTrip({
    origin: 'Chennai',
    destination: 'Madurai',
  });
  assert.equal(result.originResolved.name, 'Chennai');
  assert.equal(result.destinationResolved.name, 'Madurai');
  assert.equal(result.routes.length, 2);
  assert.equal(result.originResolved.lat, 13.0827);
  assert.equal(result.destinationResolved.lon, 78.1198);
});

test('provider failure is surfaced as an error kind, never fake coordinates', async () => {
  const offline = createLocationService({
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  await assert.rejects(
    offline.analyzeTrip({ origin: 'A', destination: 'B' }),
    (error) => {
      assert.equal(errorKindFor(error), 'network');
      assert.equal(mapViewState(errorKindFor(error)).mode, 'unavailable');
      assert.equal(analysisMessageFor(errorKindFor(error)), 'Real map service unavailable. No real route was generated.');
      return true;
    }
  );
  const noRoute = createLocationService({
    fetchImpl: async (url) => {
      if (url.includes('photon.komoot.io')) return jsonOk(PHOTON_AIRPORT);
      return jsonOk({ code: 'NoRoute', routes: [] });
    },
  });
  await assert.rejects(
    noRoute.analyzeTrip({ origin: 'A', destination: 'B' }),
    (error) => {
      assert.equal(errorKindFor(error), 'route-empty');
      return true;
    }
  );
});

test('mapViewState only surfaces a map in the ready state', () => {
  assert.deepEqual(mapViewState('idle'), { mode: 'idle', message: '' });
  assert.equal(mapViewState('geocoding').mode, 'loading');
  assert.equal(mapViewState('routing').mode, 'loading');
  assert.equal(mapViewState('geocode-not-found').mode, 'location-error');
  assert.equal(mapViewState('route-http').mode, 'unavailable');
  assert.equal(mapViewState('network').mode, 'unavailable');
  assert.equal(mapViewState('ready').mode, 'ready');
});

test('analysis messages match the required UX strings', () => {
  assert.equal(analysisMessageFor('geocoding'), 'Resolving locations...');
  assert.equal(analysisMessageFor('routing'), 'Calculating route...');
  assert.equal(
    analysisMessageFor('geocode-not-found'),
    'Location could not be resolved. Please enter a more specific location.'
  );
  assert.equal(
    analysisMessageFor('route-empty'),
    'Route could not be generated. Please try again.'
  );
  assert.equal(
    analysisMessageFor('network'),
    'Real map service unavailable. No real route was generated.'
  );
});

test('CCTV gating honours analysisReady (real-map success) in STATE 2', () => {
  const failedAnalysis = cctvPolicy({
    destinationEntered: true,
    analyzed: true,
    analysisReady: false,
    selectedRoute: null,
  });
  assert.equal(failedAnalysis.visible, false, 'STATE 2: analysis attempted but failed stays hidden');
  assert.equal(failedAnalysis.kind, 'not-analyzed');

  const routeD = routesPayload().find((r) => r.route_id === 'ROUTE-D');
  const okWithAnalysisReady = cctvPolicy({
    destinationEntered: true,
    analyzed: true,
    analysisReady: true,
    selectedRoute: routeD,
  });
  assert.equal(okWithAnalysisReady.visible, true);
  assert.ok(okWithAnalysisReady.resources.length > 0);
});

test('demo CCTV resources carry no geographic coordinates and are never placed on the map', () => {
  const geoKeys = ['latitude', 'longitude', 'lat', 'lon', 'cameraId', 'coordinates'];
  for (const resource of demoCctvCatalog) {
    for (const key of geoKeys) {
      assert.ok(!(key in resource), `${resource.id} must not carry ${key}`);
    }
  }
  assert.equal(
    GEO_CCTV_NOTE,
    'Geographic CCTV integration not yet available for these demo recordings.'
  );
});

test('demo/mock routes are never the real-route source and are not on the map', () => {
  const rows = routesPayload();
  for (const row of rows) {
    assert.equal(row.is_mock, 'True', 'demo rows stay mock');
    assert.ok(!('geometry' in row) && !('coordinates' in row), `${row.route_id} carries no map geometry`);
  }
  const real = parseRoutesResponse(OSRM_ROUTES);
  for (const r of real) {
    assert.ok(r.geometry.length >= 2, 'real routes carry provider geometry');
    assert.notEqual(r.source, 'mock', 'real routes never labelled mock');
  }
  assert.ok(!('road_score' in real[0]), 'real routes carry no Phase 9D/9E score');
});

test('leaflet is the only new dependency and MapView wires its CSS', () => {
  const frontend = join(__dirname, '..');
  const pkg = JSON.parse(readFileSync(join(frontend, 'package.json'), 'utf-8'));
  assert.ok(pkg.dependencies.leaflet, 'leaflet installed as a dependency');
  const mapViewSource = readFileSync(
    join(frontend, 'src', 'components', 'MapView.jsx'),
    'utf-8'
  );
  assert.match(mapViewSource, /leaflet\/dist\/leaflet\.css/);
  assert.match(mapViewSource, /map-container/);
  assert.ok(existsSync(join(frontend, 'node_modules', 'leaflet')), 'leaflet module present');
});

test('App orchestration async analysis wires the real provider and analysisReady', () => {
  const appSource = readFileSync(join(__dirname, '..', 'src', 'App.jsx'), 'utf-8');
  assert.match(appSource, /createLocationService\(\)/);
  assert.match(appSource, /analysisReady/);
  assert.match(appSource, /RealRouteSection/);
  assert.match(appSource, /analysisStatus=\{analysis\.status\}/);
  assert.match(appSource, /errorKindFor\(error\)/);
  assert.match(appSource, /selectedRealRouteId/);
});

// ---------------- Phase 9F-4 Part 3: live weather provider ----------------

const LIVE_WEATHER_OK = {
  latitude: 12.9,
  longitude: 80.11,
  current: {
    time: '2026-09-17T16:45',
    temperature_2m: 34.5,
    weather_code: 1,
    precipitation: 0.0,
    wind_speed_10m: 6.6,
    wind_direction_10m: 193,
    relative_humidity_2m: 49,
  },
};

const LIVE_WEATHER_NO_DATA = {
  latitude: 12.9,
  longitude: 80.11,
};

const weatherJsonOk = (payload) => ({ ok: true, status: 200, json: async () => payload });

test('weather provider endpoints use only the documented Open-Meteo public API (no invented API)', () => {
  const url = weatherUrl(12.925, 80.113);
  assert.ok(url.startsWith('https://api.open-meteo.com/v1/forecast?'), 'Open-Meteo public endpoint');
  assert.ok(url.includes('latitude=12.925'), 'latitude param');
  assert.ok(url.includes('longitude=80.113'), 'longitude param');
  assert.ok(url.includes('timezone=auto'), 'timezone param');
  assert.ok(!url.includes('api_key'), 'no API key required');
  assert.equal(WEATHER_PROVIDER.name, 'Open-Meteo (no API key)');
});

test('WMO weather codes parse into readable descriptions', () => {
  assert.equal(weatherCodeDescription(0), 'Clear sky');
  assert.equal(weatherCodeDescription(1), 'Mainly clear');
  assert.equal(weatherCodeDescription(2), 'Partly cloudy');
  assert.equal(weatherCodeDescription(3), 'Overcast');
  assert.equal(weatherCodeDescription(63), 'Moderate rain');
  assert.equal(weatherCodeDescription(95), 'Thunderstorm (slight/moderate)');
  assert.equal(weatherCodeDescription('bad'), 'Unknown');
});

test('wind direction degrees map to compass labels', () => {
  assert.equal(windDirectionLabel(0), 'N');
  assert.equal(windDirectionLabel(22), 'N', '22° rounds to N');
  assert.equal(windDirectionLabel(45), 'NE');
  assert.equal(windDirectionLabel(90), 'E');
  assert.equal(windDirectionLabel(180), 'S');
  assert.equal(windDirectionLabel(270), 'W');
  assert.equal(windDirectionLabel(315), 'NW');
  assert.equal(windDirectionLabel(338), 'N', '338° rounds to N');
  assert.equal(windDirectionLabel(360), 'N');
  assert.equal(windDirectionLabel(null), null);
  assert.equal(windDirectionLabel(undefined), null);
});

test('isValidCoordinate rejects missing / out-of-range coordinates', () => {
  assert.equal(isValidCoordinate(12.9, 80.11), true);
  assert.equal(isValidCoordinate(0, 0), true);
  assert.equal(isValidCoordinate(-90, -180), true);
  assert.equal(isValidCoordinate(91, 80), false, 'latitude out of range');
  assert.equal(isValidCoordinate(12.9, 181), false, 'longitude out of range');
  assert.equal(isValidCoordinate(null, 80), false);
  assert.equal(isValidCoordinate(12.9, undefined), false);
  assert.equal(isValidCoordinate(Number.NaN, 80), false);
});

test('parseWeatherResponse extracts all live-weather fields from an Open-Meteo response', () => {
  const parsed = parseWeatherResponse(LIVE_WEATHER_OK);
  assert.ok(parsed, 'response parsed');
  assert.equal(parsed.temperatureC, 34.5);
  assert.equal(parsed.weatherCode, 1);
  assert.equal(parsed.description, 'Mainly clear');
  assert.equal(parsed.precipitationMm, 0);
  assert.equal(parsed.windSpeedKmh, 6.6);
  assert.equal(parsed.windDirectionDeg, 193);
  assert.equal(parsed.humidityPct, 49);
  assert.equal(parsed.asOf, '2026-09-17T16:45');
  assert.equal(parsed.latitude, 12.9);
  assert.equal(parsed.longitude, 80.11);
});

test('parseWeatherResponse returns null for missing or unusable responses', () => {
  assert.equal(parseWeatherResponse(null), null);
  assert.equal(parseWeatherResponse({}), null);
  assert.equal(parseWeatherResponse(LIVE_WEATHER_NO_DATA), null, 'no current object');
});

test('weatherUiState: LIVE only on success; IDLE for null/undefined; UNAVAILABLE otherwise', () => {
  const live = weatherUiState('ready');
  assert.equal(live.status, 'LIVE');
  assert.match(live.note, /retrieved on demand/);
  for (const kind of [null, undefined]) {
    const idle = weatherUiState(kind);
    assert.equal(idle.status, 'IDLE', `kind=${kind} yields IDLE`);
    assert.notEqual(idle.status, 'LIVE', `kind=${kind} never yields LIVE`);
  }
  for (const kind of ['network', 'http', 'no-data', 'invalid-coordinates', 'anything']) {
    const u = weatherUiState(kind);
    assert.equal(u.status, 'UNAVAILABLE', `kind=${kind} yields UNAVAILABLE`);
  }
});

test('weatherErrorKindFor maps exceptions to deterministic error kinds', () => {
  assert.equal(weatherErrorKindFor({ code: 'invalid-coordinates' }), 'invalid-coordinates');
  assert.equal(weatherErrorKindFor({ code: 'http' }), 'http');
  assert.equal(weatherErrorKindFor({ code: 'no-data' }), 'no-data');
  assert.equal(weatherErrorKindFor({ code: 'network' }), 'network');
  assert.equal(weatherErrorKindFor(new Error('offline')), 'network');
});

test('weather service fetches live Open-Meteo data with a mocked provider and never touches Phase 9B data', async () => {
  const calls = [];
  const mockFetch = async (url) => {
    calls.push(url);
    return weatherJsonOk(LIVE_WEATHER_OK);
  };
  const service = createWeatherService({ fetchImpl: mockFetch });
  const result = await service.getCurrentWeather({ lat: 12.9251, lon: 80.1131 });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('open-meteo.com'), 'calls Open-Meteo only');
  assert.equal(result.temperatureC, 34.5);
  assert.equal(result.description, 'Mainly clear');
  assert.equal(result.provider, 'Open-Meteo (no API key)');
  assert.equal(result.windSpeedKmh, 6.6);
});

test('weather service surfaces fetch failures as error kinds, never invents weather', async () => {
  const offline = createWeatherService({
    fetchImpl: async () => { throw new Error('offline'); },
  });
  await assert.rejects(
    offline.getCurrentWeather({ lat: 12, lon: 80 }),
    (err) => { assert.equal(weatherErrorKindFor(err), 'network'); return true; }
  );
  const httpFail = createWeatherService({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(
    httpFail.getCurrentWeather({ lat: 12, lon: 80 }),
    (err) => { assert.equal(weatherErrorKindFor(err), 'http'); return true; }
  );
  const noData = createWeatherService({
    fetchImpl: async () => weatherJsonOk(LIVE_WEATHER_NO_DATA),
  });
  await assert.rejects(
    noData.getCurrentWeather({ lat: 12, lon: 80 }),
    (err) => { assert.equal(weatherErrorKindFor(err), 'no-data'); return true; }
  );
});

test('weather service rejects invalid coordinates without calling the network', async () => {
  const calls = [];
  const service = createWeatherService({
    fetchImpl: async (url) => { calls.push(url); return weatherJsonOk(LIVE_WEATHER_OK); },
  });
  await assert.rejects(
    service.getCurrentWeather({ lat: null, lon: 80 }),
    (err) => { assert.equal(err.code, 'invalid-coordinates'); return true; }
  );
  await assert.rejects(
    service.getCurrentWeather({ lat: 12, lon: undefined }),
    (err) => { assert.equal(err.code, 'invalid-coordinates'); return true; }
  );
  assert.equal(calls.length, 0, 'no network calls for invalid coordinates');
});

test('weather refreshes for a new destination with different coordinates', async () => {
  const calls = [];
  const mockFetch = async (url) => {
    calls.push(url);
    if (calls.length === 1) {
      return weatherJsonOk({ ...LIVE_WEATHER_OK, current: { ...LIVE_WEATHER_OK.current, temperature_2m: 28.0 } });
    }
    return weatherJsonOk({ ...LIVE_WEATHER_OK, current: { ...LIVE_WEATHER_OK.current, temperature_2m: 31.2 } });
  };
  const service = createWeatherService({ fetchImpl: mockFetch });
  const first = await service.getCurrentWeather({ lat: 12.9, lon: 80.11 });
  const second = await service.getCurrentWeather({ lat: 13.08, lon: 80.27 });
  assert.equal(calls.length, 2);
  assert.ok(calls[0] !== calls[1], 'different URLs for different coordinates');
  assert.equal(first.temperatureC, 28.0);
  assert.equal(second.temperatureC, 31.2);
});

test('weather provider is independent of Phase 9B evidence data and never imports it', () => {
  const source = readFileSync(
    join(__dirname, '..', 'src', 'services', 'weatherProvider.js'),
    'utf-8'
  );
  assert.ok(!source.includes('dataService'), 'weatherProvider never references dataService');
  assert.ok(!source.includes('weather.json'), 'weatherProvider never references the Phase 9B JSON');
  assert.ok(!source.includes('phase9b'), 'weatherProvider never references phase9b');
  assert.match(source, /OPEN-METEO|open-meteo/i, 'explicitly uses Open-Meteo');
});

test('weather state does not silently fall back to historical Phase 9B data on failure', () => {
  const appSource = readFileSync(join(__dirname, '..', 'src', 'App.jsx'), 'utf-8');
  assert.match(appSource, /weatherErrorKindFor\(error\)/, 'errors mapped to UNAVAILABLE, never to getWeather()');
  assert.match(appSource, /status: 'unavailable'/, 'failure sets unavailable status');
  assert.doesNotMatch(appSource, /getWeather.*kind|kind.*getWeather/, 'no fallback path between weather provider and Phase 9B getWeather');
});

test('App wires live weather section with weather state, coords, and destination name', () => {
  const appSource = readFileSync(join(__dirname, '..', 'src', 'App.jsx'), 'utf-8');
  assert.match(appSource, /createWeatherService\(\)/);
  assert.match(appSource, /CurrentWeatherSection/);
  assert.match(appSource, /loadWeatherFor/);
  assert.match(appSource, /weather=\{weather\}/);
  assert.match(appSource, /destinationResolved/);
});

// ---------------- Phase 9F-4 Part 4: AI assistant ----------------

test('assistant parses origin + destination from natural trip requests', () => {
  const cases = [
    ['I want to go from Chennai to Madurai', 'Chennai', 'Madurai'],
    ['route from A to B', 'A', 'B'],
    ['take me from Madurai to Rameswaram', 'Madurai', 'Rameswaram'],
    ['how do I get from X to Y', 'X', 'Y'],
    ['I need to travel from Chennai to Coimbatore', 'Chennai', 'Coimbatore'],
    ['from Chennai to Madurai please', 'Chennai', 'Madurai'],
    ['Plan a trip from Chennai to Madurai', 'Chennai', 'Madurai'],
  ];
  for (const [text, origin, destination] of cases) {
    assert.deepEqual(
      extractTripPlaces(text),
      { kind: 'trip', origin, destination },
      `expected "${text}" to parse as trip`
    );
  }
});

test('assistant parses destination-only requests and asks for origin', () => {
  assert.deepEqual(extractTripPlaces('Take me to Madurai'), {
    kind: 'destination-only',
    destination: 'Madurai',
  });
  assert.deepEqual(extractTripPlaces('I need to go to Rameswaram'), {
    kind: 'destination-only',
    destination: 'Rameswaram',
  });
  const reply = buildReply('Take me to Madurai', {});
  assert.match(reply.reply, /destination/i);
  assert.match(reply.reply, /origin/i);
  assert.equal(reply.action, null, 'destination-only request never invents an action');
});

test('assistant parses origin-only requests and asks for destination', () => {
  assert.deepEqual(extractTripPlaces('Where can I go from Chennai?'), {
    kind: 'origin-only',
    origin: 'Chennai',
  });
  const reply = buildReply('Where can I go from Chennai?', {});
  assert.match(reply.reply, /destination/i);
  assert.equal(reply.action, null, 'origin-only request never invents an action');
});

test('assistant classifies route, weather, cctv, help, unknown and empty intents', () => {
  assert.equal(classifyIntent('Show my current route'), INTENT.route);
  assert.equal(classifyIntent('Show the route'), INTENT.route);
  assert.equal(classifyIntent("What's the weather?"), INTENT.weather);
  assert.equal(classifyIntent('temperature in the city'), INTENT.weather);
  assert.equal(classifyIntent('Help me investigate CCTV'), INTENT.cctv);
  assert.equal(classifyIntent('any camera footage changed?'), INTENT.cctv);
  assert.equal(classifyIntent('what can you do?'), INTENT.help);
  assert.equal(classifyIntent('how many lemons fit in a car'), INTENT.unknown);
  assert.equal(classifyIntent(''), INTENT.empty);
  assert.equal(classifyIntent('   '), INTENT.empty);
});

test('trip intent emits SET_TRIP action and keeps existing trip state as source of truth', () => {
  const state = { origin: '', destination: '' };
  const result = buildReply('route from Chennai to Madurai', state);
  assert.deepEqual(result.action, { type: 'SET_TRIP', origin: 'Chennai', destination: 'Madurai' });
  assert.match(result.reply, /run route analysis/i);
  assert.match(result.reply, /real geographic route/i);

  const already = buildReply('route from Chennai to Madurai', {
    origin: 'Chennai',
    destination: 'Madurai',
  });
  assert.equal(already.action, null, 'no re-set when trip already matches current state');
  assert.match(already.reply, /already set/i);
});

test('assistant mock-route disclaimer never presents fictional roads as real geography', () => {
  const result = buildReply('route from Chennai to Madurai', {});
  assert.match(result.reply, /mock/i);
  assert.match(result.reply, /real geographic/i);
});

test('assistant route reply uses current real analysis, not fabricated data', () => {
const result = buildReply('Show my current route', {
    trip: { origin: 'Chennai', destination: 'Madurai' },
    analysisStatus: 'ready',
    analysis: { routes: [{ id: 'real-route-1', distanceKm: 11.2, durationMin: 18 }] },
    selectedRealRoute: { id: 'real-route-1', distanceKm: 11.2, durationMin: 18 },
  });
  assert.equal(result.action.type, 'SHOW_ROUTE');
  assert.match(result.reply, /Real Route \/ Map/i);
  assert.match(result.reply, /OSRM/i);
  assert.match(result.reply, /11.2 km/);
  assert.match(result.reply, /not a mock route/i);
});

test('assistant says no trip analyzed instead of fabricating a route', () => {
  const result = buildReply('Show my current route', { trip: null, analysisStatus: 'idle' });
  assert.match(result.reply, /No trip/i);
  assert.equal(result.action, null);
});

test('assistant weather reply is LIVE only when the live provider succeeded', () => {
  const live = buildReply("What's the weather?", {
    weather: {
      status: 'ready',
      data: {
        temperatureC: 34.5,
        description: 'Mainly clear',
        precipitationMm: 0,
        windSpeedKmh: 6.6,
        asOf: '2026-09-17T16:45',
      },
    },
  });
  assert.match(live.reply, /LIVE/);
  assert.match(live.reply, /34.5°C/);
  assert.match(live.reply, /Mainly clear/i);
  assert.equal(live.action.type, 'SHOW_WEATHER');
});

test('assistant never substitutes Phase 9B weather when live weather is unavailable', () => {
  const result = buildReply("What's the weather?", {
    weather: { status: 'unavailable', kind: 'network', data: null },
  });
  assert.match(result.reply, /UNAVAILABLE/);
  assert.match(result.reply, /Phase 9B/);
  assert.doesNotMatch(result.reply, /\d+°C/, 'no invented temperature');
});

test('assistant CCTV responses respect the Part 1 gating rules and never auto-select', () => {
  const noRoute = buildReply('Help me investigate CCTV', {
    cctvPolicy: { kind: 'no-route', resources: [] },
  });
  assert.match(noRoute.reply, /select a demo route candidate/i);
  assert.equal(noRoute.action.type, 'OPEN_INVESTIGATION', 'only navigates, never selects');

  const withRoute = buildReply('Help me investigate CCTV', {
    cctvPolicy: {
      kind: 'route-selected',
      resources: [{ id: 'DEMO-CCTV-01' }, { id: 'DEMO-CCTV-03' }],
    },
  });
  assert.match(withRoute.reply, /DEMO-CCTV-01, DEMO-CCTV-03/);
  assert.match(withRoute.reply, /not live CCTV/i);
  assert.doesNotMatch(withRoute.reply, /DEMO-CCTV-02/, 'only lists route-relevant resources');
  assert.doesNotMatch(withRoute.reply, /lat|lon|coordinate/i, 'no invented CCTV coordinates');
});

test('createAssistantService emits actions via emitAction and returns replies', () => {
  const emitted = [];
  const service = createAssistantService({
    state: { origin: '', destination: '' },
    emitAction: (action) => emitted.push(action),
  });
const result = service.handleMessage('route from Chennai to Madurai');
  assert.deepEqual(emitted, [{ type: 'SET_TRIP', origin: 'Chennai', destination: 'Madurai' }]);
  assert.ok(result.reply.length > 0);
  assert.equal(service.mode.label, 'LOCAL ASSISTANT');
});

test('createAssistantService reads the latest state via getState (no stale closure)', () => {
  let state = { weather: { status: 'idle', kind: null, data: null } };
  const service = createAssistantService({ getState: () => state });
  const before = service.handleMessage("What's the weather?").reply;
  assert.match(before, /UNAVAILABLE/);
  state = {
    weather: {
      status: 'ready',
      data: { temperatureC: 27.1, description: 'Partly cloudy', precipitationMm: 0, windSpeedKmh: 12.0, asOf: 'x' },
    },
  };
  const after = service.handleMessage("What's the weather?").reply;
  assert.match(after, /LIVE/);
  assert.match(after, /27.1°C/);
});

test('assistant is LOCAL mode with no external LLM, no API key, and no branded model', () => {
  assert.equal(ASSISTANT_MODE.label, 'LOCAL ASSISTANT');
  assert.equal(ASSISTANT_MODE.provider, null);
  const source = readFileSync(join(__dirname, '..', 'src', 'services', 'aiAssistant.js'), 'utf-8');
  assert.doesNotMatch(source, /apiKey|api_key|openai|gpt|gemini|claude|anthropic/i);
  assert.match(source, /LOCAL ASSISTANT/);
  const section = readFileSync(join(__dirname, '..', 'src', 'components', 'AIAssistantSection.jsx'), 'utf-8');
  assert.match(section, /ASSISTANT_MODE\.label/);
  assert.match(section, /LOCAL ASSISTANT/);
});

test('assistant never duplicates control-centre state or imports data services', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'services', 'aiAssistant.js'), 'utf-8');
  assert.doesNotMatch(source, /import .*dataService/);
  assert.doesNotMatch(source, /getRoutes\(|getWeather\(|getLevel8\(|getTraffic\(|getRoadScores\(|getRoadConditions\(/);
  const result = buildReply('route from A to B', {});
  assert.deepEqual(result.action, { type: 'SET_TRIP', origin: 'A', destination: 'B' });
});

test('App wires the AI assistant and keeps trip inputs as the single source of truth', () => {
  const appSource = readFileSync(join(__dirname, '..', 'src', 'App.jsx'), 'utf-8');
  assert.match(appSource, /createAssistantService/);
  assert.match(appSource, /AIAssistantSection/);
  assert.match(appSource, /handleAssistantAction/);
  assert.match(appSource, /SET_TRIP/);
  assert.match(appSource, /REQUEST_ROUTE_ANALYSIS/);
  assert.doesNotMatch(appSource, /selectedResourceId\s*=\s*['"]DEMO-CCTV/, 'assistant must not auto-select CCTV');
  const tripSource = readFileSync(join(__dirname, '..', 'src', 'components', 'TripPlanningSection.jsx'), 'utf-8');
  assert.match(tripSource, /value=\{origin\}/, 'origin input controlled by App');
  assert.match(tripSource, /value=\{destination\}/, 'destination input controlled by App');
});

// ---------------- Phase 9F-4 Part 5: voice assistant ----------------

const makeFakeRecognitionFactory = () => {
  let instances = [];
  const factory = () => {
    const inst = {
      lang: '',
      interimResults: true,
      continuous: true,
      maxAlternatives: 3,
      started: false,
      aborted: false,
      start() {
        inst.started = true;
      },
      abort() {
        inst.aborted = true;
      },
      stop() {
        inst.aborted = true;
      },
    };
    instances.push(inst);
    return inst;
  };
  factory.instances = instances;
  return factory;
};

const makeFakeSynthesis = () => {
  const utterances = [];
  const calls = { cancel: 0, speak: 0 };
  const speechSynthesis = {
    cancel() {
      calls.cancel += 1;
    },
    speak(u) {
      calls.speak += 1;
      utterances.push(u);
    },
  };
  function Utterance(text) {
    this.text = text;
    this.lang = '';
    this.onend = null;
    this.onerror = null;
  }
  return { speechSynthesis, Utterance, utterances, calls };
};

test('voice service module exists with createVoiceAssistantService and voice constants', () => {
  assert.equal(typeof createVoiceAssistantService, 'function');
  assert.equal(VOICE_LABELS[VOICE_STATE.IDLE], 'VOICE READY');
  assert.equal(VOICE_LABELS[VOICE_STATE.LISTENING], 'VOICE LISTENING');
  assert.equal(VOICE_LABELS[VOICE_STATE.SPEAKING], 'VOICE SPEAKING');
  assert.equal(VOICE_MODE_LABELS[VOICE_MODE.BROWSER_NATIVE], 'VOICE BROWSER FALLBACK');
  assert.equal(VOICE_MODE_LABELS[VOICE_MODE.UNAVAILABLE], 'VOICE UNAVAILABLE');
});

test('browser recognition capability detection uses SpeechRecognition then webkit fallback', () => {
  class NativeRecognition {}
  const withNative = detectRecognitionSupport({
    SpeechRecognition: NativeRecognition,
    webkitSpeechRecognition: null,
  });
  assert.deepEqual(withNative, { supported: true, api: 'SpeechRecognition' });

  const withWebkit = detectRecognitionSupport({ webkitSpeechRecognition: NativeRecognition });
  assert.deepEqual(withWebkit, { supported: true, api: 'webkitSpeechRecognition' });

  const none = detectRecognitionSupport({});
  assert.deepEqual(none, { supported: false, api: null });
  assert.deepEqual(detectRecognitionSupport(undefined), { supported: false, api: null });
});

test('browser speech synthesis capability detection', () => {
  const ok = detectSpeechSynthesisSupport({
    speechSynthesis: {},
    SpeechSynthesisUtterance: function () {},
  });
  assert.equal(ok.supported, true);
  assert.equal(detectSpeechSynthesisSupport({ speechSynthesis: {} }).supported, false);
  assert.equal(detectSpeechSynthesisSupport({}).supported, false);
  assert.equal(detectSpeechSynthesisSupport(undefined).supported, false);
});

test('voice mode resolves to BROWSER_NATIVE or UNAVAILABLE (no API claimed)', () => {
  class Recognition {}
  assert.equal(
    detectVoiceMode({ SpeechRecognition: Recognition, speechSynthesis: {}, SpeechSynthesisUtterance: function () {} }),
    VOICE_MODE.BROWSER_NATIVE
  );
  assert.equal(detectVoiceMode({ SpeechRecognition: Recognition }), VOICE_MODE.BROWSER_NATIVE);
  assert.equal(detectVoiceMode({}), VOICE_MODE.UNAVAILABLE);
  assert.equal(detectVoiceMode(undefined), VOICE_MODE.UNAVAILABLE);
});

test('voice defaults to en-IN and configures a single-shot recognizer', () => {
  const factory = makeFakeRecognitionFactory();
  const service = createVoiceAssistantService({
    recognitionCtor: factory,
    speechSynthesis: null,
    utteranceCtor: null,
  });
  assert.equal(service.language, DEFAULT_LANGUAGE);
  assert.equal(service.language, 'en-IN');
  assert.equal(service.supported.recognition, true);
  assert.equal(service.supported.speechSynthesis, false);
  assert.equal(service.start(), true);
  assert.equal(service.state, VOICE_STATE.LISTENING);
  const rec = factory.instances[factory.instances.length - 1];
  assert.equal(rec.lang, 'en-IN');
  assert.equal(rec.interimResults, false);
  assert.equal(rec.continuous, false, 'voice is a single command, never indefinite listening');
  assert.equal(rec.maxAlternatives, 1);
});

test('recognized transcript is forwarded exactly once through onTranscript', () => {
  const factory = makeFakeRecognitionFactory();
  const seen = [];
  const service = createVoiceAssistantService({
    recognitionCtor: factory,
    onTranscript: (text) => seen.push(text),
  });
  service.start();
  const rec = factory.instances[0];
  rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'route from A to B' } }] });
  assert.deepEqual(seen, ['route from A to B']);
  rec.onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'route' } }] });
  rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'route from A to B' } }] });
  assert.equal(seen.length, 1, 'a second final result must not be processed again');
  assert.equal(service.state, VOICE_STATE.IDLE);
});

test('stop listening is safe from any state and aborts the recognizer', () => {
  const factory = makeFakeRecognitionFactory();
  const service = createVoiceAssistantService({ recognitionCtor: factory });
  assert.doesNotThrow(() => service.stop(), 'stopping while idle must not throw');
  service.start();
  const rec = factory.instances[0];
  service.stop();
  assert.equal(rec.aborted, true);
  assert.equal(service.state, VOICE_STATE.IDLE);
  assert.doesNotThrow(() => service.stop(), 'double-stop must be safe');
});

test('listening starts only once and refuses a second concurrent start', () => {
  const factory = makeFakeRecognitionFactory();
  const service = createVoiceAssistantService({ recognitionCtor: factory });
  assert.equal(service.start(), true);
  assert.equal(service.start(), false, 'already listening must be ignored');
  assert.equal(factory.instances.length, 1);
});

test('unsupported recognition yields UNAVAILABLE with a friendly error, not a crash', () => {
  const errors = [];
  const service = createVoiceAssistantService({
    recognitionCtor: null,
    speechSynthesis: null,
    utteranceCtor: null,
    onError: (m) => errors.push(m),
  });
  assert.equal(service.mode, VOICE_MODE.UNAVAILABLE);
  assert.equal(service.start(), false);
  assert.equal(service.state, VOICE_STATE.UNAVAILABLE);
  assert.ok(errors.length === 1);
  assert.match(errors[0], /text chat/);
});

test('speech synthesis speaks the reply and returns to IDLE on end or error', () => {
  const { speechSynthesis, Utterance, utterances } = makeFakeSynthesis();
  const service = createVoiceAssistantService({
    recognitionCtor: null,
    speechSynthesis,
    utteranceCtor: Utterance,
  });
  assert.equal(service.supported.speechSynthesis, true);
  assert.equal(service.speak('I understood your trip.'), true);
  assert.equal(service.state, VOICE_STATE.SPEAKING);
  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].text, 'I understood your trip.');
  assert.equal(utterances[0].lang, 'en-IN');
  utterances[0].onend();
  assert.equal(service.state, VOICE_STATE.IDLE);

  assert.equal(service.speak('Again.'), true);
  const utter2 = utterances[1];
  utter2.onerror();
  assert.equal(service.state, VOICE_STATE.IDLE, 'synthesis failure is non-fatal');
});

test('speech synthesis unavailable does not break chat or the assistant reply path', () => {
  const service = createVoiceAssistantService({
    recognitionCtor: null,
    speechSynthesis: null,
    utteranceCtor: null,
  });
  assert.equal(service.speak('hello'), false);
  assert.equal(service.cancelSpeech(), true);
  const appSource = readFileSync(join(__dirname, '..', 'src', 'App.jsx'), 'utf-8');
  assert.match(appSource, /onProcess=\{handleAssistantMessage\}/, 'App keeps the single Part 4 onProcess path');
  const sectionSource = readFileSync(join(__dirname, '..', 'src', 'components', 'AIAssistantSection.jsx'), 'utf-8');
  assert.match(sectionSource, /onProcessRef\.current\(text\)/, 'transcript is sent through the existing assistant');
});

test('microphone controls exist with accessible labels and speak toggle', () => {
  const sectionSource = readFileSync(join(__dirname, '..', 'src', 'components', 'AIAssistantSection.jsx'), 'utf-8');
  assert.match(sectionSource, /Start Voice/);
  assert.match(sectionSource, /Stop Listening/);
  assert.match(sectionSource, /Speak responses/);
  assert.match(sectionSource, /start voice command|Stop listening/i);
  assert.match(sectionSource, /aria-live/);
  assert.match(sectionSource, /voiceInstance\.start\(\)/);
});

test('voice layer has no duplicate assistant parser and no control-centre state', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'services', 'voiceAssistant.js'), 'utf-8');
  assert.doesNotMatch(source, /classifyIntent|extractTripPlaces|buildReply|SET_TRIP|REQUEST_ROUTE_ANALYSIS|SHOW_WEATHER|OPEN_INVESTIGATION/);
  assert.doesNotMatch(source, /import .*aiAssistant|import .*dataService|import .*controlCenter|import .*weatherProvider|import .*locationProviders/);
  assert.doesNotMatch(source, /setOrigin|setDestination|setWeather|setTrip|setSelectedResourceId|getRoutes\(|getWeather\(/);
});

test('voice errors are user-friendly and never leak raw exceptions', () => {
  assert.match(mapVoiceError('not-allowed'), /Microphone permission was denied/);
  assert.match(mapVoiceError('permission-denied'), /text chat/);
  assert.match(mapVoiceError('no-speech'), /No speech was detected/);
  assert.match(mapVoiceError('network'), /text chat/);
  assert.match(mapVoiceError('whatever-unknown'), /Voice is not available/);
  assert.doesNotMatch(mapVoiceError('whatever-unknown'), /TypeError|not a function|undefined/);
});

test('voice failure never modifies trip/weather/CCTV source of truth', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'services', 'voiceAssistant.js'), 'utf-8');
  assert.doesNotMatch(source, /import .*controlCenter|import .*dataService|import .*aiAssistant|import .*weatherProvider|import .*locationProviders/);
  assert.doesNotMatch(source, /setOrigin|setDestination|setWeather|setTrip|setSelectedResourceId|setSelectedRouteId/);
  const sectionSource = readFileSync(join(__dirname, '..', 'src', 'components', 'AIAssistantSection.jsx'), 'utf-8');
  assert.doesNotMatch(sectionSource, /handleAssistantAction/, 'component never calls App actions directly');
  assert.doesNotMatch(sectionSource, /classifyIntent|extractTripPlaces|buildReply/, 'component never parses commands itself');
  const appSource = readFileSync(join(__dirname, '..', 'src', 'App.jsx'), 'utf-8');
  assert.match(appSource, /voiceService=\{voiceService\}/, 'App injects the voice service');
  assert.doesNotMatch(appSource, /voiceService\.setOrigin|voiceService\.weather|voiceService\.trip/);
});

// ---------------- Phase 9F-4 Part 6: scenario simulation + polish ----------------

test('scenario simulator exists with documented constants', () => {
  assert.equal(typeof runScenario, 'function');
  assert.equal(typeof scenarioUiState, 'function');
  assert.equal(typeof renormalizeWeights, 'function');
  assert.deepEqual(
    Object.keys(LAYER_WEIGHTS).sort(),
    ['incident', 'road', 'traffic', 'weather']
  );
  assert.equal(MIN_KNOWN_WEIGHT, 0.5);
  assert.equal(LAYER_SCORES.traffic.LOW, 90);
  assert.equal(LAYER_SCORES.weather.CLEAR, 92);
  assert.equal(LAYER_SCORES.road.LOW, 88);
  assert.equal(LAYER_SCORES.incident.NONE, 100);
});

test('scenario calculation is deterministic', () => {
  const a = runScenario({ traffic: 'HEAVY', weather: 'MODERATE', road: 'HIGH', incident: 'NONE' });
  const b = runScenario({ traffic: 'HEAVY', weather: 'MODERATE', road: 'HIGH', incident: 'NONE' });
  assert.deepEqual(a, b);
});

test('LOW scenario equals the documented baseline with zero change', () => {
  const result = runScenario({
    traffic: 'LOW',
    weather: 'CLEAR',
    road: 'LOW',
    incident: 'NONE',
  });
  assert.equal(result.status, 'READY');
  assert.equal(result.baseline, 91);
  assert.equal(result.scenario, 91);
  assert.equal(result.change, 0);
});

test('MODERATE weather mapping lowers the simulated score deterministically', () => {
  const result = runScenario({ traffic: 'LOW', weather: 'MODERATE', road: 'LOW', incident: 'NONE' });
  assert.equal(result.scenario, 85);
  assert.equal(result.change, -6);
});

test('HEAVY traffic mapping lowers the simulated score deterministically', () => {
  const result = runScenario({ traffic: 'HEAVY', weather: 'CLEAR', road: 'LOW', incident: 'NONE' });
  assert.equal(result.scenario, 76);
  assert.equal(result.change, -15);
});

test('CONGESTED traffic mapping lowers the simulated score deterministically', () => {
  const result = runScenario({ traffic: 'CONGESTED', weather: 'CLEAR', road: 'LOW', incident: 'NONE' });
  assert.equal(result.scenario, 69);
  assert.equal(result.change, -22);
});

test('UNKNOWN weather is excluded, never treated as zero risk, and known weights are renormalised', () => {
  const result = runScenario({ traffic: 'LOW', weather: 'UNKNOWN', road: 'LOW', incident: 'NONE' });
  assert.equal(result.status, 'READY');
  assert.ok(Math.abs(result.knownWeight - 0.75) < 1e-9, `expected knownWeight 0.75, got ${result.knownWeight}`);
  const weatherLayer = result.layers.find((layer) => layer.key === 'weather');
  assert.equal(weatherLayer.score, null);
  assert.equal(weatherLayer.effectiveWeight, 0);
  const knownEff = result.layers.filter((layer) => layer.score !== null);
  const effSum = knownEff.reduce((sum, layer) => sum + layer.effectiveWeight, 0);
  assert.ok(Math.abs(effSum - 1) < 1e-9, 'known weights must be renormalised to sum 1');
  assert.equal(result.scenario, 91);
});

test('too little known information yields SIMULATION INCOMPLETE, never a fabricated score', () => {
  const result = runScenario({ traffic: 'LOW', weather: 'UNKNOWN', road: 'UNKNOWN', incident: 'UNKNOWN' });
  assert.equal(result.status, 'INCOMPLETE');
  assert.match(result.explanation, /SIMULATION INCOMPLETE/);
  assert.equal(typeof result.scenario, 'undefined');
});

test('no route produces simulation-incomplete / no-context state, never a fabricated route', () => {
  const none = scenarioUiState({ trip: null, analysisReady: false });
  assert.equal(none.kind, 'none');
  const noRoute = scenarioUiState({ trip: { origin: 'A', destination: 'B' }, analysisReady: false });
  assert.equal(noRoute.kind, 'none');
  assert.match(noRoute.reason, /Generate a real route first/);
});

test('mock route is explicitly marked MOCK and never treated as real', () => {
  const mock = scenarioUiState({
    trip: { origin: 'A', destination: 'B' },
    analysisReady: false,
    demoRoute: { route_id: 'MOCK-ROAD-1', recommendation_status: 'RECOMMENDED' },
  });
  assert.equal(mock.kind, 'mock');
  assert.equal(isMockRoute(mock.demoRoute), true);
});

test('a real route is never converted into a mock route', () => {
  const real = scenarioUiState({
    trip: { origin: 'A', destination: 'B' },
    analysisReady: true,
    realRoute: { id: 'real-route-1', distanceKm: 11.2, durationMin: 18 },
    demoRoute: null,
  });
  assert.equal(real.kind, 'real');
  assert.equal(isMockRoute(real.realRoute), false);
  assert.equal(isMockRoute({ route_id: 'REAL-ROUTE-1' }), false);
});

test('scenario explanation exists and explains the deterministic model', () => {
  const result = runScenario({ traffic: 'HEAVY', weather: 'MODERATE', road: 'HIGH', incident: 'NONE' });
  assert.equal(result.scenario, 60);
  assert.equal(result.change, -31);
  assert.ok(result.explanation.length > 0);
  assert.match(result.explanation, /decreases because/);
  assert.match(result.explanation, /heavy traffic/i);
  assert.match(result.explanation, /moderate weather/i);
  assert.match(result.explanation, /poor road condition/i);
  assert.match(result.explanation, /not a real-world prediction/i);
});

test('pipeline component exposes truthful stages for every pipeline step', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'components', 'SystemPipelineSection.jsx'), 'utf-8');
  assert.match(source, /YOLOv8n Detection/);
  assert.match(source, /ByteTrack Tracking/);
  assert.match(source, /Fragment Correction/);
  assert.match(source, /Traffic Intelligence/);
  assert.match(source, /Weather Intelligence/);
  assert.match(source, /Road Intelligence/);
  assert.match(source, /Route Analysis/);
  assert.match(source, /AI Assistant/);
  assert.match(source, /Voice Interface/);
  assert.match(source, /COMPLETED/);
  assert.match(source, /NOT labelled "LIVE AI"/i);
});

test('provenance legend labels LIVE, STATIC, MOCK, RECORDED and UNKNOWN', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'components', 'ProvenanceLegend.jsx'), 'utf-8');
  for (const label of ['LIVE', 'STATIC', 'MOCK', 'RECORDED', 'UNKNOWN']) {
    assert.match(source, new RegExp(label));
  }
});

test('the built UI marks SCENARIO SIMULATION, WHAT-IF, STATIC MODEL and DEMO explicitly', () => {
  const service = readFileSync(join(__dirname, '..', 'src', 'services', 'scenarioSimulator.js'), 'utf-8');
  assert.match(service, /SCENARIO SIMULATION/);
  assert.match(service, /WHAT-IF/);
  const section = readFileSync(join(__dirname, '..', 'src', 'components', 'ScenarioSimulationSection.jsx'), 'utf-8');
  assert.match(section, /SCENARIO_SUMMARY/);
  assert.match(section, /SIMULATED/);
  assert.match(section, /STATIC MODEL/);
  assert.match(section, /DEMO/);
  assert.match(section, /WHAT-IF/);
});

test('scenario intent lives inside the existing assistant (no second parser)', () => {
  assert.equal(classifyIntent('simulate heavy traffic'), INTENT.scenario);
  assert.equal(classifyIntent('run a scenario on my route'), INTENT.scenario);
  assert.equal(classifyIntent('what if traffic is congested'), INTENT.scenario);
  const reply = scenarioReply({ trip: { origin: 'A', destination: 'B' }, analysisStatus: 'ready', analysis: { routes: [{ id: 'r1' }] } }, 'simulate heavy traffic');
  assert.deepEqual(reply.action, { type: 'SIMULATE_SCENARIO', traffic: 'HEAVY' });
  assert.match(reply.reply, /what-if/);
  const noTrip = scenarioReply({ trip: null }, 'simulate heavy traffic');
  assert.match(noTrip.reply, /Generate a real route first/);
  const hint = scenarioTrafficHint('simulate congested traffic');
  assert.deepEqual(hint, { traffic: 'CONGESTED' });
  assert.deepEqual(scenarioTrafficHint('simulate heavy traffic'), { traffic: 'HEAVY' });
  const aiSource = readFileSync(join(__dirname, '..', 'src', 'services', 'aiAssistant.js'), 'utf-8');
  assert.match(aiSource, /INTENT\.scenario/);
  assert.doesNotMatch(aiSource, /import .*scenarioSimulator/, 'assistant never imports the simulator model');
});

test('voice still routes transcripts through the existing assistant path only', () => {
  const section = readFileSync(join(__dirname, '..', 'src', 'components', 'AIAssistantSection.jsx'), 'utf-8');
  assert.match(section, /onProcessRef\.current\(text\)/);
  assert.doesNotMatch(section, /import .*scenarioSimulator|import .*scenario/);
  assert.match(section, /voiceInstance\.speak\(replyText\)/);
});

test('no CCTV coordinates or fictional geography are fabricated anywhere new', () => {
  const files = {
    simulator: join(__dirname, '..', 'src', 'services', 'scenarioSimulator.js'),
    pipeline: join(__dirname, '..', 'src', 'components', 'SystemPipelineSection.jsx'),
    legend: join(__dirname, '..', 'src', 'components', 'ProvenanceLegend.jsx'),
    scenario: join(__dirname, '..', 'src', 'components', 'ScenarioSimulationSection.jsx'),
  };
  for (const [name, path] of Object.entries(files)) {
    const source = readFileSync(path, 'utf-8');
    assert.doesNotMatch(source, /\blat\b|\blon\b|coordinates\s*:/i, `${name} must not fabricate coordinates`);
    assert.doesNotMatch(source, /import .*MapView/, `${name} must not draw on the real map`);
  }
});

test('existing route engine and weather provider remain unchanged', () => {
  const loc = readFileSync(join(__dirname, '..', 'src', 'services', 'locationProviders.js'), 'utf-8');
  assert.match(loc, /router\.project-osrm\.org/);
  assert.match(loc, /photon\.komoot\.io/);
  const w = readFileSync(join(__dirname, '..', 'src', 'services', 'weatherProvider.js'), 'utf-8');
  assert.match(w, /api\.open-meteo\.com/);
  const sim = readFileSync(join(__dirname, '..', 'src', 'services', 'scenarioSimulator.js'), 'utf-8');
  assert.doesNotMatch(sim, /import .*dataService|import .*controlCenter|import .*weatherProvider|import .*locationProviders/, 'simulator is isolated from the real engines');
  const stats = readFileSync(join(__dirname, '..', 'src', 'services', 'dataService.js'), 'utf-8');
  assert.doesNotMatch(stats, /scenario/i, 'data layer untouched');
});

test('App wires scenario, pipeline, and provenance sections and the SIMULATE_SCENARIO action', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'App.jsx'), 'utf-8');
  assert.match(source, /ScenarioSimulationSection/);
  assert.match(source, /SystemPipelineSection/);
  assert.match(source, /ProvenanceLegend/);
  assert.match(source, /SIMULATE_SCENARIO/);
  assert.match(source, /scenarioRequest/);
  assert.match(source, /scenarioUiState/);
});

test('assistant evidence and intelligence commands navigate the four views', () => {
  const state = {
trip: { origin: 'Chennai', destination: 'Madurai' },
    analysisStatus: 'ready',
    analysis: { routes: [{ id: 'real-route-1', distanceKm: 10, durationMin: 20 }] },
    weather: { status: 'ready', kind: 'ready', data: { temperatureC: 34.5 } },
  };
  assert.equal(classifyIntent('Show evidence'), INTENT.evidence);
  assert.equal(classifyIntent('open intelligence'), INTENT.intelligence);
  assert.equal(classifyIntent('Open the evidence view'), INTENT.evidence);
  assert.equal(classifyIntent('show intelligence'), INTENT.intelligence);

  const ev = buildReply('Show evidence', state);
  assert.equal(ev.action.type, 'OPEN_EVIDENCE');
  assert.match(ev.reply, /Evidence/);

  const inl = buildReply('Open intelligence', state);
  assert.equal(inl.action.type, 'OPEN_INTELLIGENCE');
  assert.match(inl.reply, /Intelligence/);

  const cctv = buildReply('Help me investigate CCTV', state);
  assert.equal(cctv.action.type, 'OPEN_INVESTIGATION');
  const route = buildReply('Show my current route', state);
  assert.equal(route.action.type, 'SHOW_ROUTE');
const weatherIntent = buildReply("What's the weather?", state);
  assert.equal(weatherIntent.action.type, 'SHOW_WEATHER');
assert.match(HELP_TEXT, /show evidence/);
  assert.match(HELP_TEXT, /open intelligence/);
  assert.match(HELP_TEXT, /LOCAL ASSISTANT mode/i);
  assert.match(HELP_TEXT, /no external AI provider/i);
});

test('assistant "go back" returns the previous view via GO_BACK', () => {
  assert.equal(classifyIntent('Go back'), INTENT.back);
  assert.equal(classifyIntent('go to the previous view'), INTENT.back);
  assert.equal(classifyIntent('back'), INTENT.back);
  const result = buildReply('Go back', {});
  assert.deepEqual(result.action, { type: 'GO_BACK' });
  assert.match(result.reply, /previous view/i);
});

test('assistant "Show route 2" selects that live route without opening CCTV', () => {
  const state = {
    trip: { origin: 'Chennai', destination: 'Madurai' },
    analysisStatus: 'ready',
    analysis: {
      routes: [
        { id: 'real-route-1', name: 'Route via NH 48' },
        { id: 'real-route-2', name: 'Route via Madurai Road' },
        { id: 'real-route-3', name: 'Route via NH 38' },
      ],
    },
  };
  const result = buildReply('Show route 2', state);
  assert.equal(result.action.type, 'SELECT_ROUTE');
  assert.equal(result.action.routeIndex, 1);
  assert.equal(result.action.openInvestigation, undefined, 'route selection alone must not open CCTV');
  assert.match(result.reply, /Route via Madurai Road/);
  const plain = buildReply('Show my current route', state);
  assert.equal(plain.action.type, 'SHOW_ROUTE', 'no route number keeps SHOW_ROUTE');
});

test('assistant "Take me to Madurai" auto-analyzes only when current location is LIVE', () => {
  const live = buildReply('Take me to Madurai', {
    location: { status: 'live', coords: { lat: 9.92, lon: 78.12 } },
  });
  assert.equal(live.action.type, 'SET_TRIP');
  assert.equal(live.action.origin, 'My current location');
  assert.equal(live.action.destination, 'Madurai');
  assert.equal(live.action.autoAnalyze, true);
  assert.match(live.reply, /current location/i);
  const offline = buildReply('Take me to Madurai', {
    location: { status: 'denied', coords: null },
  });
  assert.equal(offline.action, null, 'no live location → never invents an origin');
  assert.match(offline.reply, /origin/i);
});

// ---------------- Phase 9F-4 Step 3: end-to-end assistant + voice control ----------------

const STEP3_ROUTES = [
  { id: 'real-route-1', name: 'Route via NH 48' },
  { id: 'real-route-2', name: 'Route via Madurai Road' },
  { id: 'real-route-3', name: 'Route via NH 38' },
];

const STEP3_STATE = {
  trip: { origin: 'Chennai', destination: 'Madurai' },
  analysisStatus: 'ready',
  analysis: { routes: STEP3_ROUTES },
  cctv: {
    byRoute: {
      'real-route-1': [{ id: 'CCTV-A01' }, { id: 'CCTV-A02' }, { id: 'CCTV-A03' }],
      'real-route-2': [{ id: 'CCTV-B01' }, { id: 'CCTV-B02' }, { id: 'CCTV-B03' }],
      'real-route-3': [{ id: 'CCTV-C01' }, { id: 'CCTV-C02' }, { id: 'CCTV-C03' }],
    },
  },
  cctvPolicy: {
    kind: 'route-selected',
    resources: [{ id: 'CCTV-B01' }, { id: 'CCTV-B02' }, { id: 'CCTV-B03' }],
  },
  recommendation: {
    routeId: 'real-route-2',
    routeName: 'Route via Madurai Road',
    score: 87.5,
    explanation: 'Low traffic across all demo segments.',
    why: 'Preferred over Route via NH 38 on observed traffic: HIGH (60/100) vs MODERATE (70/100).',
  },
  assessments: {
    'real-route-2': {
      explanation:
        'Route 2 shows congested activity. Simulated road condition (DEMO) is GOOD. Estimated drive time is 24 min over 12.4 km.',
    },
  },
  selectedRealRoute: { id: 'real-route-2', name: 'Route via Madurai Road' },
};

test('assistant classifies map navigation commands as INTENT.map and opens MAP / HOME', () => {
  for (const phrase of ['show map', 'go to map', 'back to map', 'open the map', 'show me the map', 'back to the map']) {
    assert.equal(classifyIntent(phrase), INTENT.map, `"${phrase}" is a map command`);
  }
  const result = buildReply('go to map', {});
  assert.deepEqual(result.action, { type: 'SHOW_ROUTE' }, 'map command reuses the existing SHOW_ROUTE action');
  assert.match(result.reply, /Map/i);
  assert.equal(classifyIntent('Go back'), INTENT.back, 'plain "go back" stays a back command');
  assert.equal(classifyIntent('show route 2'), INTENT.route, '"show route N" stays a route command');
});

test('assistant "show route 1/2/3" selects the matching provider route', () => {
  for (let i = 1; i <= 3; i += 1) {
    const result = buildReply(`show route ${i}`, STEP3_STATE);
    assert.deepEqual(result.action, { type: 'SELECT_ROUTE', routeIndex: i - 1 }, `route ${i} → index ${i - 1}`);
    assert.equal(result.action.openInvestigation, undefined, 'route selection alone never opens CCTV');
  }
});

test('assistant CCTV commands use route-specific registered registry cameras, never invented ones', () => {
  const route2 = buildReply('show CCTV for route 2', STEP3_STATE);
  assert.deepEqual(route2.action, { type: 'SELECT_ROUTE', routeIndex: 1, openInvestigation: true });
  assert.match(route2.reply, /Route via Madurai Road/);
  assert.match(route2.reply, /CCTV-B01/);
  assert.match(route2.reply, /CCTV-B02/);
  assert.match(route2.reply, /CCTV-B03/);
  assert.doesNotMatch(route2.reply, /CCTV-A01|CCTV-C01/, "never lists another route's cameras");
  assert.doesNotMatch(route2.reply, /Awaiting|placeholder/i, 'no stale awaiting-slot wording');
  assert.match(route2.reply, /RECORDED DEMO sources/i);

  const through = buildReply('show available CCTV footage through route 2', STEP3_STATE);
  assert.deepEqual(through.action, { type: 'SELECT_ROUTE', routeIndex: 1, openInvestigation: true });
  assert.match(through.reply, /CCTV-B01/);

  const route1 = buildReply('show CCTV for route 1', STEP3_STATE);
  assert.equal(route1.action.routeIndex, 0);
  assert.match(route1.reply, /CCTV-A01/);

  const generic = buildReply('show CCTV', STEP3_STATE);
  assert.equal(generic.action.type, 'OPEN_INVESTIGATION', 'generic "show CCTV" only opens the view, never auto-selects');
  assert.match(generic.reply, /CCTV-B01, CCTV-B02, CCTV-B03/);
});

test('assistant "show investigation" opens the Investigation/CCTV view', () => {
  assert.equal(classifyIntent('show investigation'), INTENT.cctv);
  const result = buildReply('show investigation', STEP3_STATE);
  assert.equal(result.action.type, 'OPEN_INVESTIGATION');
});

test('assistant recommendation reply comes only from tripIntel.recommendation including its why', () => {
  const which = buildReply('which route is recommended?', STEP3_STATE);
  assert.equal(which.action.type, 'SHOW_ROUTE');
  assert.match(which.reply, /Route via Madurai Road/);
  assert.match(which.reply, /87.5/);

  const why = buildReply('why is route 2 recommended?', STEP3_STATE);
  assert.equal(why.action.type, 'SHOW_ROUTE');
  assert.match(why.reply, /Why: Preferred over Route via NH 38/);
  assert.match(why.reply, /Selected route assessment:/);
  assert.match(why.reply, /Simulated road condition \(DEMO\) is GOOD/);

  const other = buildReply('why is this route recommended?', STEP3_STATE);
  assert.match(other.reply, /Route via Madurai Road/, '"this route" still answers from the existing recommendation');
});

test('assistant intelligence / evidence / weather navigation intents', () => {
  assert.equal(classifyIntent('show intelligence'), INTENT.intelligence);
  assert.equal(classifyIntent('show route intelligence'), INTENT.intelligence);
  assert.deepEqual(buildReply('show intelligence', {}).action, { type: 'OPEN_INTELLIGENCE' });
  assert.deepEqual(buildReply('show evidence', {}).action, { type: 'OPEN_EVIDENCE' });
  const weather = buildReply('show weather', { weather: { status: 'idle', kind: null, data: null } });
  assert.equal(weather.action.type, 'SHOW_WEATHER');
});

test('unknown assistant commands get a friendly response and never emit an action', () => {
  const emitted = [];
  const service = createAssistantService({
    state: STEP3_STATE,
    emitAction: (a) => emitted.push(a),
  });
  const result = service.handleMessage('how many lemons fit in a car');
  assert.equal(classifyIntent('how many lemons fit in a car'), INTENT.unknown);
  assert.match(result.reply, /couldn't parse|I couldn't parse|Try one of the prompts/i);
  assert.equal(result.action, null);
  assert.equal(emitted.length, 0, 'unknown input must not change application state');
});

test('empty transcript never emits an action and never changes application state', () => {
  const emitted = [];
  const service = createAssistantService({
    state: STEP3_STATE,
    emitAction: (a) => emitted.push(a),
  });
  for (const empty of ['', '   ', '\n\t ']) {
    const result = service.handleMessage(empty);
    assert.equal(classifyIntent(empty), INTENT.empty);
    assert.equal(result.action, null, 'empty input never produces an action');
  }
  assert.equal(emitted.length, 0, 'no action emitted for empty/whitespace input');
});

test('the assistant never contains its own scoring or recommendation computation', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'services', 'aiAssistant.js'), 'utf-8');
  assert.doesNotMatch(source, /rankRoutes\s*\(|assessRoute\s*\(|ROUTE_WEIGHTS|computeScore|weighted\s*=|totalWeight\s*=/);
  assert.match(source, /state\s*&&\s*state\.recommendation/, 'recommendation is only ever read from existing state');
  const appSource = readFileSync(join(__dirname, '..', 'src', 'App.jsx'), 'utf-8');
  assert.match(appSource, /recommendation: tripIntel \? tripIntel\.recommendation : null/);
});

test('voice transcript routes through the exact same assistant parser and action path as typed text', () => {
  const factory = makeFakeRecognitionFactory();
  let heard = '';
  const voice = createVoiceAssistantService({
    recognitionCtor: factory,
    onTranscript: (t) => {
      heard = t;
    },
  });
  const emitted = [];
  const assistant = createAssistantService({
    state: STEP3_STATE,
    emitAction: (a) => emitted.push(a),
  });

  voice.start();
  factory.instances[0].onresult({
    resultIndex: 0,
    results: [{ isFinal: true, 0: { transcript: 'show route 2' } }],
  });
  assert.equal(heard, 'show route 2', 'voice transcript captured');

  const viaVoice = assistant.handleMessage(heard);
  const viaTyped = buildReply('show route 2', STEP3_STATE);
  assert.deepEqual(viaVoice.action, viaTyped.action, 'voice and typed text reach the same deterministic action');
  assert.deepEqual(viaVoice.action, { type: 'SELECT_ROUTE', routeIndex: 1 });
  assert.deepEqual(emitted, [viaTyped.action], 'voice-driven action is applied through the same emitAction channel');

  const heardCctv = [];
  const voice2 = createVoiceAssistantService({
    recognitionCtor: factory,
    onTranscript: (t) => heardCctv.push(t),
  });
  voice2.start();
  const secondRec = factory.instances[factory.instances.length - 1];
  secondRec.onresult({
    resultIndex: 0,
    results: [{ isFinal: true, 0: { transcript: 'show CCTV for route 2' } }],
  });
  const cctvVoice = buildReply(heardCctv[0], STEP3_STATE);
  assert.deepEqual(cctvVoice.action, { type: 'SELECT_ROUTE', routeIndex: 1, openInvestigation: true });
});

test('microphone permission failure surfaces a friendly message and error state, never a crash', () => {
  const errors = [];
  const factory = makeFakeRecognitionFactory();
  const service = createVoiceAssistantService({
    recognitionCtor: factory,
    onError: (m) => errors.push(m),
  });
  assert.equal(service.start(), true);
  factory.instances[0].onerror({ error: 'not-allowed' });
  assert.equal(service.state, VOICE_STATE.ERROR);
  assert.ok(errors.length >= 1);
  assert.match(errors[0], /microphone permission/i);
  assert.doesNotMatch(errors[0], /TypeError|undefined|not a function/);
});

// ---------------------------------------------------------------------------
// Step: browser microphone startup fix — UNIT-LEVEL regressions only.
// These run against recognizer doubles; they prove the startup contract
// (new-instance construction, handlers-before-start, per-session isolation,
// friendly error mapping) but are NOT a substitute for a real-browser check.
// ---------------------------------------------------------------------------

test('recognition constructor is invoked with new (real-browser "Illegal constructor" regression)', () => {
  // Chrome's SpeechRecognition / webkitSpeechRecognition are IDL constructors:
  // calling one WITHOUT `new` throws "Illegal constructor", which surfaced to
  // users as "The microphone could not be started." A class-based constructor
  // reproduces that contract exactly.
  const instances = [];
  class RealCtorLike {
    constructor() {
      this.lang = '';
      this.interimResults = true;
      this.continuous = true;
      this.maxAlternatives = 3;
      this.started = false;
      instances.push(this);
    }
    start() { this.started = true; }
    abort() { this.aborted = true; }
    stop() { this.aborted = true; }
  }
  const service = createVoiceAssistantService({
    recognitionCtor: RealCtorLike,
    speechSynthesis: null,
    utteranceCtor: null,
  });
  assert.equal(service.start(), true, 'an IDL-style constructor must start without throwing');
  assert.equal(instances.length, 1);
  assert.equal(instances[0].lang, 'en-IN');
  assert.equal(instances[0].interimResults, false);
  assert.equal(instances[0].continuous, false);
  assert.equal(instances[0].maxAlternatives, 1);
});

test('all recognition event handlers are attached before start() is called', () => {
  const instances = [];
  const factory = () => {
    const inst = {
      lang: '',
      started: false,
      start() {
        if (!inst.onstart || !inst.onresult || !inst.onerror || !inst.onend || !inst.onnomatch) {
          throw new Error('start() must only run after every handler is attached');
        }
        inst.started = true;
      },
      abort() {},
      stop() {},
    };
    instances.push(inst);
    return inst;
  };
  const service = createVoiceAssistantService({ recognitionCtor: factory });
  assert.equal(service.start(), true);
  assert.equal(instances[0].started, true);
  assert.equal(service.state, VOICE_STATE.LISTENING);
});

test('stale recognizer events from a stopped session never affect the new session', () => {
  const factory = makeFakeRecognitionFactory();
  const errors = [];
  const service = createVoiceAssistantService({
    recognitionCtor: factory,
    onError: (m) => errors.push(m),
  });
  assert.equal(service.start(), true);
  service.stop();
  assert.equal(service.state, VOICE_STATE.IDLE);
  assert.equal(service.start(), true, 'a second session starts after stop');
  assert.equal(service.state, VOICE_STATE.LISTENING);

  const oldRec = factory.instances[0];
  oldRec.onerror({ error: 'not-allowed' });
  oldRec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'show route 2' } }] });
  oldRec.onend();
  assert.equal(service.state, VOICE_STATE.LISTENING, 'late events from the previous session are ignored');
  assert.deepEqual(errors, [], 'stale sessions never surface errors');
  assert.equal(factory.instances.length, 2, 'each session owns a fresh recognizer');
});

test('no-speech is reported as listen-again, never as a microphone failure', () => {
  const factory = makeFakeRecognitionFactory();
  const errors = [];
  const service = createVoiceAssistantService({
    recognitionCtor: factory,
    onError: (m) => errors.push(m),
  });
  assert.equal(service.start(), true);
  factory.instances[0].onerror({ error: 'no-speech' });
  assert.equal(service.state, VOICE_STATE.IDLE, 'no-speech settles to IDLE for a quick retry');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /No speech was detected/);
  assert.doesNotMatch(errors[0], /microphone could not be started/);
});

test('a synchronously-throwing recognizer.start() lands as friendly text and never leaks the raw error', () => {
  const factory = () => ({
    lang: '',
    start() {
      throw new TypeError('Illegal constructor');
    },
    abort() {},
    stop() {},
  });
  const errors = [];
  const service = createVoiceAssistantService({
    recognitionCtor: factory,
    onError: (m) => errors.push(m),
  });
  assert.equal(service.start(), false);
  assert.equal(service.state, VOICE_STATE.ERROR);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /microphone could not be started/);
  assert.doesNotMatch(errors[0], /Illegal|TypeError|constructor/);
});

test('voice transcript forwarding never drops SPEAKING after a reply starts', () => {
  const factory = makeFakeRecognitionFactory();
  const { speechSynthesis, Utterance } = makeFakeSynthesis();
  const service = createVoiceAssistantService({
    recognitionCtor: factory,
    speechSynthesis,
    utteranceCtor: Utterance,
    onTranscript: () => {
      service.speak('Processing your request.');
    },
  });
  service.start();
  const rec = factory.instances[0];
  rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'show weather' } }] });
  assert.equal(service.state, VOICE_STATE.SPEAKING, 'trailing IDLE must not clobber SPEAKING');
});

test('starting voice while speaking cancels the spoken reply first', () => {
  const factory = makeFakeRecognitionFactory();
  const { speechSynthesis, Utterance, calls } = makeFakeSynthesis();
  const service = createVoiceAssistantService({
    recognitionCtor: factory,
    speechSynthesis,
    utteranceCtor: Utterance,
  });
  assert.equal(service.speak('Hello.'), true);
  assert.equal(service.state, VOICE_STATE.SPEAKING);
  assert.equal(service.start(), true);
  assert.ok(calls.cancel > 0, 'speech was cancelled before the mic started');
  assert.equal(service.state, VOICE_STATE.LISTENING);
});

test('assistant reports recorded demo traffic evidence for the selected route only', () => {
  const state = {
    trip: { origin: 'Chennai', destination: 'Madurai' },
    analysisStatus: 'ready',
    analysis: {
      routes: [
        { id: 'real-route-1', name: 'Route via NH 48' },
        { id: 'real-route-2', name: 'Route via Madurai Road' },
        { id: 'real-route-3', name: 'Route via NH 38' },
      ],
    },
    selectedRealRoute: { id: 'real-route-2', name: 'Route via Madurai Road' },
    traffic: {
      byRoute: {
        'real-route-2': {
          routeId: 'real-route-2',
          level: 'LOW',
          knownSegments: 3,
          totalSegments: 3,
          label: 'LOW on 3 of 3 monitored demo segment(s)',
          vehicleEstimate: 15,
          layer: 'DEMO',
          source: 'DEMO TRAFFIC INTELLIGENCE',
        },
      },
    },
  };
  assert.equal(classifyIntent('What is the traffic like?'), INTENT.traffic);
  assert.equal(classifyIntent('is there heavy traffic?'), INTENT.traffic);
  assert.equal(classifyIntent('Show statistics'), INTENT.evidence, '"Show statistics" opens evidence');

  const result = buildReply('What is the traffic like?', state);
  assert.equal(result.action.type, 'OPEN_INTELLIGENCE', 'traffic question opens the Intelligence view');
  assert.match(result.reply, /LOW/, 'reports the recorded observation level');
  assert.match(result.reply, /3 of 3/, 'reports ML evidence coverage');
  assert.match(result.reply, /not live city traffic/, 'never claims a live traffic feed');

  const noEvidence = buildReply('What is the traffic like?', {
    ...state,
    traffic: {
      byRoute: {
        'real-route-2': {
          routeId: 'real-route-2',
          level: null,
          knownSegments: 0,
          totalSegments: 3,
        },
      },
    },
  });
  assert.equal(noEvidence.action.type, 'OPEN_INTELLIGENCE');
  assert.match(noEvidence.reply, /UNKNOWN \/ DEMO EVIDENCE ONLY/, 'unknown stays unknown, never a score');

  const beforeTrip = buildReply('What is the traffic like?', {});
  assert.equal(beforeTrip.action.type, 'OPEN_INTELLIGENCE');
  assert.match(beforeTrip.reply, /must be analysed first/, 'no trip → no fabricated traffic');
});

test('voice retries once with the next fallback language on language-not-supported, then forwards a result', () => {
  const instances = [];
  const factory = () => {
    const inst = {
      lang: '',
      started: false,
      start() { inst.started = true; },
      abort() { inst.aborted = true; },
      stop() { inst.aborted = true; },
    };
    instances.push(inst);
    return inst;
  };
  const errors = [];
  const seen = [];
  const service = createVoiceAssistantService({
    recognitionCtor: factory,
    onError: (m) => errors.push(m),
    onTranscript: (t) => seen.push(t),
  });
  service.start();
  assert.equal(instances[0].lang, 'en-IN', 'first attempt stays en-IN');

  instances[0].onerror({ error: 'language-not-supported' });
  assert.equal(instances.length, 2, 'a second recognizer is created for the fallback language');
  assert.equal(instances[1].lang, 'en-US', 'the fallback attempt uses en-US');
  assert.equal(instances[1].started, true, 'the fallback recognizer was restarted');
  assert.equal(service.state, VOICE_STATE.LISTENING, 'fallback retry stays listening');
  assert.equal(errors.length, 0, 'the silent retry must not surface an error');

  instances[1].onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'route from Chennai to Madurai' } }] });
  assert.deepEqual(seen, ['route from Chennai to Madurai'], 'the fallback recognizer result is forwarded exactly once');
  assert.ok(LANGUAGE_FALLBACKS.includes('en-IN') && LANGUAGE_FALLBACKS.includes('en-US'));
});

test('a second language-not-supported failure surfaces the honest user-facing error', () => {
  const factory = makeFakeRecognitionFactory();
  const errors = [];
  const service = createVoiceAssistantService({
    recognitionCtor: factory,
    onError: (m) => errors.push(m),
  });
  service.start();
  factory.instances[0].onerror({ error: 'language-not-supported' });
  factory.instances[1].onerror({ error: 'language-not-supported' });
  assert.equal(service.state, VOICE_STATE.ERROR, 'fallback exhausted → ERROR');
  assert.equal(errors.length, 1, 'exactly one friendly error after both attempts');
  assert.match(errors[0], /text chat/);
});

test('demo identity is Chennai → Madurai end to end (no Tambaram anywhere in the frontend source)', () => {
  // Example trips + assistant starters point at the Chennai → Madurai demo.
  const tripSource = readFileSync(join(__dirname, '..', 'src', 'components', 'TripPlanningSection.jsx'), 'utf-8');
  assert.match(tripSource, /Chennai/);
  assert.match(tripSource, /Madurai/);
  const aiSection = readFileSync(join(__dirname, '..', 'src', 'components', 'AIAssistantSection.jsx'), 'utf-8');
  assert.match(aiSection, /Chennai to Madurai/);
  // The old Chennai-demo destination is gone from all frontend source files.
  const srcDir = join(__dirname, '..', 'src');
  const files = readdirSync(srcDir, { recursive: true }).filter((f) => typeof f === 'string' && /\.(js|jsx)$/i.test(f));
  const offenders = [];
  for (const file of files) {
    const body = readFileSync(join(srcDir, file), 'utf-8');
    if (/Tambaram/.test(body)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'no Tambaram references remain in frontend source');
});

test('no demo clip filenames or recordings/ paths are hardcoded in React components', () => {
  const srcDir = join(__dirname, '..', 'src');
  for (const dir of ['components', 'App.jsx']) {
    const target = join(srcDir, dir);
    if (!existsSync(target)) continue;
    const files = existsSync(target) && dir.endsWith('.jsx')
      ? [dir]
      : readdirSync(target).filter((f) => /\.jsx$/.test(f));
    for (const file of files) {
      const body = readFileSync(dir.endsWith('.jsx') ? join(srcDir, dir) : join(srcDir, dir, file), 'utf-8');
      assert.doesNotMatch(body, /['"`][^'"`]*\.mp4['"`]/, `${file} must not hardcode a quoted clip path`);
      assert.doesNotMatch(body, /recordings\//, `${file} must not hardcode the recordings path`);
    }
  }
});