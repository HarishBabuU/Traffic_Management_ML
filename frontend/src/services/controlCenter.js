/**
 * Phase 9F-4 Parts 1–2 — control-centre state machine.
 *
 * Pure, dependency-free logic that governs the interactive trip flow:
 *
 *   Origin → Destination → Route Analysis → Route Selection → Relevant CCTV
 *                                                              → Investigation
 *
 * It is deliberately kept free of any imports so the exact same logic can be
 * unit-tested under `node --test` (see scripts/smoke_test.mjs) and used by
 * the React components.
 *
 * CCTV visibility rule (very important, kept truthful):
 *   STATE 1  no destination entered                → NO CCTV resources
 *   STATE 2  destination set, not successfully      → NO CCTV resources
 *            analysed (not run, or the real map
 *            analysis failed / is unavailable)
 *   STATE 3  analysed, no route selected           → CCTV area available,
 *                                                    but no generic resource
 *                                                    list — only a prompt to
 *                                                    select a demo route
 *   STATE 4  route selected                        → ONLY the demo CCTV
 *                                                    resources associated with
 *                                                    that route's segments
 *
 * Phase 9F-4 Part 2 adds a REAL map layer (Leaflet + OpenStreetMap), REAL
 * geocoding (Photon) and REAL routing (OSRM) that are deliberately separated
 * from the Phase 9E demo/mock route intelligence:
 *   - REAL routes come from live providers and are NEVER fabricated.
 *   - MOCK routes come from the static Phase 9E dataset and are NEVER drawn on
 *     the map.
 *   - The demo CCTV resources remain DEMO associations to recorded video
 *     footage only; they carry no real-world camera location or coordinates
 *     and are never placed on the map as camera markers.
 */

export const RECORDED_LABEL = 'Recorded video';
export const DEMO_LABEL = 'DEMO CCTV';

/**
 * Note shown wherever geographic CCTV placement could be expected. Demo CCTV
 * resources carry no coordinates, so the real map never renders them as
 * camera markers.
 */
export const GEO_CCTV_NOTE =
  'Geographic CCTV integration not yet available for these demo recordings.';

/**
 * Provider disclosure (Phase 9F-4 Part 2). Kept in the pure module so tests
 * can assert exactly what is shown to the user.
 */
export const MAP_PROVIDERS_DISCLOSURE = {
  map: 'OpenStreetMap',
  geocoding: 'Photon (komoot public endpoint, no API key)',
  routing: 'OSRM public demo server (no API key)',
  tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
};

/**
 * Analysis pipeline status values fed to the trips section and the real-route
 * section:
 *   idle          nothing triggered yet
 *   geocoding     resolving origin/destination locations
 *   routing       calculating real route(s)
 *   ready         real route(s) available (analysisReady === true)
 *   location-error one of geocode-not-found / geocode-ambiguous / geocode-http
 *   unavailable   one of route-empty / route-http / network
 */
export const ANALYSIS_MESSAGES = {
  idle: '',
  geocoding: 'Resolving locations...',
  routing: 'Calculating route...',
  ready: '',
  'geocode-not-found':
    'Location could not be resolved. Please enter a more specific location.',
  'geocode-ambiguous':
    'Several locations match this search. Pick the one you meant below.',
  'route-empty': 'Route could not be generated. Please try again.',
  'geocode-http': 'Real map service unavailable. No real route was generated.',
  'route-http': 'Real map service unavailable. No real route was generated.',
  network: 'Real map service unavailable. No real route was generated.',
};

/**
 * Human-readable status line for the current analysis state.
 */
export function analysisMessageFor(status) {
  return ANALYSIS_MESSAGES[status] || '';
}

/**
 * View model for the REAL-ROUTE MAP area. Returns an object of the form
 * { mode, message } where mode ∈
 *   idle | loading | ready | location-error | unavailable
 * Only mapViewState('ready') ever surfaces route geometry on the map; any
 * provider failure produces an explicit error state (never fabricated coords).
 */
export function mapViewState(status) {
  if (status === 'idle') return { mode: 'idle', message: '' };
  if (status === 'geocoding' || status === 'routing') {
    return { mode: 'loading', message: ANALYSIS_MESSAGES[status] || '' };
  }
  if (status === 'ready') return { mode: 'ready', message: '' };
  if (status === 'geocode-not-found' || status === 'geocode-ambiguous') {
    return { mode: 'location-error', message: ANALYSIS_MESSAGES[status] || '' };
  }
  return {
    mode: 'unavailable',
    message:
      ANALYSIS_MESSAGES[status] ||
      ANALYSIS_MESSAGES.network,
  };
}

/**
 * State machine describing where the user is in the trip flow.
 */
export function tripStage({ destinationEntered, analyzed }) {
  if (!destinationEntered) return 'no-destination';
  if (!analyzed) return 'destination-set';
  return 'routes-ready';
}

/**
 * Collapses duplicate route_id rows (the Phase 9E engine itself excludes
 * duplicate ids from recommendation). First occurrence wins. Pure display
 * helper — never modifies the underlying data.
 */
export function uniqueRoutes(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (seen.has(row.route_id)) continue;
    seen.add(row.route_id);
    out.push(row);
  }
  return out;
}

/**
 * Route candidates are only available AFTER a destination has been entered AND
 * route analysis has been triggered. Returns null otherwise (so the section
 * can render an honest empty state).
 */
export function routeCandidates(rows, state) {
  return tripStage(state) === 'routes-ready' ? uniqueRoutes(rows) : null;
}

export const EMPTY_STATE_MESSAGES = {
  noDestination: 'Enter a destination to analyze routes and identify relevant CCTV resources.',
  notAnalyzed: 'Destination set. Run "Analyze Route" to generate route candidates before CCTV resources are revealed.',
  noRouteSelected: 'Select a route candidate above to reveal its relevant DEMO CCTV resources.',
};

/**
 * CCTV visibility policy. Returns:
 *   { visible, kind, message, resources }
 * `resources` is only populated in the route-selected state, and only with the
 * demo resources mapped to the selected route's segments (never "all").
 *
 * `analysisReady` defaults to `analyzed` for backward compatibility with the
 * Part 1 calls, but once passed it is the single source of truth for STATE 2:
 * CCTV stays hidden while the real-map analysis is still "in progress" or
 * "failed / unavailable". Demo candidates themselves remain available in the
 * demo route area after a trip is set, because they are local static data.
 */
export function cctvPolicy({
  destinationEntered,
  analyzed,
  analysisReady,
  selectedRoute,
}) {
  if (!destinationEntered) {
    return {
      visible: false,
      kind: 'no-destination',
      message: EMPTY_STATE_MESSAGES.noDestination,
      resources: [],
    };
  }
  const success = analysisReady === undefined ? analyzed : analysisReady;
  if (!success) {
    return {
      visible: false,
      kind: 'not-analyzed',
      message: EMPTY_STATE_MESSAGES.notAnalyzed,
      resources: [],
    };
  }
  if (!selectedRoute) {
    return {
      visible: true,
      kind: 'no-route',
      message: EMPTY_STATE_MESSAGES.noRouteSelected,
      resources: [],
    };
  }
  return {
    visible: true,
    kind: 'route-selected',
    message: '',
    resources: resourcesForRoute(selectedRoute),
  };
}

/**
 * Road ids referenced by a route's segment sequence.
 */
export function routeRoadIds(route) {
  return String(route && route.segment_sequence ? route.segment_sequence : '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Demo CCTV catalogue. Each entry is a DEMO association between a mock road of
 * the Phase 9C/9D/9E prototype and one of the RECORDED dataset videos. These
 * are NOT real cameras and carry no geographic position.
 */
export const demoCctvCatalog = [
  {
    id: 'DEMO-CCTV-01',
    roadId: 'MOCK-ROAD-01',
    video: 'low traffic.mp4',
    title: 'Demo corridor A — recorded low-traffic footage',
    kind: 'recorded',
    demo: true,
  },
  {
    id: 'DEMO-CCTV-02',
    roadId: 'MOCK-ROAD-02',
    video: 'low traffic.mp4',
    title: 'Demo corridor B — recorded moderate-activity footage',
    kind: 'recorded',
    demo: true,
  },
  {
    id: 'DEMO-CCTV-03',
    roadId: 'MOCK-ROAD-03',
    video: 'traffic.mp4',
    title: 'Demo corridor C — recorded heavy-activity footage',
    kind: 'recorded',
    demo: true,
  },
  {
    id: 'DEMO-CCTV-04',
    roadId: 'MOCK-ROAD-04',
    video: 'traffic.mp4',
    title: 'Demo corridor D — recorded congested footage',
    kind: 'recorded',
    demo: true,
  },
  {
    id: 'DEMO-CCTV-05',
    roadId: 'MOCK-ROAD-05',
    video: 'low traffic.mp4',
    title: 'Demo corridor E — recorded moderate-activity footage',
    kind: 'recorded',
    demo: true,
  },
  {
    id: 'DEMO-CCTV-06',
    roadId: 'MOCK-ROAD-06',
    video: 'no traffic video.mp4',
    title: 'Demo corridor F — recorded sparsely-travelled footage (UNKNOWN activity)',
    kind: 'recorded',
    demo: true,
  },
  {
    id: 'DEMO-CCTV-07',
    roadId: 'MOCK-ROAD-07',
    video: 'no traffic video.mp4',
    title: 'Demo corridor G — recorded sparsely-travelled footage (UNKNOWN activity)',
    kind: 'recorded',
    demo: true,
  },
  {
    id: 'DEMO-CCTV-08',
    roadId: 'MOCK-ROAD-08',
    video: 'low traffic.mp4',
    title: 'Demo corridor H — recorded moderate-activity footage',
    kind: 'recorded',
    demo: true,
  },
];

/**
 * Returns ONLY the demo CCTV resources whose road is part of the selected
 * route's segments. Never returns the full catalogue.
 */
export function resourcesForRoute(route, catalog = demoCctvCatalog) {
  if (!route) return [];
  const roads = routeRoadIds(route);
  return catalog.filter((r) => roads.includes(r.roadId));
}

/**
 * A route is usable for investigation when it actually received a score
 * (RECOMMENDED / ELIGIBLE). INSUFFICIENT_DATA / INVALID_ROUTE routes cannot be
 * selected as a routing context.
 */
export function selectableRoute(route) {
  if (!route) return false;
  return (
    route.recommendation_status === 'RECOMMENDED' ||
    route.recommendation_status === 'ELIGIBLE'
  );
}

/**
 * Optional external base for the recorded demo clips, e.g. a Cloudflare R2
 * public bucket. Read once from VITE_DEMO_CCTV_BASE_URL.
 *
 * Absent or blank → undefined → every helper below returns its previous local
 * URL and local development is completely unaffected. No R2 (or any other) URL
 * is hardcoded anywhere in this module.
 */
export function demoCctvBaseUrl(env) {
  const raw = env ? env.VITE_DEMO_CCTV_BASE_URL : undefined;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : undefined;
}

/**
 * The build-time value, resolved once. `import.meta.env` is injected by Vite
 * and is `undefined` under plain `node --test`, so local and unit-test runs get
 * no base and keep the previous behaviour.
 */
const BUILT_DEMO_BASE_URL = demoCctvBaseUrl(import.meta.env);

/**
 * Joins an optional external base with a site-relative path. With no base the
 * relative path is returned unchanged, which is the local behaviour.
 */
function withDemoBase(baseUrl, relativePath) {
  const suffix = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  return baseUrl ? `${baseUrl}${suffix}` : relativePath;
}

/**
 * Served URL for a recorded dataset clip. The clips live in public/recordings/
 * (byte-for-byte copies of the original MP4s) and are served by the app itself.
 *
 * `baseUrl` defaults to the build-time VITE_DEMO_CCTV_BASE_URL, so once the
 * clips are on object storage no call site has to change.
 */
export function demoVideoUrl(video, baseUrl = BUILT_DEMO_BASE_URL) {
  return withDemoBase(baseUrl, `recordings/${encodeURIComponent(video)}`);
}

/**
 * Served URL for a recorded demo CCTV clip. The clips are the ORIGINAL demo
 * CCTV MP4s under data/demo_cctv/<route_id>/<source_video>.
 *
 * Locally the Vite dev / preview server streams them at
 * /demo-cctv/<route_id>/<source_video> (no copies are made into public/ or
 * dist/). A deployed static build has no Vite server, so the clips must be
 * hosted externally — set VITE_DEMO_CCTV_BASE_URL for that. The route folder and
 * filename are preserved either way.
 */
export function demoCctvVideoUrl(routeId, sourceVideo, baseUrl = BUILT_DEMO_BASE_URL) {
  const routeFolder = encodeURIComponent(routeId || '');
  const encodedFile = encodeURIComponent(sourceVideo || '');
  return withDemoBase(baseUrl, `/demo-cctv/${routeFolder}/${encodedFile}`);
}

/**
 * Finds the prepared evidence entry for a camera by cctv_id within the EXISTING
 * demo CCTV evidence (no second registry, no new evidence format). Returns null
 * when the camera is unmatched — never a fabricated row.
 */
export function findCameraEvidence(cameraId, cameraEvidence) {
  const list = Array.isArray(cameraEvidence) ? cameraEvidence : [];
  return list.find((e) => e && e.cctv_id === cameraId) || null;
}

/**
 * Pulls the existing per-video intelligence for a resource WITHOUT computing
 * or inventing anything. `classByVideo` and `trafficRows` come straight from
 * the prepared Level 8 / Phase 9A JSON copies.
 *
 * Returns { byVideo, overview } where byVideo is the class_by_video row for
 * the clip and overview is the matching video_overview traffic row.
 */
export function videoIntelligence(video, classByVideo, trafficRows) {
  const byVideo = (classByVideo || []).find((r) => r.video === video) || null;
  const overview =
    (trafficRows || []).find(
      (r) => r.row_type === 'video_overview' && r.video === video
    ) || null;
  return { byVideo, overview };
}

/**
 * Note shown in the route intelligence panel. Comparative traffic/road
 * intelligence is not geographically mapped to real routes in this build, so
 * the UI must never present fabricated per-route confidence scores or
 * rankings.
 */
export const ROUTE_INTELLIGENCE_NOTE =
  'Route intelligence currently reflects live routing geometry only. ' +
  'Comparative traffic/road intelligence is not geographically mapped to ' +
  'these real routes, so no per-route confidence scores or rankings are fabricated.';

/**
 * Deltas (compared against the selected route) derived ONLY from the live
 * provider numbers — never fabricated. Returns [{ id, distanceKm, durationMin,
 * distanceDelta, durationDelta }]. Both deltas are null for the selected route
 * and for any route missing numeric values.
 */
export function routeDeltas(routes, selectedId = null) {
  const list = Array.isArray(routes) ? routes : [];
  const selected = list.find((r) => r.id === selectedId) || list[0];
  return list.map((r) => {
    const hasKm = Number.isFinite(r.distanceKm) && Number.isFinite(selected && selected.distanceKm);
    const hasMin = Number.isFinite(r.durationMin) && Number.isFinite(selected && selected.durationMin);
    const isSelected = selected && r.id === selected.id;
    return {
      id: r.id,
      distanceKm: r.distanceKm,
      durationMin: r.durationMin,
      distanceDelta: isSelected || !hasKm ? null : Number((r.distanceKm - selected.distanceKm).toFixed(1)),
      durationDelta: isSelected || !hasMin ? null : Number((r.durationMin - selected.durationMin).toFixed(1)),
    };
  });
}

function minId(rows, key) {
  if (rows.length === 0) return null;
  let best = rows[0];
  for (const r of rows) if (r[key] < best[key]) best = r;
  return best.id;
}

/**
 * Tags derived strictly from provider numbers: "Fastest" (lowest duration) and
 * "Shortest" (lowest distance). Omitted when only one route exists or the
 * numbers are absent, so nothing is ever invented.
 */
export function routeTags(routes) {
  const list = Array.isArray(routes) ? routes : [];
  const byDuration = list.filter((r) => Number.isFinite(r.durationMin));
  const byDistance = list.filter((r) => Number.isFinite(r.distanceKm));
  const fastestId = byDuration.length > 1 ? minId(byDuration, 'durationMin') : null;
  const shortestId = byDistance.length > 1 ? minId(byDistance, 'distanceKm') : null;
  return list.map((r) => {
    const tags = [];
    if (r.id === fastestId) tags.push('Fastest');
    if (r.id === shortestId) tags.push('Shortest');
    return { id: r.id, tags };
  });
}

export const INVESTIGATION_MESSAGES = {
  noDestination: 'Set a destination and run a trip to open the investigation area.',
  notAnalyzed: 'Run a route analysis for this destination to unlock investigation sources.',
  noRoute: 'Select a route on the map to reveal the available investigation sources for this trip.',
  routeSelected: '',
};

/**
 * Honest note for every demo investigation source. The recorded clips carry no
 * coordinates, so they are never presented as live cameras on the real route.
 */
export const INVESTIGATION_SOURCE_NOTE =
  'Demo investigation sources. Recorded footage from the Level 8 dataset; NOT geographically mapped to the selected real route and not live cameras.';

/**
 * Investigation-area visibility policy for the real-trip context. Unlike the
 * Phase 9E demo gating (cctvPolicy), this one is driven by the REAL route
 * selection:
 *   no destination entered                       → hidden
 *   destination set, analysis not ready/failed   → hidden
 *   analysed, no real route selected             → visible prompt (no list)
 *   real route selected                          → visible demo source catalogue,
 *                                                 each explicitly NOT
 *                                                 geographically mapped
 * The catalogue is returned as "available investigation sources"; resources
 * keep their `geographicallyMapped: false` flag so no component can confuse
 * them with real cameras.
 */
export function tripInvestigationState({
  destinationEntered,
  analysisReady,
  realRouteSelected,
  catalog = demoCctvCatalog,
}) {
  if (!destinationEntered) {
    return {
      visible: false,
      kind: 'no-destination',
      message: INVESTIGATION_MESSAGES.noDestination,
      resources: [],
    };
  }
  if (!analysisReady) {
    return {
      visible: false,
      kind: 'not-analyzed',
      message: INVESTIGATION_MESSAGES.notAnalyzed,
      resources: [],
    };
  }
  if (!realRouteSelected) {
    return {
      visible: true,
      kind: 'no-route',
      message: INVESTIGATION_MESSAGES.noRoute,
      resources: [],
    };
  }
  return {
    visible: true,
    kind: 'route-selected',
    message: '',
    resources: catalog.map((r) => ({ ...r, geographicallyMapped: false })),
  };
}