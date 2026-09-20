/**
 * Service-layer test suite for the route-intelligence / geolocation / trip-service
 * and assistant-integration layers. These are pure-function tests that run under
 * Node (no jsdom, no bundle) and verify the new backend brain of the trip
 * workflow, including:
 *
 *   1. Weights, scores, factor derivation and assessment determinism.
 *   2. Demo CCTV data model fields (recorded-demo registry CCTV-A01 … CCTV-C03),
 *      enriched from the NEW demo CCTV evidence (demo_cctv_traffic_evidence.json).
 *   3. Evidence-derived traffic / vehicle activity numbers exactly matching the
 *      recorded demo CCTV evidence (activity_index_per_1000_frames etc).
 *   4. Weather-impact factor mapping and unknown exclusion.
 *   5. Rank-and-recommend logic (unique winner, ties, insufficient data).
 *   6. ComposeTripIntelligence producing deterministic recommendation + layers.
 *   7. Geolocation provider honest states (live / denied / unavailable).
 *   8. TripService analyzeRealRoutes originCoords bypass and enrichRoutes snapshot.
 *   9. Assistant recommendation + route-specific CCTV actions.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Evidence fixtures.
//
// The demo CCTV evidence is the REAL prepared file
// (src/data/demoCctvEvidence.json ← data/demo_processed_cctv/demo_cctv_traffic_evidence.json),
// so the tests assert against the actual recorded vehicle-activity values.
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));

const DEMO_CCTV_EVIDENCE_RAW = JSON.parse(
  readFileSync(join(__dirname, '..', 'src', 'data', 'demoCctvEvidence.json'), 'utf-8')
);

// Mirrors dataService.getDemoCctvEvidence()'s app-facing shape exactly so the
// tests exercise the same evidence object the browser receives.
const DEMO_CCTV_EVIDENCE = {
  source: DEMO_CCTV_EVIDENCE_RAW.generated_from,
  status: { status: 'DEMO', note: 'Recorded demo CCTV evidence — not live and not geographically mapped' },
  live: DEMO_CCTV_EVIDENCE_RAW.live,
  geographicallyMapped: DEMO_CCTV_EVIDENCE_RAW.geographically_mapped,
  normalizedMetric: DEMO_CCTV_EVIDENCE_RAW.normalized_metric,
  cameraEvidence: DEMO_CCTV_EVIDENCE_RAW.camera_evidence || [],
  routeSummary: DEMO_CCTV_EVIDENCE_RAW.route_summary || [],
  limitations: DEMO_CCTV_EVIDENCE_RAW.limitations || [],
};

const CAMERAS_BY_ID = (DEMO_CCTV_EVIDENCE.cameraEvidence || []).reduce((acc, c) => {
  acc[c.cctv_id] = c;
  return acc;
}, {});

const ROAD_ROWS = [
  { overall_road_condition: 'GOOD', road_risk: 'LOW' },
  { overall_road_condition: 'MODERATE', road_risk: 'MODERATE' },
  { overall_road_condition: 'POOR', road_risk: 'HIGH' },
  { overall_road_condition: 'GOOD', road_risk: 'LOW' },
  { overall_road_condition: 'MODERATE', road_risk: 'MODERATE' },
  { overall_road_condition: 'POOR', road_risk: 'HIGH' },
  { overall_road_condition: 'GOOD', road_risk: 'LOW' },
  { overall_road_condition: 'MODERATE', road_risk: 'MODERATE' },
];

const EVIDENCE = { demoCctvEvidence: DEMO_CCTV_EVIDENCE, roadRows: ROAD_ROWS };

const MOCK_ROUTES = [
  { id: 'real-route-1', name: 'Route via NH 48', distanceKm: 10, durationMin: 20, source: 'OSRM' },
  { id: 'real-route-2', name: 'Route via Madurai Road', distanceKm: 12.4, durationMin: 24, source: 'OSRM' },
  { id: 'real-route-3', name: 'Route via NH 38', distanceKm: 9.8, durationMin: 19, source: 'OSRM' },
];

const MOCK_WEATHER = { temperatureC: 34.5, precipitationMm: 0, weatherCode: 1, windSpeedKmh: 6.6, description: 'Clear sky' };
const MOCK_WEATHER_RAIN = { temperatureC: 28, precipitationMm: 8, weatherCode: 95, windSpeedKmh: 15, description: 'Thunderstorm' };

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import {
  ROUTE_WEIGHTS,
  MIN_KNOWN_WEIGHT,
  TRAFFIC_PROVIDER,
  CCTV_PROVIDER,
  ROAD_CONDITION_PROVIDER,
  ROUTE_WEATHER_PROVIDER,
  ROUTE_INTELLIGENCE_LAYER_NOTE,
  DEMO_SEGMENT_VIDEOS,
  DEMO_SEGMENT_COUNT,
  DEMO_ACTIVITY_TO_TRAFFIC_LEVEL,
  segmentIdsForRoute,
  routeNumberFrom,
  demoCctvForRoute,
  trafficLevelFromActivity,
  trafficForRoute,
  trafficLevelScore,
  roadConditionForRoute,
  weatherImpactLevel,
  assessRoute,
  buildExplanation,
  rankRoutes,
  composeTripIntelligence,
  describeLayers,
  routeEvidenceStatus,
  ROUTE_EVIDENCE_GEO_NOTE,
  ROUTE_ASSESSMENT_STATUSES,
} from '../src/services/routeIntelligence.js';

import { createLocationProvider, locationCard, LOCATION_STATES, LOCATION_STATUS_TEXT, LOCATION_UNAVAILABLE_MESSAGE } from '../src/services/geolocation.js';
import { createTripService } from '../src/services/tripService.js';
import { classifyIntent, buildReply, INTENT } from '../src/services/aiAssistant.js';

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------
describe('routeIntelligence constants and weights', () => {
  it('ROUTE_WEIGHTS sums to 100', () => {
    const total = Object.values(ROUTE_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.equal(total, 100);
  });

  it('MIN_KNOWN_WEIGHT is 35', () => {
    assert.equal(MIN_KNOWN_WEIGHT, 35);
  });

  it('DEMO_SEGMENT_VIDEOS has exactly 3 routes × 3 segments', () => {
    assert.equal(DEMO_SEGMENT_VIDEOS.length, 3);
    DEMO_SEGMENT_VIDEOS.forEach((arr) => assert.equal(arr.length, 3));
  });

  it('segmentIdsForRoute produces ordinal demo IDs', () => {
    const ids = segmentIdsForRoute('real-route-2');
    assert.deepEqual(ids, ['real-route-2:seg-1', 'real-route-2:seg-2', 'real-route-2:seg-3']);
  });

  it('routeNumberFrom extracts 1-based route number from free text', () => {
    assert.equal(routeNumberFrom('Show CCTV for route 2'), 2);
    assert.equal(routeNumberFrom('show cctv for route 1'), 1);
    assert.equal(routeNumberFrom('route 3'), 3);
    assert.equal(routeNumberFrom('route 0'), null);
    assert.equal(routeNumberFrom('my route'), null);
    assert.equal(routeNumberFrom(null), null);
  });

  it('provider mode constants are honest', () => {
    assert.equal(TRAFFIC_PROVIDER.mode, 'DEMO');
    assert.equal(CCTV_PROVIDER.mode, 'DEMO');
    assert.equal(ROAD_CONDITION_PROVIDER.mode, 'SIMULATED');
    assert.equal(ROUTE_WEATHER_PROVIDER.mode, 'SIMULATED');
  });
});

describe('DEMO_ACTIVITY_TO_TRAFFIC_LEVEL mapping', () => {
  it('maps demo vehicle-activity conditions to the existing scoring levels transparently', () => {
    assert.equal(DEMO_ACTIVITY_TO_TRAFFIC_LEVEL.LOW, 'LOW');
    assert.equal(DEMO_ACTIVITY_TO_TRAFFIC_LEVEL.MODERATE, 'MODERATE');
    assert.equal(DEMO_ACTIVITY_TO_TRAFFIC_LEVEL.HIGH, 'CONGESTED');
    assert.equal(DEMO_ACTIVITY_TO_TRAFFIC_LEVEL.VERY_HIGH, 'CONGESTED');
  });

  it('trafficLevelFromActivity returns null for unknown/empty conditions (never invented)', () => {
    assert.equal(trafficLevelFromActivity('UNKNOWN'), null);
    assert.equal(trafficLevelFromActivity(null), null);
    assert.equal(trafficLevelFromActivity(undefined), null);
    assert.equal(trafficLevelFromActivity(''), null);
  });

  it('all registered demo cameras carry an activity_condition that maps to a level', () => {
    (DEMO_CCTV_EVIDENCE.cameraEvidence || []).forEach((cam) => {
      assert.ok(cam.activity_condition, `${cam.cctv_id} has activity_condition`);
      assert.ok(trafficLevelFromActivity(cam.activity_condition), `${cam.cctv_id} maps to a traffic level`);
    });
  });

  it('every registry camera (Route 1–3) is matched by cctv_id to prepared evidence', () => {
    [0, 1, 2].forEach((routeIndex) => {
      demoCctvForRoute({ routeId: `real-route-${routeIndex + 1}`, routeIndex, cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence })
        .forEach((cam) => {
          const evidence = CAMERAS_BY_ID[cam.cctv_id];
          assert.ok(evidence, `${cam.cctv_id} has evidence in demoCctvEvidence.cameraEvidence`);
          assert.equal(evidence.activity_condition, cam.traffic_metrics.activity_condition,
            `${cam.cctv_id} metrics come from the evidence, not a lookup table`);
        });
    });
  });
});

describe('trafficLevelScore', () => {
  it('LOW → 90, MODERATE → 70, CONGESTED → 45, unknown → null', () => {
    assert.equal(trafficLevelScore('LOW'), 90);
    assert.equal(trafficLevelScore('MODERATE'), 70);
    assert.equal(trafficLevelScore('CONGESTED'), 45);
    assert.equal(trafficLevelScore('UNKNOWN'), null);
    assert.equal(trafficLevelScore(null), null);
  });
});

describe('trafficForRoute', () => {
  it('Route 1 is CONGESTED-dominant (2 of 3 cameras VERY_HIGH) with recorded activity values', () => {
    const t = trafficForRoute({ routeId: 'real-route-1', routeIndex: 0, cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence });
    assert.equal(t.level, 'CONGESTED');
    assert.equal(t.knownSegments, 3);
    assert.equal(t.segments.length, 3);
    assert.equal(t.segments[0].video, 'traffic.mp4');
    assert.equal(t.segments[0].activityCondition, 'VERY_HIGH');
    assert.equal(t.segments[0].activityRate, 215.856); // CCTV-A01 activity_rate_tracks_per_min
    assert.equal(t.segments[0].vehicles, 216);         // CCTV-A01 conservative_tracks
    assert.equal(t.segments[0].activityIndex, 143.904); // CCTV-A01 activity_index_per_1000_frames
    assert.equal(t.layer, 'DEMO');
    assert.match(t.label, /CONGESTED/);
    assert.match(t.label, /recorded demo CCTV vehicle-activity/);
    assert.match(t.label, /not live congestion/i);
  });

  it('Route 2 is CONGESTED-dominant with the real recorded conservative-track counts', () => {
    const t = trafficForRoute({ routeId: 'real-route-2', routeIndex: 1, cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence });
    assert.equal(t.level, 'CONGESTED');
    assert.equal(t.knownSegments, 3);
    assert.match(t.label, /CONGESTED/);
    assert.equal(t.vehicleEstimate, 75); // 28 + 45 + 2 conservative_tracks
    assert.equal(t.segments[0].cctvId, 'CCTV-B01');
    assert.equal(t.segments[0].activityCondition, 'VERY_HIGH');
  });

  it('Route 3 is CONGESTED-dominant (2 of 3 cameras HIGH)', () => {
    const t = trafficForRoute({ routeId: 'real-route-3', routeIndex: 2, cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence });
    assert.equal(t.level, 'CONGESTED');
    assert.equal(t.knownSegments, 3);
    assert.equal(t.segments[0].cctvId, 'CCTV-C01');
    assert.equal(t.segments[0].activityCondition, 'HIGH');
    assert.equal(t.vehicleEstimate, 391); // 375 + 1 + 15
  });
});

describe('weatherImpactLevel', () => {
  it('unknown when no weather data', () => {
    const r = weatherImpactLevel(null);
    assert.equal(r.level, 'unknown');
    assert.equal(r.known, false);
    assert.equal(r.score, null);
  });

  it('none when precipitation = 0', () => {
    const r = weatherImpactLevel({ precipitationMm: 0, weatherCode: 1 });
    assert.equal(r.level, 'none');
    assert.equal(r.known, true);
    assert.equal(r.score, 100);
  });

  it('high when precipitation > 5', () => {
    const r = weatherImpactLevel({ precipitationMm: 8, weatherCode: 95 });
    assert.equal(r.level, 'high');
    assert.equal(r.known, true);
    assert.equal(r.score, 55);
  });

  it('high from weather code 95', () => {
    const r = weatherImpactLevel({ precipitationMm: null, weatherCode: 95 });
    assert.equal(r.level, 'high');
    assert.equal(r.known, true);
  });

  it('moderate from weather code 61', () => {
    const r = weatherImpactLevel({ precipitationMm: null, weatherCode: 61 });
    assert.equal(r.level, 'moderate');
    assert.equal(r.known, true);
    assert.equal(r.score, 75);
  });

  it('low from weather code 48', () => {
    const r = weatherImpactLevel({ precipitationMm: null, weatherCode: 48 });
    assert.equal(r.level, 'low');
    assert.equal(r.known, true);
    assert.equal(r.score, 90);
  });
});

describe('demoCctvForRoute CCTV data model', () => {
  const cameras = demoCctvForRoute({
    routeId: 'real-route-2',
    routeIndex: 1,
    cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence,
  });

  it('returns exactly 3 cameras', () => {
    assert.equal(cameras.length, 3);
  });

  it('each camera has the full CCTV data model fields', () => {
    const required = [
      'camera_id', 'route_id', 'route_segment_id', 'video_id', 'video_path',
      'timestamp', 'status', 'source_type', 'analysis_status', 'traffic_metrics',
    ];
    cameras.forEach((cam) => {
      required.forEach((field) => {
        assert.ok(field in cam, `camera ${cam.id} missing field ${field}`);
      });
    });
  });

  it('route 2 cameras are the registry ids CCTV-B01, CCTV-B02, CCTV-B03', () => {
    const ids = cameras.map((c) => c.id);
    assert.deepEqual(ids, ['CCTV-B01', 'CCTV-B02', 'CCTV-B03']);
  });

  it('each camera route_segment_id matches the ordinal segment', () => {
    assert.equal(cameras[0].route_segment_id, 'real-route-2:seg-1');
    assert.equal(cameras[1].route_segment_id, 'real-route-2:seg-2');
    assert.equal(cameras[2].route_segment_id, 'real-route-2:seg-3');
  });

  it('traffic_metrics carry the recorded evidence values (CCTV-B01)', () => {
    const cam = cameras[0]; // CCTV-B01
    assert.equal(cam.traffic_metrics.activity_condition, 'VERY_HIGH');
    assert.equal(cam.traffic_metrics.activity_index_per_1000_frames, 186.667);
    assert.equal(cam.traffic_metrics.conservative_tracks, 28);
    assert.equal(cam.traffic_metrics.activity_rate_tracks_per_min, 280);
    assert.equal(cam.traffic_metrics.total_frames, 150);
    assert.equal(cam.traffic_metrics.duration_seconds, 6);
    assert.equal(cam.traffic_metrics.traffic_condition, 'CONGESTED');
  });

  it('geographicallyMapped is always false (DEMO, not on real route)', () => {
    cameras.forEach((cam) => assert.equal(cam.geographicallyMapped, false));
  });

  it('video_path references recordings/', () => {
    cameras.forEach((cam) => assert.match(cam.video_path, /^recordings\//));
  });

  it('status is recorded and source_type is DEMO / RECORDED', () => {
    cameras.forEach((cam) => {
      assert.equal(cam.status, 'recorded');
      assert.match(cam.source_type, /DEMO/);
    });
  });

  it('route 1 cameras use traffic.mp4 (×2) + low traffic.mp4', () => {
    const r1 = demoCctvForRoute({ routeId: 'real-route-1', routeIndex: 0, cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence });
    assert.deepEqual(
      r1.map((c) => c.video),
      ['traffic.mp4', 'traffic.mp4', 'low traffic.mp4']
    );
  });

  it('route 3 cameras use low traffic.mp4 (×2) + traffic.mp4', () => {
    const r3 = demoCctvForRoute({ routeId: 'real-route-3', routeIndex: 2, cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence });
    assert.deepEqual(
      r3.map((c) => c.video),
      ['low traffic.mp4', 'low traffic.mp4', 'traffic.mp4']
    );
  });

  it('each of Route 1, Route 2 and Route 3 has exactly 3 assigned demo sources', () => {
    [0, 1, 2].forEach((routeIndex) => {
      const cams = demoCctvForRoute({
        routeId: `real-route-${routeIndex + 1}`,
        routeIndex,
        cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence,
      });
      assert.equal(cams.length, 3, `route ${routeIndex + 1} → 3 sources`);
    });
  });

  it('route selection changes the source set (no cross-route leakage)', () => {
    const sets = [0, 1, 2].map((routeIndex) =>
      demoCctvForRoute({
        routeId: `real-route-${routeIndex + 1}`,
        routeIndex,
        cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence,
      }).map((c) => c.id)
    );
    assert.deepEqual(sets[0], ['CCTV-A01', 'CCTV-A02', 'CCTV-A03']);
    assert.deepEqual(sets[1], ['CCTV-B01', 'CCTV-B02', 'CCTV-B03']);
    assert.deepEqual(sets[2], ['CCTV-C01', 'CCTV-C02', 'CCTV-C03']);
    const all = sets.flat();
    assert.equal(new Set(all).size, all.length, 'no source id reused across routes');
  });
});

describe('roadConditionForRoute', () => {
  it('Route 1 segments cycle through ROAD_ROWS deterministically', () => {
    const r = roadConditionForRoute({ routeId: 'real-route-1', routeIndex: 0, roadRows: ROAD_ROWS });
    assert.equal(r.knownSegments, 3);
    assert.equal(r.layer, 'SIMULATED');
    assert.match(r.source, /SIMULATED/);
    assert.equal(r.segments[0].condition, 'GOOD');
    assert.equal(r.segments[1].condition, 'MODERATE');
    assert.equal(r.segments[2].condition, 'POOR');
  });

  it('Route 2 segments start at row index 3', () => {
    const r = roadConditionForRoute({ routeId: 'real-route-2', routeIndex: 1, roadRows: ROAD_ROWS });
    assert.equal(r.segments[0].condition, 'GOOD');
    assert.equal(r.segments[1].condition, 'MODERATE');
    assert.equal(r.segments[2].condition, 'POOR');
  });

  it('empty roadRows yields knownSegments 0', () => {
    const r = roadConditionForRoute({ routeId: 'real-route-1', routeIndex: 0, roadRows: [] });
    assert.equal(r.knownSegments, 0);
    assert.equal(r.segments[0].known, false);
  });
});

describe('assessRoute', () => {
  const traffic1 = trafficForRoute({ routeId: 'real-route-1', routeIndex: 0, cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence });
  const traffic2 = trafficForRoute({ routeId: 'real-route-2', routeIndex: 1, cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence });
  const traffic3 = trafficForRoute({ routeId: 'real-route-3', routeIndex: 2, cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence });
  const road1 = roadConditionForRoute({ routeId: 'real-route-1', routeIndex: 0, roadRows: ROAD_ROWS });
  const road2 = roadConditionForRoute({ routeId: 'real-route-2', routeIndex: 1, roadRows: ROAD_ROWS });
  const road3 = roadConditionForRoute({ routeId: 'real-route-3', routeIndex: 2, roadRows: ROAD_ROWS });
  const wiNone = weatherImpactLevel(MOCK_WEATHER);
  const fastest = Math.min(...MOCK_ROUTES.map((r) => r.durationMin));

  it('all factors known: knownWeight = 100', () => {
    const a = assessRoute({ route: MOCK_ROUTES[0], traffic: traffic1, weatherImpact: wiNone, road: road1, fastestDuration: fastest });
    assert.equal(a.knownWeight, 100);
    assert.ok(a.score !== null);
    assert.equal(a.recommendationStatus, 'ELIGIBLE');
  });

  it('Route 3 (best road profile, fastest time) scores highest when all factors known', () => {
    const a1 = assessRoute({ route: MOCK_ROUTES[0], traffic: traffic1, weatherImpact: wiNone, road: road1, fastestDuration: fastest });
    const a2 = assessRoute({ route: MOCK_ROUTES[1], traffic: traffic2, weatherImpact: wiNone, road: road2, fastestDuration: fastest });
    const a3 = assessRoute({ route: MOCK_ROUTES[2], traffic: traffic3, weatherImpact: wiNone, road: road3, fastestDuration: fastest });
    assert.equal(a1.score, 77.9); // traffic 60 · weather 100 · road 73.33 · travel 95
    assert.equal(a2.score, 75.5); // traffic 60 · weather 100 · road 73.33 · travel 79.17
    assert.equal(a3.score, 81.7); // traffic 60 · weather 100 · road 88.33 · travel 100
    assert.ok(a3.score > a1.score, `R3 ${a3.score} > R1 ${a1.score}`);
    assert.ok(a3.score > a2.score, `R3 ${a3.score} > R2 ${a2.score}`);
  });

  it('unknown weather renormalizes: knownWeight drops, score still computable', () => {
    const wiUnknown = weatherImpactLevel(null);
    const a = assessRoute({ route: MOCK_ROUTES[1], traffic: traffic2, weatherImpact: wiUnknown, road: road2, fastestDuration: fastest });
    assert.equal(a.knownWeight, 100 - ROUTE_WEIGHTS.weather); // 75
    assert.ok(a.score !== null);
    assert.equal(a.factors.weather.known, false);
    assert.equal(a.factors.weather.weight, ROUTE_WEIGHTS.weather);
  });

  it('unknown weather: knownWeight = 75 still ≥ MIN_KNOWN_WEIGHT (35)', () => {
    const a = assessRoute({ route: MOCK_ROUTES[0], traffic: traffic1, weatherImpact: weatherImpactLevel(null), road: road1, fastestDuration: fastest });
    assert.ok(a.knownWeight >= MIN_KNOWN_WEIGHT);
  });

  it('fastest route (Route 3, 19 min) scores highest on travelTime', () => {
    const a3 = assessRoute({ route: MOCK_ROUTES[2], traffic: traffic3, weatherImpact: wiNone, road: road3, fastestDuration: fastest });
    assert.equal(a3.factors.travelTime.score, 100);
  });

  it('explanation references the recorded demo activity level only when known', () => {
    const a = assessRoute({ route: MOCK_ROUTES[1], traffic: traffic2, weatherImpact: wiNone, road: road2, fastestDuration: fastest });
    assert.ok(typeof a.explanation === 'string');
    assert.ok(a.explanation.length > 10);
    assert.match(a.explanation, /Route 2 shows congested/i);
    assert.match(a.explanation, /not live congestion/i);
  });
});

describe('rankRoutes', () => {
  const traffic1 = trafficForRoute({ routeId: 'real-route-1', routeIndex: 0, cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence });
  const traffic2 = trafficForRoute({ routeId: 'real-route-2', routeIndex: 1, cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence });
  const traffic3 = trafficForRoute({ routeId: 'real-route-3', routeIndex: 2, cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence });
  const road1 = roadConditionForRoute({ routeId: 'real-route-1', routeIndex: 0, roadRows: ROAD_ROWS });
  const road2 = roadConditionForRoute({ routeId: 'real-route-2', routeIndex: 1, roadRows: ROAD_ROWS });
  const road3 = roadConditionForRoute({ routeId: 'real-route-3', routeIndex: 2, roadRows: ROAD_ROWS });
  const wi = weatherImpactLevel(MOCK_WEATHER);
  const fastest = Math.min(...MOCK_ROUTES.map((r) => r.durationMin));
  const assessments = [
    assessRoute({ route: MOCK_ROUTES[0], traffic: traffic1, weatherImpact: wi, road: road1, fastestDuration: fastest }),
    assessRoute({ route: MOCK_ROUTES[1], traffic: traffic2, weatherImpact: wi, road: road2, fastestDuration: fastest }),
    assessRoute({ route: MOCK_ROUTES[2], traffic: traffic3, weatherImpact: wi, road: road3, fastestDuration: fastest }),
  ];

  it('unique highest score yields exactly one RECOMMENDED (Route 3)', () => {
    const ranked = rankRoutes(assessments);
    const recommended = ranked.filter((a) => a.recommendationStatus === 'RECOMMENDED');
    assert.equal(recommended.length, 1);
    assert.equal(recommended[0].routeId, 'real-route-3');
    assert.equal(recommended[0].isRecommended, true);
  });

  it('non-recommended routes are ELIGIBLE', () => {
    const ranked = rankRoutes(assessments);
    ranked.filter((a) => a.routeId !== 'real-route-3').forEach((a) => {
      assert.equal(a.recommendationStatus, 'ELIGIBLE');
      assert.equal(a.isRecommended, undefined);
    });
  });

  it('single-scored set yields ELIGIBLE (not RECOMMENDED)', () => {
    const single = [assessments[0]];
    const ranked = rankRoutes(single);
    assert.equal(ranked[0].recommendationStatus, 'ELIGIBLE');
  });

  it('tie yields no RECOMMENDED', () => {
    const tied = [
      { routeId: 'a', score: 80, recommendationStatus: 'ELIGIBLE' },
      { routeId: 'b', score: 80, recommendationStatus: 'ELIGIBLE' },
    ];
    const ranked = rankRoutes(tied);
    const rec = ranked.filter((a) => a.recommendationStatus === 'RECOMMENDED');
    assert.equal(rec.length, 0);
    ranked.forEach((a) => assert.equal(a.recommendationStatus, 'ELIGIBLE'));
  });

  it('missing scores are INSUFFICIENT_DATA', () => {
    const withNull = [
      { routeId: 'a', score: 80, recommendationStatus: 'ELIGIBLE' },
      { routeId: 'b', score: null, recommendationStatus: 'INSUFFICIENT_DATA' },
    ];
    const ranked = rankRoutes(withNull);
    assert.equal(ranked[1].recommendationStatus, 'INSUFFICIENT_DATA');
  });
});

describe('composeTripIntelligence', () => {
  const result = composeTripIntelligence({ routes: MOCK_ROUTES, weather: MOCK_WEATHER, evidence: EVIDENCE });

  it('deterministic recommendation is Route 3 (Route via NH 38)', () => {
    assert.ok(result.recommendation, 'recommendation present');
    assert.equal(result.recommendation.routeId, 'real-route-3');
    assert.equal(result.recommendation.routeName, 'Route via NH 38');
    assert.equal(result.recommendation.status, 'RECOMMENDED');
    assert.ok(typeof result.recommendation.explanation === 'string');
    assert.ok(typeof result.recommendation.why === 'string' && result.recommendation.why.length > 0,
      'recommendation carries an explicit, data-backed why');
  });

  it('per-route SIMULATED route weather is attached (deterministic)', () => {
    assert.ok(result.routeWeather.byRoute['real-route-1']);
    assert.ok(result.routeWeather.byRoute['real-route-2']);
    assert.ok(result.routeWeather.byRoute['real-route-3']);
    const rw = result.routeWeather.byRoute['real-route-2'];
    assert.equal(rw.layer, 'SIMULATED');
    assert.deepEqual(rw.segments.map((s) => s.state), ['CLOUDY', 'CLOUDY', 'CLOUDY']);
  });

  it('explanation calls out incomplete assessment when live weather is UNKNOWN', () => {
    const withNullWeather = composeTripIntelligence({ routes: MOCK_ROUTES, weather: null, evidence: EVIDENCE });
    const why = withNullWeather.assessments['real-route-3'].explanation;
    assert.match(why, /Assessment is incomplete: live weather is UNKNOWN and was excluded/);
  });

  it('all three routes have assessments keyed by routeId', () => {
    assert.ok(result.assessments['real-route-1']);
    assert.ok(result.assessments['real-route-2']);
    assert.ok(result.assessments['real-route-3']);
    ['real-route-1', 'real-route-2', 'real-route-3'].forEach((id) => {
      assert.ok(result.assessments[id].score !== null);
    });
  });

  it('cctv.byRoute has 3 routes × 3 cameras', () => {
    assert.deepEqual(Object.keys(result.cctv.byRoute).sort(), ['real-route-1', 'real-route-2', 'real-route-3']);
    Object.values(result.cctv.byRoute).forEach((cams) => assert.equal(cams.length, 3));
    assert.equal(result.cctv.cameras.length, 9);
  });

  it('traffic.byRoute has honest levels (all CONGESTED-dominant from the recorded evidence)', () => {
    assert.equal(result.traffic.byRoute['real-route-1'].level, 'CONGESTED'); // A01/A02 VERY_HIGH
    assert.equal(result.traffic.byRoute['real-route-2'].level, 'CONGESTED'); // B01/B02 VERY_HIGH
    assert.equal(result.traffic.byRoute['real-route-3'].level, 'CONGESTED'); // C01/C03 HIGH
  });

  it('weatherImpact matches live weather: none', () => {
    assert.equal(result.weatherImpact.level, 'none');
    assert.equal(result.weatherImpact.known, true);
  });

  it('layers disclosure includes all providers', () => {
    const layers = result.layers;
    assert.ok(Array.isArray(layers));
    const layerNames = layers.map((l) => l.layer);
    assert.ok(layerNames.includes('Routing'));
    assert.ok(layerNames.includes('Traffic'));
    assert.ok(layerNames.includes('CCTV'));
    assert.ok(layerNames.includes('Road condition'));
    assert.ok(layerNames.includes('Route weather'));
    assert.ok(layerNames.includes('Weather'));
    assert.equal(layers.length, 7);
  });

  it('unknown weather: recommendation absent or different', () => {
    const r2 = composeTripIntelligence({ routes: MOCK_ROUTES, weather: null, evidence: EVIDENCE });
    assert.equal(r2.weatherImpact.level, 'unknown');
    assert.equal(r2.weatherImpact.known, false);
    // Still has recommendation (traffic + road + travelTime known ≥ 35)
    assert.ok(r2.recommendation !== null);
    assert.equal(r2.recommendation.routeId, 'real-route-3'); // road + travelTime still favour Route 3
  });
});

describe('describeLayers', () => {
  it('weather LIVE when weather data provided', () => {
    const layers = describeLayers(MOCK_WEATHER);
    const w = layers.find((l) => l.layer === 'Weather');
    assert.ok(w);
    assert.equal(w.mode, 'LIVE');
  });

  it('weather UNAVAILABLE when null', () => {
    const layers = describeLayers(null);
    const w = layers.find((l) => l.layer === 'Weather');
    assert.equal(w.mode, 'UNAVAILABLE');
  });
});

describe('demoCctv registry + variable-length routes (never padded to 3)', () => {
  it('registry sources are RECORDED DEMO, NOT LIVE and NOT geographically mapped', () => {
    [0, 1, 2].forEach((routeIndex) => {
      const cams = demoCctvForRoute({
        routeId: `real-route-${routeIndex + 1}`,
        routeIndex,
        cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence,
      });
      cams.forEach((cam) => {
        assert.equal(cam.live, false, `${cam.id} is not live`);
        assert.equal(cam.geographically_mapped, false, `${cam.id} is not geographically mapped`);
        assert.equal(cam.status, 'recorded');
        assert.equal(cam.source_type, 'DEMO / RECORDED');
        assert.equal(cam.registry_route_id, ['route_a', 'route_b', 'route_c'][routeIndex]);
        assert.equal(cams.length, 3, 'registry defines 3 per demo route');
      });
    });
  });

  it('routes beyond the registry yield an EMPTY source list (honest, no padding)', () => {
    const empty = demoCctvForRoute({ routeId: 'real-route-9', routeIndex: 8, cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence });
    assert.deepEqual(empty, []);
  });

  it('variable-length trips compose without fabricating cameras or filling gaps', () => {
    const two = composeTripIntelligence({
      routes: [MOCK_ROUTES[0], MOCK_ROUTES[1]],
      weather: MOCK_WEATHER,
      evidence: EVIDENCE,
    });
    assert.equal(Object.keys(two.cctv.byRoute).length, 2);
    assert.equal(two.cctv.byRoute['real-route-1'].length, 3);
    assert.equal(two.cctv.byRoute['real-route-2'].length, 3);
    assert.equal(two.cctv.cameras.length, 6);
    assert.equal(Object.keys(two.routeWeather.byRoute).length, 2);

    const one = composeTripIntelligence({ routes: [MOCK_ROUTES[0]], weather: MOCK_WEATHER, evidence: EVIDENCE });
    assert.equal(Object.keys(one.cctv.byRoute).length, 1);
    assert.equal(one.cctv.cameras.length, 3);
    assert.ok(one.recommendation === null || one.recommendation.routeId === 'real-route-1',
      'single route never gets a fabricated recommendation');
  });

  it('a 4th route stays traffic-UNKNOWN, camera-empty and never steals another route\'s data', () => {
    const four = composeTripIntelligence({
      routes: [...MOCK_ROUTES, { id: 'real-route-4', name: 'Route via Kodaikanal Road', distanceKm: 20, durationMin: 40, source: 'OSRM' }],
      weather: MOCK_WEATHER,
      evidence: EVIDENCE,
    });
    assert.deepEqual(four.cctv.byRoute['real-route-4'], []);
    assert.equal(four.traffic.byRoute['real-route-4'].level, null);
    assert.equal(four.traffic.byRoute['real-route-4'].knownSegments, 0);
    assert.ok(four.assessments['real-route-4'] && four.assessments['real-route-4'].score !== null,
      'assessment still computes from the known factors only');
    assert.equal(Object.keys(four.cctv.byRoute['real-route-2']).length > 0, true);
    assert.deepEqual(
      four.cctv.byRoute['real-route-2'].map((c) => c.id),
      ['CCTV-B01', 'CCTV-B02', 'CCTV-B03'],
      'route 2 data unchanged by the extra route'
    );
  });

  it('DEMO_SEGMENT_VIDEOS is derived from the registry manifest', () => {
    assert.equal(DEMO_SEGMENT_VIDEOS.length, 3);
    assert.deepEqual(DEMO_SEGMENT_VIDEOS[1], ['no traffic video.mp4', 'no traffic video.mp4', 'no traffic video.mp4']);
  });
});

describe('geolocation provider', () => {
  it('unsupported navigator geolocation → unavailable', async () => {
    const provider = createLocationProvider({ geolocation: null });
    const result = await provider.detect();
    assert.equal(result.status, LOCATION_STATES.unavailable);
    assert.equal(result.code, 'unsupported');
    assert.equal(result.coords, null);
  });

  it('permission denied → denied', async () => {
    const fakeGeo = { getCurrentPosition: (ok, err) => err({ code: 1 }) };
    const provider = createLocationProvider({ geolocation: fakeGeo, timeoutMs: 1000 });
    const result = await provider.detect();
    assert.equal(result.status, LOCATION_STATES.denied);
    assert.equal(result.code, 'permission-denied');
  });

  it('timeout → unavailable', async () => {
    const fakeGeo = { getCurrentPosition: (ok, err) => err({ code: 3 }) };
    const provider = createLocationProvider({ geolocation: fakeGeo, timeoutMs: 1000 });
    const result = await provider.detect();
    assert.equal(result.status, LOCATION_STATES.unavailable);
    assert.equal(result.code, 'timeout');
  });

  it('success → live with real coordinates', async () => {
    const fakeGeo = {
      getCurrentPosition: (ok) => ok({ coords: { latitude: 12.925, longitude: 80.113, accuracy: 10 }, timestamp: 1700000000000 }),
    };
    const provider = createLocationProvider({ geolocation: fakeGeo });
    const result = await provider.detect();
    assert.equal(result.status, LOCATION_STATES.live);
    assert.equal(result.coords.lat, 12.925);
    assert.equal(result.coords.lon, 80.113);
    assert.equal(result.coords.accuracy, 10);
    assert.equal(result.coords.timestamp, 1700000000000);
  });

  it('getCurrentPosition throws → unavailable with exception code', async () => {
    const badGeo = { getCurrentPosition: () => { throw new Error('sync bomb'); } };
    const provider = createLocationProvider({ geolocation: badGeo });
    const result = await provider.detect();
    assert.equal(result.status, LOCATION_STATES.unavailable);
    assert.equal(result.code, 'exception');
  });
});

describe('locationCard', () => {
  it('live card shows LIVE status + coords', () => {
    const card = locationCard({ status: LOCATION_STATES.live, coords: { lat: 12.9, lon: 80.1, accuracy: 10, timestamp: 1700000000000 } });
    assert.equal(card.status, 'LIVE');
    assert.equal(card.coords.lat, 12.9);
    assert.match(card.note, /10 m/);
  });

  it('unavailable card shows UNKNOWN status + message', () => {
    const card = locationCard({ status: LOCATION_STATES.unavailable });
    assert.equal(card.status, 'UNKNOWN');
    assert.equal(card.note, LOCATION_UNAVAILABLE_MESSAGE);
    assert.equal(card.coords, null);
  });

  it('loading card shows STATIC + detecting text', () => {
    const card = locationCard({ status: LOCATION_STATES.loading });
    assert.equal(card.status, 'STATIC');
    assert.match(card.label, /DETECTING/);
  });

  it('denied card shows UNKNOWN + denied text', () => {
    const card = locationCard({ status: LOCATION_STATES.denied });
    assert.equal(card.status, 'UNKNOWN');
    assert.match(card.label, /DENIED/);
  });

  it('idle card defaults to PERMISSION REQUIRED', () => {
    const card = locationCard({});
    assert.equal(card.status, 'STATIC');
    assert.match(card.label, /PERMISSION REQUIRED/);
  });
});

describe('tripService', () => {
  it('analyzeRealRoutes with originCoords bypasses geocode for origin', async () => {
    let geocodeCalls = [];
    let routeCalls = [];
    const mockLocationService = {
      geocode: async (q) => { geocodeCalls.push(q); return { name: q, lat: 12.925, lon: 80.113 }; },
      route: async (o, d) => { routeCalls.push({ o, d }); return [{ id: 'real-route-1', distanceKm: 10, durationMin: 20 }]; },
      analyzeTrip: async () => { throw new Error('should NOT be called'); },
    };
    const svc = createTripService({ locationService: mockLocationService, evidence: EVIDENCE });
    const result = await svc.analyzeRealRoutes({
      origin: 'Chennai',
      destination: 'Madurai',
      originCoords: { lat: 12.9999, lon: 80.0001, name: 'My current location' },
    });
    assert.equal(geocodeCalls.length, 1, 'geocode called once for destination only');
    assert.equal(geocodeCalls[0], 'Madurai');
    assert.equal(routeCalls.length, 1);
    assert.equal(result.originResolved.lat, 12.9999);
    assert.equal(result.originResolved.lon, 80.0001);
    assert.equal(result.originResolved.name, 'My current location');
  });

  it('analyzeRealRoutes without originCoords uses analyzeTrip', async () => {
    let analyzeTripCalled = false;
    const mockLocationService = {
      analyzeTrip: async (o) => { analyzeTripCalled = true; return { originResolved: { name: o.origin }, destinationResolved: { name: o.destination }, routes: [] }; },
    };
    const svc = createTripService({ locationService: mockLocationService, evidence: EVIDENCE });
    await svc.analyzeRealRoutes({ origin: 'A', destination: 'B' });
    assert.equal(analyzeTripCalled, true);
  });

  it('enrichRoutes produces full intelligence snapshot', () => {
    const svc = createTripService({ evidence: EVIDENCE });
    const intel = svc.enrichRoutes({ routes: MOCK_ROUTES, weather: MOCK_WEATHER });
    assert.ok(intel.recommendation);
    assert.equal(intel.recommendation.routeId, 'real-route-3');
    assert.ok(intel.assessments['real-route-1'].score !== null);
  });

  it('layers() returns 7 provider layers', () => {
    const svc = createTripService({ evidence: EVIDENCE });
    const names = svc.layers().map((l) => l.layer);
    assert.equal(names.length, 7);
    assert.ok(names.includes('Route weather'));
  });
});

describe('routeEvidenceStatus — CCTV → ML evidence → route-level traffic observation', () => {
  const intel = composeTripIntelligence({ routes: MOCK_ROUTES, weather: MOCK_WEATHER, evidence: EVIDENCE });
  const traffic2 = intel.traffic.byRoute['real-route-2'];
  const road2 = intel.road.byRoute['real-route-2'];
  const cams2 = intel.cctv.byRoute['real-route-2'];
  const weatherImpact = intel.weatherImpact;
  const route2 = MOCK_ROUTES[1];

  it('Route 2 evidence: 3/3 CCTV sources, 3/3 ML evidence, DEMO traffic observation', () => {
    const s = routeEvidenceStatus({ route: route2, traffic: traffic2, road: road2, weatherImpact, cameras: cams2 });
    assert.equal(s.cctv.total, 3);
    assert.equal(s.cctv.mlEvidence, 3);
    assert.equal(s.traffic.mlEvidenceAvailable, 3);
    assert.equal(s.traffic.totalSources, 3);
    assert.equal(s.traffic.status, 'DEMO');
    assert.ok(s.traffic.observation, 'route-level traffic observation present');
    assert.equal(s.traffic.observation.level, 'CONGESTED');
    assert.equal(s.traffic.observation.vehicleEstimate, 75);
    assert.equal(s.weather.status, 'LIVE');
    assert.equal(s.weather.level, 'none');
    assert.equal(s.road.status, 'SIMULATED');
    assert.equal(s.road.condition, 'GOOD');
    assert.equal(s.travel.status, 'REAL');
    assert.equal(s.travel.distanceKm, 12.4);
    assert.equal(s.travel.durationMin, 24);
    assert.deepEqual(s.evidenceStatuses, { demo: true, live: true, simulated: true, real: true, unknown: false });
    assert.equal(s.cctv.notGeographicallyVerified, true);
    assert.equal(s.associationNote, ROUTE_EVIDENCE_GEO_NOTE);
    assert.match(s.associationNote, /not geographically verified/);
  });

  it('ML evidence is only reported when a valid mapping exists per CCTV source', () => {
    const partialCams = DEMO_CCTV_EVIDENCE.cameraEvidence.filter((e) => e.route_id === 'route_c' && e.cctv_id !== 'CCTV-C02');
    const cams = demoCctvForRoute({ routeId: 'real-route-3', routeIndex: 2, cctvEvidence: partialCams });
    const traffic = trafficForRoute({ routeId: 'real-route-3', routeIndex: 2, cctvEvidence: partialCams });
    assert.equal(cams.filter((c) => c.traffic_metrics).length, 2, 'third source has no valid mapping');
    assert.equal(cams[1].analysis_status, 'UNKNOWN', 'CCTV-C02 has no evidence → UNKNOWN');
    assert.equal(cams[1].traffic_metrics, null, 'no fabricated metrics for the unmatched camera');
    const s = routeEvidenceStatus({
      route: MOCK_ROUTES[2],
      traffic,
      road: intel.road.byRoute['real-route-3'],
      weatherImpact,
      cameras: cams,
    });
    assert.equal(s.traffic.mlEvidenceAvailable, 2);
    assert.equal(s.traffic.totalSources, 3);
    assert.equal(s.cctv.mlEvidence, 2);
    assert.equal(s.traffic.status, 'DEMO', 'some mapping exists, stays DEMO');
    assert.equal(s.traffic.observation.knownSegments, 2);
  });

  it('unknown data is never converted into invented scores or observations', () => {
    const noCams = [];
    const s = routeEvidenceStatus({
      route: route2,
      traffic: { ...traffic2, knownSegments: 0, totalSegments: 3, level: null, label: 'UNKNOWN' },
      road: road2,
      weatherImpact,
      cameras: noCams,
    });
    assert.equal(s.traffic.mlEvidenceAvailable, 0);
    assert.equal(s.traffic.status, 'UNKNOWN');
    assert.equal(s.traffic.observation, null, 'no observation fabricated');
    assert.equal(s.evidenceStatuses.unknown, true);
    assert.equal(s.weather.status, 'LIVE', 'weather still independent and live');
    assert.equal(s.road.status, 'SIMULATED', 'road still independent and simulated');

    const emptyRoad = roadConditionForRoute({ routeId: 'real-route-2', routeIndex: 1, roadRows: [] });
    const s2 = routeEvidenceStatus({ route: route2, traffic: traffic2, road: emptyRoad, weatherImpact, cameras: cams2 });
    assert.equal(s2.road.status, 'UNKNOWN');

    const s3 = routeEvidenceStatus({ route: route2, traffic: traffic2, road: road2, weatherImpact: weatherImpactLevel(null), cameras: cams2 });
    assert.equal(s3.weather.status, 'UNKNOWN');
    assert.equal(s3.weather.level, null);

    const fullyUnknown = assessRoute({
      route: route2,
      traffic: null,
      weatherImpact: weatherImpactLevel(null),
      road: null,
      fastestDuration: null,
    });
    assert.equal(fullyUnknown.score, null);
    assert.equal(fullyUnknown.recommendationStatus, 'INSUFFICIENT_DATA');
  });

  it('all OSRM alternatives remain visible in the composed snapshot (no hiding)', () => {
    assert.equal(Object.keys(intel.segments).length, 3);
    assert.equal(Object.keys(intel.cctv.byRoute).length, 3);
    assert.equal(Object.keys(intel.traffic.byRoute).length, 3);
    assert.equal(Object.keys(intel.road.byRoute).length, 3);
    assert.equal(intel.recommendation && intel.recommendation.routeId ? 1 : 0, 1, 'recommendation computed, not invented');
  });
});

describe('assistant recommendation + cctv-route integration', () => {
  const readyState = {
    analysisStatus: 'ready',
    analysis: { routes: MOCK_ROUTES },
    recommendation: { routeId: 'real-route-2', routeName: 'Route via Madurai Road', score: 87.5, explanation: 'Low traffic across all demo segments.' },
    cctvPolicy: { kind: 'route-selected', resources: [{ id: 'CCTV-B01' }, { id: 'CCTV-B02' }, { id: 'CCTV-B03' }] },
    trip: { origin: 'Chennai', destination: 'Madurai' },
    weather: { status: 'ready', data: MOCK_WEATHER },
  };

  it('classifyIntent recommendation', () => {
    assert.equal(classifyIntent('Which route are you recommending?'), INTENT.recommendation);
    assert.equal(classifyIntent('What is the best route?'), INTENT.recommendation);
    assert.equal(classifyIntent('Why did you recommend route 1?'), INTENT.recommendation);
  });

  it('classifyIntent map navigation (show map / go to map / back to map)', () => {
    assert.equal(classifyIntent('show map'), INTENT.map);
    assert.equal(classifyIntent('go to map'), INTENT.map);
    assert.equal(classifyIntent('back to map'), INTENT.map);
    assert.equal(classifyIntent('show me the map'), INTENT.map);
    assert.equal(classifyIntent('Go back'), INTENT.back, 'plain go back stays a back command');
    assert.deepEqual(buildReply('go to map', {}).action, { type: 'SHOW_ROUTE' });
  });

  it('classifyIntent intelligence / investigation navigation', () => {
    assert.equal(classifyIntent('show intelligence'), INTENT.intelligence);
    assert.equal(classifyIntent('show route intelligence'), INTENT.intelligence);
    assert.equal(classifyIntent('show investigation'), INTENT.cctv);
    assert.equal(classifyIntent('show weather'), INTENT.weather);
  });

  it('"why is route N recommended?" uses recommendation.why and the route assessment explanation', () => {
    const state = {
      ...readyState,
      recommendation: {
        routeId: 'real-route-2',
        routeName: 'Route via Madurai Road',
        score: 87.5,
        explanation: 'Low traffic across all demo segments.',
        why: 'Preferred over Route via NH 38 on road condition: GOOD (80/100) vs RESTRICTED (60/100).',
      },
      assessments: {
        'real-route-2': {
          explanation:
            'Route 2 shows congested activity; simulated road condition (DEMO) is GOOD; estimated drive time is 24 min over 12.4 km.',
        },
      },
      selectedRealRoute: { id: 'real-route-2', name: 'Route via Madurai Road' },
    };
    const result = buildReply('why is route 2 recommended?', state);
    assert.equal(result.action.type, 'SHOW_ROUTE');
    assert.match(result.reply, /Route via Madurai Road/);
    assert.match(result.reply, /Why: Preferred over Route via NH 38/);
    assert.match(result.reply, /Selected route assessment:/);
    assert.doesNotMatch(result.reply, /I calculated it myself|my own scoring/i);
  });

  it('"show available CCTV footage through route 2" switches to route 2 registry cameras', () => {
    const state = {
      ...readyState,
      cctv: {
        byRoute: {
          'real-route-1': [{ id: 'CCTV-A01' }, { id: 'CCTV-A02' }, { id: 'CCTV-A03' }],
          'real-route-2': [{ id: 'CCTV-B01' }, { id: 'CCTV-B02' }, { id: 'CCTV-B03' }],
          'real-route-3': [{ id: 'CCTV-C01' }, { id: 'CCTV-C02' }, { id: 'CCTV-C03' }],
        },
      },
    };
    const result = buildReply('show available CCTV footage through route 2', state);
    assert.deepEqual(result.action, { type: 'SELECT_ROUTE', routeIndex: 1, openInvestigation: true });
    assert.match(result.reply, /CCTV-B01/);
    assert.match(result.reply, /CCTV-B02/);
    assert.match(result.reply, /CCTV-B03/);
    assert.doesNotMatch(result.reply, /CCTV-A01|CCTV-C01/, "never lists another route's cameras");
  });

  it('recommendingReply uses state.recommendation → SHOW_ROUTE', () => {
    const result = buildReply('Which route are you recommending?', readyState);
    assert.equal(result.action.type, 'SHOW_ROUTE');
    assert.match(result.reply, /Route via Madurai Road/);
    assert.match(result.reply, /87.5/);
  });

  it('cctvReply "Show CCTV for route 2" → SELECT_ROUTE routeIndex 1 + openInvestigation', () => {
    const result = buildReply('Show CCTV for route 2', readyState);
    assert.equal(result.action.type, 'SELECT_ROUTE');
    assert.equal(result.action.routeIndex, 1);
    assert.equal(result.action.openInvestigation, true);
    assert.match(result.reply, /Route via Madurai Road/);
  });

  it('cctvReply "Show CCTV for route 1" → SELECT_ROUTE routeIndex 0', () => {
    const result = buildReply('Show CCTV for route 1', readyState);
    assert.equal(result.action.type, 'SELECT_ROUTE');
    assert.equal(result.action.routeIndex, 0);
    assert.equal(result.action.openInvestigation, true);
  });

  it('cctvReply "Show CCTV for route 5" → falls through to no-route gating (out of bounds)', () => {
    const result = buildReply('Show CCTV for route 5', readyState);
    // routeNumberFrom returns 5 but routes.length = 3 → falls to gating path
    assert.equal(result.action.type, 'OPEN_INVESTIGATION');
  });

  it('old gating "Help me investigate CCTV" still works (no route number)', () => {
    const result = buildReply('Help me investigate CCTV', readyState);
    assert.equal(result.action.type, 'OPEN_INVESTIGATION');
    assert.match(result.reply, /3 demo resource/);
  });

  it('recommendation without state.recommendation → honest fallback', () => {
    const noRec = { ...readyState, recommendation: null };
    const result = buildReply('Which route are you recommending?', noRec);
    assert.equal(result.action.type, 'OPEN_INTELLIGENCE');
    assert.match(result.reply, /no recommendation is fabricated/i);
  });

  it('recommendation before analysis → honest fallback', () => {
    const preAnalysis = { ...readyState, analysisStatus: 'idle', recommendation: null };
    const result = buildReply('Which route are you recommending?', preAnalysis);
    assert.equal(result.action, null);
    assert.match(result.reply, /origin and destination first/);
  });
});

describe('Step 4 | evidence single source: demoCctvEvidence.json is generated from the processed demo CCTV evidence', () => {
  const PROCESSED = JSON.parse(
    readFileSync(
      join(__dirname, '..', '..', 'data', 'demo_processed_cctv', 'demo_cctv_traffic_evidence.json'),
      'utf-8'
    )
  );
  const FE = DEMO_CCTV_EVIDENCE_RAW.camera_evidence || [];

  it('both files expose the same 9 recorded cameras', () => {
    assert.equal(FE.length, 9);
    assert.equal((PROCESSED.camera_evidence || []).length, 9);
  });

  it('every evidence field matches the processed source exactly (no drift, no second source)', () => {
    const FIELDS = [
      'route_id',
      'cctv_id',
      'source_video',
      'activity_condition',
      'activity_index_per_1000_frames',
      'conservative_tracks',
      'activity_rate_tracks_per_min',
      'total_frames',
      'duration_seconds',
    ];
    const feBy = new Map(FE.map((c) => [c.cctv_id, c]));
    const psBy = new Map((PROCESSED.camera_evidence || []).map((c) => [c.cctv_id, c]));
    for (const id of ['CCTV-A01', 'CCTV-A02', 'CCTV-A03', 'CCTV-B01', 'CCTV-B02', 'CCTV-B03', 'CCTV-C01', 'CCTV-C02', 'CCTV-C03']) {
      const fe = feBy.get(id);
      const ps = psBy.get(id);
      assert.ok(fe, `frontend evidence has ${id}`);
      assert.ok(ps, `processed evidence has ${id}`);
      for (const f of FIELDS) {
        assert.equal(String(fe[f]), String(ps[f]), `${id}.${f} matches the processed source`);
      }
      assert.equal(fe.live, false, `${id} is never live`);
      assert.equal(fe.geographically_mapped, false, `${id} is never geographically mapped`);
    }
  });
});

describe('Step 4 | provider-route count independence (never assumes exactly 3 routes)', () => {
  const four = [...MOCK_ROUTES, { id: 'real-route-4', name: 'Route via NH 32', distanceKm: 11, durationMin: 21, source: 'OSRM' }];

  const analysisReady = (routes) => ({
    analysisStatus: 'ready',
    analysis: { routes },
    trip: { origin: 'Chennai', destination: 'Madurai' },
    weather: { status: 'ready', data: MOCK_WEATHER },
  });

  it('composeTripIntelligence keeps every provider route and registers only the 3 demo CCTV routes', () => {
    const intel = composeTripIntelligence({ routes: four, weather: MOCK_WEATHER, evidence: EVIDENCE });
    assert.equal(Object.keys(intel.assessments).length, 4, 'assessment per provider route (4 routes → 4 assessments)');
    assert.deepEqual(
      Object.keys(intel.assessments),
      four.map((r) => r.id),
      'assessments keyed by the exact provider route ids in order'
    );
    assert.equal(Object.keys(intel.cctv.byRoute).length, 4, 'a byRoute entry exists per provider route');
    assert.deepEqual(intel.cctv.byRoute['real-route-4'], [], 'route beyond the registry gets an honest EMPTY list');
    assert.equal(intel.cctv.byRoute['real-route-2'].length, 3, 'route 2 keeps its 3 registered cameras');
  });

  it('demoCctvForRoute never fabricates cameras for routes outside the registry', () => {
    assert.equal(demoCctvForRoute({ routeId: 'real-route-4', routeIndex: 3, cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence }).length, 0);
    assert.equal(demoCctvForRoute({ routeId: 'real-route-5', routeIndex: 4, cctvEvidence: DEMO_CCTV_EVIDENCE.cameraEvidence }).length, 0);
  });

  it('assistant route selection works for any provider count (2 and 5 routes)', () => {
    const two = analysisReady([MOCK_ROUTES[0], MOCK_ROUTES[1]]);
    assert.deepEqual(buildReply('show route 2', two).action, { type: 'SELECT_ROUTE', routeIndex: 1 });
    const five = analysisReady([...MOCK_ROUTES, { id: 'real-route-4' }, { id: 'real-route-5' }]);
    assert.deepEqual(buildReply('show route 5', five).action, { type: 'SELECT_ROUTE', routeIndex: 4 });
    assert.deepEqual(buildReply('show CCTV for route 5', five).action, { type: 'SELECT_ROUTE', routeIndex: 4, openInvestigation: true });
  });

  it('out-of-bounds route numbers fall back gracefully (never fabricated)', () => {
    const three = analysisReady(MOCK_ROUTES);
    const ui = buildReply('show route 9', three);
    assert.equal(ui.action.type, 'SHOW_ROUTE', 'out-of-bounds selection falls back to SHOW_ROUTE, not an invented route');
    const cctv = buildReply('show CCTV for route 9', three);
    assert.equal(cctv.action.type, 'OPEN_INVESTIGATION', 'out-of-bounds CCTV falls back to the existing gating, not a fabricated list');
  });
});
