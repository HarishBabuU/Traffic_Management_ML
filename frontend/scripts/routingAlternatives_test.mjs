/**
 * Routing-alternatives tests (Issue 2).
 *
 * Proves the application keeps EVERY route the routing provider returns:
 *   - `routeUrl` asks OSRM for alternatives with the documented parameter;
 *   - `parseRoutesResponse` maps `routes[]` in full, preserving geometry,
 *     distance, duration, index/id and the remaining provider metadata;
 *   - nothing slices, truncates, deduplicates or "recommends away" a route;
 *   - a single-route response still works and is disclosed honestly;
 *   - the collapsed route panel always has a way back, so no returned route
 *     becomes unreachable.
 *
 * No test fabricates a route: every payload is shaped like a real OSRM
 * `/route/v1/driving` response.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createLocationService,
  errorKindFor,
  parseRoutesResponse,
  routeUrl,
  MAP_PROVIDERS,
} from '../src/services/locationProviders.js';
import { composeTripIntelligence, rankRoutes } from '../src/services/routeIntelligence.js';
import { routeDeltas, routeTags } from '../src/services/controlCenter.js';

const __dirname = import.meta.dirname;
const FRONTEND = join(__dirname, '..');

/**
 * Builds a realistic OSRM response with `count` routes, each with its own
 * geometry, distance, duration and weight. Route 1 is always the shortest so
 * tests can prove it is not treated as "the only route".
 */
function osrmResponse(count) {
  return {
    code: 'Ok',
    waypoints: [
      { name: 'Origin', location: [80.2707, 13.0827] },
      { name: 'Destination', location: [78.1198, 9.9252] },
    ],
    routes: Array.from({ length: count }, (_, i) => ({
      distance: 400000 + i * 12000 - i * 500,
      duration: 20000 + i * 900,
      weight: 410000 + i * 11500 - i * 500,
      weight_name: 'routability',
      legs: [{ summary: i === 0 ? 'NH 32' : '' }],
      geometry: {
        type: 'LineString',
        coordinates: [
          [80.27 - i * 0.01, 13.08 - i * 0.01],
          [80.1 - i * 0.01, 12.9 - i * 0.01],
          [79.4 - i * 0.01, 11.5],
          [78.1198, 9.9252],
        ],
      },
    })),
  };
}

/** Minimal successful Photon payload, used only by the mock transport. */
const PHOTON_OK = {
  features: [
    {
      geometry: { type: 'Point', coordinates: [80.2707, 13.0827] },
      properties: { name: 'Chennai', city: 'Chennai', state: 'Tamil Nadu', country: 'India' },
    },
    {
      geometry: { type: 'Point', coordinates: [78.1198, 9.9252] },
      properties: { name: 'Madurai', city: 'Madurai', state: 'Tamil Nadu', country: 'India' },
    },
  ],
};

/** Mock transport that serves Photon normally and a fixed OSRM payload. */
function serviceReturning(payload) {
  const requested = [];
  return {
    requested,
    service: createLocationService({
      fetchImpl: async (url) => {
        requested.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => (url.includes('photon.komoot.io') ? PHOTON_OK : payload),
        };
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

test('the OSRM request enables alternatives with the documented parameter', () => {
  const url = routeUrl({ lat: 13.0827, lon: 80.2707 }, { lat: 9.9252, lon: 78.1198 });
  assert.ok(url.startsWith('https://router.project-osrm.org/route/v1/driving/'), 'OSRM demo server only');
  assert.match(url, /alternatives=true/, 'alternatives are requested');
  assert.match(url, /overview=full/, 'full geometry overview requested');
  assert.match(url, /geometries=geojson/, 'GeoJSON geometry requested');
  assert.ok(url.includes('80.2707,13.0827;78.1198,9.9252'), 'origin/destination order preserved');
  assert.equal(
    MAP_PROVIDERS.routing,
    'OSRM public demo server (no API key)',
    'the existing provider is kept (no Google Maps, no key)'
  );
});

test('the service always sends alternatives=true on every routing call', async () => {
  const { service, requested } = serviceReturning(osrmResponse(3));
  await service.route({ lat: 13.08, lon: 80.27 }, { lat: 9.92, lon: 78.11 });
  assert.equal(requested.length, 1);
  assert.match(requested[0], /alternatives=true/);
});

// ---------------------------------------------------------------------------
// Response handling: every route survives
// ---------------------------------------------------------------------------

test('a single-route provider response yields exactly one route', () => {
  const routes = parseRoutesResponse(osrmResponse(1));
  assert.equal(routes.length, 1, 'the provider route count is honoured exactly');
  assert.equal(routes[0].id, 'real-route-1');
  assert.equal(routes[0].geometry.length, 4);
});

test('a two-route provider response yields both routes', () => {
  const routes = parseRoutesResponse(osrmResponse(2));
  assert.equal(routes.length, 2, 'no route is discarded');
  assert.deepEqual(routes.map((r) => r.id), ['real-route-1', 'real-route-2']);
  assert.deepEqual(routes.map((r) => r.providerRef.index), [0, 1], 'provider order preserved');
});

test('a three-route provider response yields all three routes', () => {
  const routes = parseRoutesResponse(osrmResponse(3));
  assert.equal(routes.length, 3);
  assert.deepEqual(routes.map((r) => r.id), ['real-route-1', 'real-route-2', 'real-route-3']);
});

test('five provider routes are all returned — the count is never assumed', () => {
  for (const count of [1, 2, 3, 4, 5, 7]) {
    const routes = parseRoutesResponse(osrmResponse(count));
    assert.equal(routes.length, count, `provider returned ${count} routes`);
    assert.equal(
      new Set(routes.map((r) => r.id)).size,
      count,
      'every route keeps a unique id'
    );
  }
});

test('routes[0] is never the only route used', () => {
  const routes = parseRoutesResponse(osrmResponse(4));
  assert.ok(routes.length > 1);
  // Every route beyond the first must still carry real, distinct provider data.
  for (const route of routes.slice(1)) {
    assert.ok(route.geometry.length >= 2, `${route.id} keeps real geometry`);
    assert.ok(Number.isFinite(route.distanceKm), `${route.id} keeps its distance`);
    assert.ok(Number.isFinite(route.durationMin), `${route.id} keeps its duration`);
  }
  assert.equal(new Set(routes.map((r) => r.geometry[1].lat)).size, routes.length, 'geometries are distinct');
});

test('every returned route preserves geometry, distance, duration and metadata', () => {
  const payload = osrmResponse(3);
  const routes = parseRoutesResponse(payload);
  routes.forEach((route, index) => {
    const raw = payload.routes[index];
    assert.equal(route.distanceKm, Number((raw.distance / 1000).toFixed(1)));
    assert.equal(route.durationMin, Math.round(raw.duration / 60));
    assert.deepEqual(
      route.geometry,
      raw.geometry.coordinates.map(([lon, lat]) => ({ lat: Number(lat), lon: Number(lon) })),
      `${route.id} geometry is the provider geometry, unmodified`
    );
    assert.equal(route.weightMeters, Number((raw.weight / 1000).toFixed(3)), 'weight preserved');
    assert.equal(route.weightName, 'routability', 'weight_name preserved');
    assert.equal(route.waypointCount, 2, 'waypoints preserved');
    assert.equal(route.name, index === 0 ? 'NH 32' : `Real route ${index + 1}`);
    assert.ok(route.source.includes('OSRM'));
    assert.equal(route.providerRef.provider, 'osrm');
  });
});

test('a non-Ok or empty routing response yields no routes instead of a fake one', () => {
  assert.deepEqual(parseRoutesResponse({ code: 'NoRoute', routes: [] }), []);
  assert.deepEqual(parseRoutesResponse({ code: 'Ok', routes: [] }), []);
  assert.deepEqual(parseRoutesResponse(null), []);
  assert.deepEqual(parseRoutesResponse({ routes: osrmResponse(2).routes }), []);
});

test('the routing service returns every provider route, not just the first', async () => {
  const { service } = serviceReturning(osrmResponse(5));
  const routes = await service.route({ lat: 13.08, lon: 80.27 }, { lat: 9.92, lon: 78.11 });
  assert.equal(routes.length, 5, 'all five provider routes reach the caller');
});

test('analyzeTrip preserves every provider route end to end', async () => {
  const payload = osrmResponse(3);
  const service = createLocationService({
    fetchImpl: async (url) => {
      if (url.includes('photon.komoot.io')) {
        const q = decodeURIComponent(new URL(url).searchParams.get('q') || '').toLowerCase();
        const feature = PHOTON_OK.features.find((f) => q.includes(f.properties.name.toLowerCase()));
        return { ok: true, status: 200, json: async () => ({ features: feature ? [feature] : [] }) };
      }
      return { ok: true, status: 200, json: async () => payload };
    },
  });
  const result = await service.analyzeTrip({ origin: 'Chennai', destination: 'Madurai' });
  assert.equal(result.routes.length, 3, 'no route is dropped by the trip pipeline');
  assert.deepEqual(result.routes.map((r) => r.id), ['real-route-1', 'real-route-2', 'real-route-3']);
});

test('a single-route response still completes the trip normally', async () => {
  const { service } = serviceReturning(osrmResponse(1));
  const result = await service.analyzeTrip({ origin: 'Chennai', destination: 'Madurai' });
  assert.equal(result.routes.length, 1);
  assert.equal(result.originResolved.name, 'Chennai');
  assert.equal(errorKindFor(Object.assign(new Error('x'), { code: 'route-empty' })), 'route-empty');
});

test('an empty routing response is still reported as route-empty', async () => {
  const { service } = serviceReturning({ code: 'NoRoute', routes: [] });
  await assert.rejects(
    service.route({ lat: 1, lon: 2 }, { lat: 3, lon: 4 }),
    (error) => errorKindFor(error) === 'route-empty'
  );
});

// ---------------------------------------------------------------------------
// Downstream consumers must not drop or re-rank routes away
// ---------------------------------------------------------------------------

test('route deltas and tags cover every provider route', () => {
  const routes = parseRoutesResponse(osrmResponse(4));
  assert.equal(routeDeltas(routes, routes[1].id).length, 4);
  assert.equal(routeTags(routes).length, 4);
  const fastest = routeTags(routes).find((t) => t.tags.includes('Fastest'));
  const shortest = routeTags(routes).find((t) => t.tags.includes('Shortest'));
  assert.ok(fastest && shortest, 'tags are derived from provider numbers only');
  assert.equal(
    fastest.id,
    shortest.id,
    'route 1 is genuinely the fastest AND shortest in this fixture'
  );
});

test('with a single route the fastest/shortest tags are omitted, not invented', () => {
  const routes = parseRoutesResponse(osrmResponse(1));
  assert.deepEqual(routeTags(routes), [{ id: 'real-route-1', tags: [] }]);
});

test('route intelligence assesses every provider route and keeps alternatives eligible', () => {
  const routes = parseRoutesResponse(osrmResponse(3));
  const intel = composeTripIntelligence({
    routes,
    weather: { temperatureC: 31, description: 'Clear', windKph: 8, precipitationMm: 0, weatherCode: 0 },
    evidence: {},
  });
  // `assessments` is keyed by routeId; every provider route must have an entry.
  assert.deepEqual(
    Object.keys(intel.assessments),
    ['real-route-1', 'real-route-2', 'real-route-3'],
    'every provider route is assessed'
  );
  assert.deepEqual(
    Object.keys(intel.cctv.byRoute),
    ['real-route-1', 'real-route-2', 'real-route-3'],
    'every provider route keeps its own evidence'
  );
  if (intel.recommendation) {
    assert.ok(
      ['real-route-1', 'real-route-2', 'real-route-3'].includes(intel.recommendation.routeId),
      'the recommendation is always one of the provider routes'
    );
  }
});

test('a recommendation marks one route and leaves the others selectable', () => {
  const assessments = [
    { routeId: 'real-route-1', routeName: 'Route 1', score: 40 },
    { routeId: 'real-route-2', routeName: 'Route 2', score: 95 },
    { routeId: 'real-route-3', routeName: 'Route 3', score: 60 },
  ];
  const ranked = rankRoutes(assessments);
  assert.equal(ranked.length, 3, 'recommendation never removes routes');
  assert.equal(ranked.find((r) => r.recommendationStatus === 'RECOMMENDED').routeId, 'real-route-2');
  assert.equal(ranked.filter((r) => r.recommendationStatus === 'ELIGIBLE').length, 2);
});

// ---------------------------------------------------------------------------
// Source-level guards against regressions
// ---------------------------------------------------------------------------

test('no source file truncates, slices or takes only routes[0] to render routes', () => {
  const files = [
    'src/App.jsx',
    'src/components/MapView.jsx',
    'src/components/RealRouteSection.jsx',
    'src/components/RouteReasoningPanel.jsx',
    'src/services/locationProviders.js',
    'src/services/controlCenter.js',
    'src/services/tripService.js',
  ];
  for (const rel of files) {
    const src = readFileSync(join(FRONTEND, ...rel.split('/')), 'utf-8');
    assert.doesNotMatch(
      src,
      /routes\s*\.\s*slice\(\s*0\s*,/,
      `${rel} must not slice the provider route array`
    );
    assert.doesNotMatch(
      src,
      /\broutes\s*\.\s*slice\(\s*\d/,
      `${rel} must not slice the provider route array`
    );
    assert.doesNotMatch(
      src,
      /return\s+routes\s*\[\s*0\s*\]/,
      `${rel} must not collapse the route list to a single route`
    );
  }
});

test('the collapsed route panel can always be reopened', () => {
  const appSrc = readFileSync(join(FRONTEND, 'src', 'App.jsx'), 'utf-8');
  assert.match(appSrc, /setRoutePanelOpen\(false\)/, 'driving a route still collapses the panel');
  assert.match(
    appSrc,
    /handleToggleRoutePanel/,
    'a reopen control exists so no returned route becomes unreachable'
  );
  assert.match(appSrc, /data-route-panel-toggle=/, 'the control is identifiable in the DOM');
  assert.match(appSrc, /onClick=\{handleToggleRoutePanel\}/, 'the control is wired to the toggle');
});

test('a single provider route is disclosed honestly in the UI', () => {
  const src = readFileSync(join(FRONTEND, 'src', 'components', 'RealRouteSection.jsx'), 'utf-8');
  assert.match(src, /SINGLE_ROUTE_NOTE/, 'the single-route case is explained');
  assert.match(src, /routes\.length === 1/, 'driven by the actual provider count');
  assert.match(src, /routes\.length\} route\{routes\.length === 1 \? '' : 's'\}/, 'count is displayed');
});

test('routing keeps the existing OSRM provider — no Google Maps, no key', () => {
  const src = readFileSync(join(FRONTEND, 'src', 'services', 'locationProviders.js'), 'utf-8');
  assert.match(src, /router\.project-osrm\.org/, 'OSRM demo server still used');
  assert.doesNotMatch(src, /googleapis|maps\.google|google\.com\/maps/i, 'no Google Maps API or scraping');
});

// ---------------------------------------------------------------------------
// Temporary debugging code must never ship
// ---------------------------------------------------------------------------

test('the temporary diagnostics panel and service are gone', () => {
  for (const rel of ['src/components/DevDiagnosticsPanel.jsx', 'src/services/devDiagnostics.js']) {
    assert.ok(
      !existsSync(join(FRONTEND, ...rel.split('/'))),
      `${rel} must be deleted before shipping`
    );
  }
  // No temporary diagnostic scripts may remain in scripts/.
  const leftovers = readdirSync(join(FRONTEND, 'scripts')).filter(
    (name) => name.startsWith('_diagnose') || name.startsWith('devDiagnostics')
  );
  assert.deepEqual(leftovers, [], `temporary diagnostic scripts must be removed: ${leftovers.join(', ')}`);
});

test('no source file references the removed diagnostics', () => {
  const files = [
    'src/App.jsx',
    'src/ops.css',
    'src/index.css',
    'src/services/geolocation.js',
    'src/services/locationProviders.js',
  ];
  for (const rel of files) {
    const src = readFileSync(join(FRONTEND, ...rel.split('/')), 'utf-8');
    for (const needle of [
      'DevDiagnosticsPanel',
      'devDiagnostics',
      'recordBrowserFix',
      'recordRoutingCall',
      'getDevDiagnostics',
      'devdiag',
      'TEMPORARY',
    ]) {
      assert.ok(!src.includes(needle), `${rel} must not reference "${needle}"`);
    }
  }
});

test('diagnostic-only CSS is gone but the route toggle styling remains', () => {
  const css = readFileSync(join(FRONTEND, 'src', 'ops.css'), 'utf-8');
  assert.doesNotMatch(css, /\.devdiag/, 'diagnostic panel CSS removed');
  assert.doesNotMatch(css, /DEV DIAGNOSTICS/, 'diagnostic CSS comment removed');
  // The real route-panel toggle must keep its clickability styling.
  assert.match(css, /\.map-status-chip \.route-count-toggle\s*\{[^}]*pointer-events:\s*auto/,
    'the route panel toggle stays clickable inside the pointer-events:none chip');
});

test('the assistant drawer does not cover the route strip when open', () => {
  const app = readFileSync(join(FRONTEND, 'src', 'App.jsx'), 'utf-8');
  const css = readFileSync(join(FRONTEND, 'src', 'ops.css'), 'utf-8');
  // The assistant feature is kept and flagged on the app root when open.
  assert.match(app, /assistantOpen \? ' assistant-open'/, 'app root is flagged while the assistant is open');
  assert.match(app, /AIAssistantSection/, 'the assistant component is still mounted');
  assert.match(
    css,
    /\.app\.assistant-open \.routes-strip\s*\{\s*right:\s*\d+px/,
    'the route strip is pulled clear of the fixed assistant drawer'
  );
});