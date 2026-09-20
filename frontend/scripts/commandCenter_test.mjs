/**
 * Command Center tests (run with: npm test).
 *
 * Verifies the new command-centre architecture:
 *   - route deltas / tags are computed ONLY from live provider numbers
 *   - the Investigation area is gated by the real trip/route selection
 *     (and never fabricates a geographic mapping for demo recordings)
 *   - the honesty notes are wired into the UI
 *   - the prepared evidence JSON copies exist and preserve the protected
 *     values verbatim (122 tracks, 15491 trajectory rows, 108 artifact rows,
 *     PASSED validation)
 *   - the 4-view IA (command / investigation / intelligence / evidence) and
 *     the floating assistant drawer are present
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  routeDeltas,
  routeTags,
  tripInvestigationState,
  INVESTIGATION_SOURCE_NOTE,
  INVESTIGATION_MESSAGES,
  ROUTE_INTELLIGENCE_NOTE,
  GEO_CCTV_NOTE,
  demoCctvVideoUrl,
  findCameraEvidence,
} from '../src/services/controlCenter.js';
import {
  getTrackSummaries,
  getTrackTrajectories,
  getValidation,
  getDemoCctvEvidence,
} from '../src/services/dataService.js';
import {
  demoCctvForRoute,
  ROUTE_CCTV_CONTRACT,
} from '../src/services/routeIntelligence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, '..', 'src');
const dataDir = join(srcDir, 'data');

function readJson(name) {
  return JSON.parse(readFileSync(join(dataDir, name), 'utf-8'));
}

function readComponent(name) {
  return readFileSync(join(srcDir, 'components', name), 'utf-8');
}

// ---------------------------------------------------------------
// Real-route deltas & tags
// ---------------------------------------------------------------

test('routeDeltas returns null deltas when only one route exists', () => {
  const routes = [{ id: 'a', distanceKm: 10, durationMin: 15 }];
  assert.deepEqual(routeDeltas(routes), [
    { id: 'a', distanceKm: 10, durationMin: 15, distanceDelta: null, durationDelta: null },
  ]);
});

test('routeDeltas computes distance and duration deltas against the selected route', () => {
  const routes = [
    { id: 'a', distanceKm: 10, durationMin: 15 },
    { id: 'b', distanceKm: 12, durationMin: 12 },
    { id: 'c', distanceKm: 9, durationMin: 20 },
  ];
  const deltas = routeDeltas(routes, 'a');
  assert.equal(deltas[0].distanceDelta, null, 'selected route has no delta');
  assert.equal(deltas[0].durationDelta, null);
  assert.equal(deltas[1].distanceDelta, 2, '12 - 10');
  assert.equal(deltas[1].durationDelta, -3, '12 - 15');
  assert.equal(deltas[2].distanceDelta, -1, '9 - 10');
  assert.equal(deltas[2].durationDelta, 5, '20 - 15');
});

test('routeDeltas never invents deltas from missing numbers', () => {
  const routes = [
    { id: 'a', distanceKm: 10, durationMin: null },
    { id: 'b', distanceKm: null, durationMin: 12 },
  ];
  const deltas = routeDeltas(routes, 'a');
  assert.equal(deltas[0].distanceDelta, null);
  assert.equal(deltas[0].durationDelta, null);
  assert.equal(deltas[1].distanceDelta, null, 'missing distance never yields a delta');
  assert.equal(deltas[1].durationDelta, null, 'duration of selected is missing, so no delta');
});

test('routeDeltas is stable when no selected id is given (defaults to first)', () => {
  const routes = [
    { id: 'a', distanceKm: 10, durationMin: 15 },
    { id: 'b', distanceKm: 12, durationMin: 12 },
  ];
  const deltas = routeDeltas(routes, null);
  assert.equal(deltas.find((d) => d.id === 'a').distanceDelta, null);
  assert.equal(deltas.find((d) => d.id === 'b').distanceDelta, 2);
});

test('routeTags marks Fastest and Shortest strictly from provider numbers', () => {
  const routes = [
    { id: 'a', distanceKm: 20, durationMin: 30 },
    { id: 'b', distanceKm: 15, durationMin: 35 },
    { id: 'c', distanceKm: 25, durationMin: 22 },
  ];
  const tags = routeTags(routes);
  assert.ok(tags.find((t) => t.id === 'c').tags.includes('Fastest'), 'c has lowest duration');
  assert.ok(tags.find((t) => t.id === 'b').tags.includes('Shortest'), 'b has lowest distance');
  assert.equal(tags.find((t) => t.id === 'a').tags.length, 0);
});

test('routeTags emits no tags for a single route', () => {
  assert.deepEqual(routeTags([{ id: 'a', distanceKm: 10, durationMin: 15 }]), [
    { id: 'a', tags: [] },
  ]);
});

test('routeTags omits tags when the defining number is missing', () => {
  const tags = routeTags([{ id: 'a', distanceKm: null, durationMin: 15 }]);
  assert.equal(tags[0].tags.length, 0);
});

// ---------------------------------------------------------------
// Investigation gating (real-trip context)
// ---------------------------------------------------------------

test('tripInvestigationState hides the area before a destination is set', () => {
  const s = tripInvestigationState({ destinationEntered: false, analysisReady: false, realRouteSelected: false });
  assert.equal(s.visible, false);
  assert.equal(s.kind, 'no-destination');
  assert.deepEqual(s.resources, []);
  assert.equal(s.message, INVESTIGATION_MESSAGES.noDestination);
});

test('tripInvestigationState hides the area until real route analysis succeeds', () => {
  const s = tripInvestigationState({ destinationEntered: true, analysisReady: false, realRouteSelected: false });
  assert.equal(s.visible, false);
  assert.equal(s.kind, 'not-analyzed');
  assert.deepEqual(s.resources, []);
});

test('tripInvestigationState shows a prompt but no generic list before a route is selected', () => {
  const s = tripInvestigationState({ destinationEntered: true, analysisReady: true, realRouteSelected: false });
  assert.equal(s.visible, true);
  assert.equal(s.kind, 'no-route');
  assert.deepEqual(s.resources, [], 'no generic camera list before selection');
});

test('tripInvestigationState reveals demo sources only after a real route is selected, never mapped', () => {
  const s = tripInvestigationState({ destinationEntered: true, analysisReady: true, realRouteSelected: true });
  assert.equal(s.kind, 'route-selected');
  assert.ok(s.resources.length > 0, 'catalogue shown as available sources');
  assert.ok(
    s.resources.every((r) => r.geographicallyMapped === false),
    'every demo source is explicitly NOT geographically mapped'
  );
  assert.ok(
    s.resources.every((r) => r.video),
    'sources still carry the recorded clip name'
  );
});

test('investigation honesty notes are explicit and wired in', () => {
  assert.match(INVESTIGATION_SOURCE_NOTE, /NOT geographically mapped/i);
  assert.match(INVESTIGATION_SOURCE_NOTE, /not live cameras/i);
  assert.match(ROUTE_INTELLIGENCE_NOTE, /no per-route confidence scores or rankings are fabricated/i);
  assert.match(GEO_CCTV_NOTE, /no coordinates|not yet available/i);
  const investigationSrc = readComponent('CctvInvestigationSection.jsx');
  assert.match(investigationSrc, /INVESTIGATION_SOURCE_NOTE/);
  assert.match(investigationSrc, /geographicallyMapped/);
  assert.doesNotMatch(investigationSrc, /camera marker|new camera/i);
  const routeSrc = readComponent('RealRouteSection.jsx');
  assert.match(routeSrc, /ROUTE_INTELLIGENCE_NOTE/);
});

// ---------------------------------------------------------------
// Evvidence JSON copies preserve protected values verbatim
// ---------------------------------------------------------------

test('prepared evidence JSON files exist', () => {
  for (const name of ['trackSummaries.json', 'trackTrajectories.json', 'validation.json']) {
    assert.equal(existsSync(join(dataDir, name)), true, name);
  }
});

test('track summaries preserve the documented corrected counts', () => {
  const s = readJson('trackSummaries.json');
  assert.equal(s.finalTrackIdentities, 122);
  assert.equal(s.track_count_by_video['low traffic.mp4'].length, 44);
  assert.equal(s.track_count_by_video['no traffic video.mp4'].length, 5);
  assert.equal(s.track_count_by_video['traffic.mp4'].length, 73);
});

test('trajectory evidence preserves row counts, artifact rows and vertex frames', () => {
  const t = readJson('trackTrajectories.json');
  assert.equal(t.total_trajectory_rows, 15491);
  assert.equal(t.artifact_duplicate_rows, 108);
  assert.equal(t.trajectory_rows_by_video['low traffic.mp4'], 1723);
  assert.equal(t.trajectory_rows_by_video['no traffic video.mp4'], 1430);
  assert.equal(t.trajectory_rows_by_video['traffic.mp4'], 12338);
  const first = t.per_video['low traffic.mp4'][0];
  assert.ok(first, 'longest-track paths are prepared');
  assert.ok(Array.isArray(first.centroidPath) && first.centroidPath.length >= 2);
  assert.ok(
    first.centroidPath.every((p) => Number.isFinite(p.frame) && Number.isFinite(p.centroid_x) && Number.isFinite(p.centroid_y)),
    'every path point keeps a true frame number and coordinates'
  );
  assert.ok(
    first.centroidPath[first.centroidPath.length - 1].frame === Number(first.last_frame),
    'last sampled point keeps the true last frame'
  );
});

test('validation evidence preserves the PASSED result and per-video checks', () => {
  const v = readJson('validation.json');
  assert.equal(v.level8.result, 'PASSED');
  assert.equal(v.level8.finalTrackIdentities, 122);
  assert.equal(v.level8.totalTrajectoryRows, 15491);
  assert.equal(v.level8.duplicateRowsArtifact, 108);
  assert.equal(v.level8.perVideo['low traffic.mp4'].final, 44);
  assert.equal(v.level8.perVideo['traffic.mp4'].conservative, 68);
  assert.ok(v.phase9e.length > 0);
  assert.ok(
    v.phase9e.every((row) => row.ok === 'PASS'),
    'all Phase 9E validation checks pass'
  );
});

test('dataService exposes the new evidence accessors with honest status', () => {
  const tracks = getTrackSummaries();
  assert.equal(tracks.finalTrackIdentities, 122);
  assert.equal(tracks.status.status, 'STATIC');
  const trajectories = getTrackTrajectories();
  assert.equal(trajectories.totalTrajectoryRows, 15491);
  assert.equal(trajectories.artifactDuplicateRows, 108);
  const validation = getValidation();
  assert.equal(validation.level8.result, 'PASSED');
});

// ---------------------------------------------------------------
// 4-view IA, floating assistant, map wiring
// ---------------------------------------------------------------

test('App renders the four interactive views with a back-navigation stack', () => {
  const appSrc = readFileSync(join(srcDir, 'App.jsx'), 'utf-8');
  assert.match(appSrc, /data-view="home"/);
  assert.match(appSrc, /data-view="cctv"/);
  assert.match(appSrc, /data-view="intelligence"/);
  assert.match(appSrc, /data-view="evidence"/);
  assert.match(appSrc, /goToView/);
  assert.match(appSrc, /goBack/);
  assert.match(appSrc, /GO_BACK/);
  assert.match(appSrc, /viewStackRef/);
});

test('all required sections stay wired in App', () => {
  const appSrc = readFileSync(join(srcDir, 'App.jsx'), 'utf-8');
  for (const name of [
    'TripPlanningSection',
    'RealRouteSection',
    'CurrentWeatherSection',
    'ScenarioSimulationSection',
    'CctvInvestigationSection',
    'RecordedVideoEvidenceSection',
    'AIAssistantSection',
    'SystemPipelineSection',
    'ProvenanceLegend',
    'OverviewSection',
    'TrafficSection',
    'RouteSelectionArea',
    'DataFooter',
  ]) {
    assert.match(appSrc, new RegExp(name), name);
  }
});

test('floating assistant drawer is wired with local mode', () => {
  const appSrc = readFileSync(join(srcDir, 'App.jsx'), 'utf-8');
  assert.match(appSrc, /assistantOpen/);
  assert.match(appSrc, /onClose=\{setAssistantOpen\}/);
  const drawerSrc = readComponent('AIAssistantSection.jsx');
  assert.match(drawerSrc, /assistant-drawer/);
  assert.match(drawerSrc, /assistant-fab/);
  assert.match(drawerSrc, /LOCAL ASSISTANT/);
});

test('map component stays canned: clickable multi-route with colour legend', () => {
  const mapSrc = readComponent('MapView.jsx');
  assert.match(mapSrc, /leaflet\/dist\/leaflet\.css/);
  assert.match(mapSrc, /map-container/);
  assert.match(mapSrc, /onSelectRoute/);
  assert.match(mapSrc, /ROUTE_COLORS/);
});

test('real route section never draws demo routes or imports demo evidence', () => {
  const routeSrc = readComponent('RealRouteSection.jsx');
  assert.doesNotMatch(routeSrc, /RouteSelectionArea|from '\.\/RouteSection'/);
  assert.doesNotMatch(routeSrc, /phase9e|getRoutes\(/i);
  assert.match(routeSrc, /routeDeltas/);
  assert.match(routeSrc, /routeTags/);
});

test('no fabricated tracking values in the Track Explorer', () => {
  const explorer = readComponent('TrackExplorerPanel.jsx');
  assert.match(explorer, /getTrackSummaries/);
  assert.match(explorer, /getTrackTrajectories/);
  assert.match(explorer, /getValidation/);
  assert.doesNotMatch(explorer, /class car.*=.*78|car.*78|motorcycle.*34|bus.*5|truck.*4|bicycle.*1/);
  assert.match(explorer, /never reruns YOLO|no detection or tracking was rerun/i);
  assert.match(explorer, /sampled to ≥?220 or ≤220|downsampled for display/i);
});

test('evidence prep script is read-only over the protected outputs', () => {
  const script = readFileSync(join(__dirname, 'prepare_evidence.mjs'), 'utf-8');
  assert.match(script, /READ-ONLY over protected data/i);
  assert.match(script, /NEVER modifies protected files|never modifies|NEVER regenerates analysis|never regenerates/i);
  assert.doesNotMatch(script, /writeFileSync.*PROCESSED|join\(PROCESSED_DIR,.*writeFileSync/s);
});

test('demo CCTV manifest exists, is valid JSON, and registers exactly 3 routes × 3 recorded cameras', () => {
  const manifest = JSON.parse(
    readFileSync(join(srcDir, 'data', 'demoCctvManifest.json'), 'utf-8')
  );
  assert.equal(typeof manifest, 'object');
  assert.equal(manifest.kind, 'DEMO RECORDED CCTV REGISTRY');
  assert.ok(Array.isArray(manifest.routes), 'routes is a list');
  assert.equal(manifest.routes.length, 3, 'exactly 3 routes registered');
  assert.equal(manifest.honesty.live, false, 'registry is never live');
  assert.equal(manifest.honesty.geographicallyMapped, false, 'registry is never geographically mapped');
  assert.equal(manifest.honesty.label, 'RECORDED DEMO');
  for (const route of manifest.routes) {
    assert.ok(Array.isArray(route.cameras), `${route.route_id} camera list exists`);
    assert.equal(route.cameras.length, 3, `${route.route_id} has exactly 3 recorded sources`);
    assert.ok(/^CCTV-[ABC]\d{2}$/.test(route.cameras[0].cctv_id), 'registry ids follow CCTV-<route><index>');
  }
  const ids = manifest.routes.flatMap((r) => r.cameras.map((c) => c.cctv_id));
  assert.equal(new Set(ids).size, 9, 'all 9 camera ids are unique across routes');
  for (const cam of manifest.routes.flatMap((r) => r.cameras)) {
    assert.match(cam.video, /\.mp4$/, 'each camera points at a recorded dataset clip');
  }
});

test('demo CCTV prep script is additive and read-only over protected outputs', () => {
  const script = readFileSync(join(__dirname, 'prepare_demo_cctv.mjs'), 'utf-8');
  assert.match(script, /no training run/i);
  assert.match(script, /NOT executed/i);
  assert.match(script, /weights/);
  assert.match(script, /unchanged/i);
  assert.doesNotMatch(script, /writeFileSync|appendFileSync|mkdirSync|copyFileSync|renameSync/, 'prep script never writes');
  assert.doesNotMatch(script, /exec\(|spawn\(|child_process/, 'prep script never shells out to a training job');
});

test('package.json exposes prepare:demo:cctv without touching protected data scripts', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
  assert.match(pkg.scripts['prepare:demo:cctv'], /prepare_demo_cctv\.mjs/);
  assert.match(pkg.scripts['prepare:demo:cctv'], /node/);
  assert.ok(!/write|format|copy.*protected/i.test(JSON.stringify(pkg.scripts['prepare:demo:cctv'])));
});

// ---------------------------------------------------------------
// Frontend CCTV playback + evidence presentation (this task)
// ---------------------------------------------------------------

test('demoCctvVideoUrl builds the /demo-cctv stream URL for a route+video', () => {
  assert.equal(
    demoCctvVideoUrl('route_b', 'CCTV-B02.mp4'),
    '/demo-cctv/route_b/CCTV-B02.mp4'
  );
  assert.match(demoCctvVideoUrl('route_a', 'CCTV-A01.mp4'), /^\/demo-cctv\/route_a\/CCTV-A01\.mp4$/);
  assert.equal(demoCctvVideoUrl('route_c', 'CCTV-C 03.mp4'), '/demo-cctv/route_c/CCTV-C%2003.mp4');
  assert.equal(demoCctvVideoUrl(null, null), '/demo-cctv//');
});

test('findCameraEvidence matches by cctv_id and returns null when unmatched', () => {
  const evidence = [
    { cctv_id: 'CCTV-A01', source_video: 'CCTV-A01.mp4' },
    { cctv_id: 'CCTV-B01', source_video: 'CCTV-B01.mp4' },
  ];
  assert.deepEqual(findCameraEvidence('CCTV-B01', evidence), evidence[1]);
  assert.equal(findCameraEvidence('CCTV-C01', evidence), null, 'never a fabricated row');
  assert.equal(findCameraEvidence('CCTV-A01', []), null);
  assert.equal(findCameraEvidence('CCTV-A01', null), null);
  assert.equal(findCameraEvidence('CCTV-A01', 'not-an-array'), null);
});

test('the 9 registered cameras each produce a distinct stream URL and carry matching evidence', () => {
  const manifest = JSON.parse(readFileSync(join(srcDir, 'data', 'demoCctvManifest.json'), 'utf-8'));
  const evidence = getDemoCctvEvidence().cameraEvidence || [];
  assert.ok(evidence.length > 0, 'prepared evidence exists');
  const urls = [];
  for (const route of manifest.routes) {
    for (const cam of route.cameras) {
      const row = findCameraEvidence(cam.cctv_id, evidence);
      assert.ok(row, `${cam.cctv_id} has prepared evidence`);
      assert.match(row.source_video, /\.mp4$/, `${cam.cctv_id} records a real clip filename`);
      const url = demoCctvVideoUrl(route.route_id, row.source_video);
      assert.match(url, new RegExp(`^\\/demo-cctv\\/${route.route_id}\\/${row.source_video.replace(/\./, '\\.')}$`));
      urls.push(url);
    }
  }
  assert.equal(new Set(urls).size, 9, '9 distinct playable URLs, no collisions');
});

test('route intelligence still routes the 9 registered cameras through tripIntel.cctv.byRoute (§1 evidence source)', () => {
  const manifest = JSON.parse(readFileSync(join(srcDir, 'data', 'demoCctvManifest.json'), 'utf-8'));
  const evidence = getDemoCctvEvidence().cameraEvidence || [];
  manifest.routes.forEach((route, index) => {
    const cameras = demoCctvForRoute({ routeId: `route${index + 1}`, routeIndex: index, cctvEvidence: evidence });
    assert.equal(cameras.length, ROUTE_CCTV_CONTRACT.slotsPerRoute, `${route.route_id} → 3 cameras`);
    for (const cam of cameras) {
      assert.equal(cam.geographicallyMapped, false);
      assert.equal(cam.live, false);
      assert.equal(cam.id, cam.cctv_id);
      assert.ok(cam.traffic_metrics && cam.traffic_metrics.activity_condition, `${cam.cctv_id} exposes evidence fields`);
    }
  });
});

test('CCTV view (component source) keeps the honesty labels and the no-registry empty state', () => {
  const src = readComponent('CctvInvestigationSection.jsx');
  assert.match(src, /RECORDED DEMO/);
  assert.match(src, /NOT LIVE/);
  assert.match(src, /not geographically mapped/);
  assert.match(src, /INVESTIGATION_SOURCE_NOTE/);
  assert.match(src, /geographicallyMapped/);
  assert.doesNotMatch(src, /camera marker|new camera/i);
  assert.match(src, /no recorded-demo CCTV registered/);
  assert.match(src, /no fabricated cameras|fabricated/i);
  assert.match(src, /demoCctvVideoUrl/);
  assert.match(src, /findCameraEvidence/);
  assert.match(src, /tripIntel\.cctv\.byRoute|byRoute\[\s*selectedKey\s*\]/);
  assert.ok(src.includes('cctv-investigation'), 'compact investigation layout class used');
  assert.ok(src.includes('cctv-evidence-panel'), 'evidence panel present');
  assert.ok(src.includes('cctv-source-scroll'), 'camera card list present');
  assert.doesNotMatch(src, /recordings\//, 'no hardcoded public recordings path in the component');
  assert.doesNotMatch(src, /\.mp4["']/, 'no quoted mp4 string literals in the component');
});

test('Evidence view (component source) reads the current evidence shape for observed activity', () => {
  const src = readComponent('RecordedVideoEvidenceSection.jsx');
  assert.match(src, /activity_condition/);
  assert.match(src, /conservative_tracks/);
  assert.match(src, /activity_rate_tracks_per_min/);
  assert.match(src, /activity_index_per_1000_frames/);
});

// ---------------------------------------------------------------
// Step 2 — Route Intelligence UI integration (source contract)
// ---------------------------------------------------------------

test('route reasoning panel (component source) shows every route + honest layer labels, never live CCTV', () => {
  const src = readComponent('RouteReasoningPanel.jsx');
  assert.match(src, /Array\.isArray\(routes\)\s*\?\s*routes\s*:\s*\[\]/, 'panel maps over every provider-returned route');
  assert.match(src, /Route weather — SIMULATED \/ DEMO/);
  assert.match(src, /Road condition — SIMULATED \/ DEMO/);
  assert.match(src, /Recorded CCTV vehicle activity/);
  assert.match(src, /Recorded demo evidence/);
  assert.match(src, /Data unavailable/);
  assert.match(src, /Why this route is assessed this way/);
  assert.match(src, /RECOMMENDED by the existing route-intelligence assessment/);
  assert.match(src, /routeSummaries/);
  assert.match(src, /intel\.cctv\.byRoute|intel\.traffic\.byRoute|intel\.road\.byRoute|intel\.routeWeather\.byRoute/);
  assert.match(src, /onSelectRoute/, 'card selection uses the existing route-selection path');
  assert.doesNotMatch(src, /LIVE CCTV|Live CCTV/i, 'never claims live CCTV');
  assert.doesNotMatch(src, /LIVE congestion|live congestion/i, 'never claims live congestion');
  assert.doesNotMatch(src, /Real-time congestion|real-time congestion/i, 'never claims real-time congestion');
  assert.doesNotMatch(src, /Live traffic\b/i, 'never claims live traffic');
  assert.doesNotMatch(src, /\.mp4["']|recordings\//, 'no hardcoded clip paths in the panel');
});