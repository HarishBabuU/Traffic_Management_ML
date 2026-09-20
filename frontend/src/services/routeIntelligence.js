/**
 * Route Intelligence — the route-analysis backend/service layer.
 *
 * Pure, deterministic, frontend-agnostic reasoning over the recorded ML
 * evidence. This module is the "brain" of the trip workflow:
 *
 *   REAL ROUTES (OSRM road geometry + travel metrics)
 *     → DEMO route/segment model (ordinal segments, NOT geographic mapping)
 *     → DEMO CCTV registry per route (recorded, ML-analysed footage — the
 *       registry drives the CCTV view; never awaiting placeholders)
 *     → traffic intelligence (derived from the recorded demo CCTV evidence —
 *       activity_index_per_1000_frames / activity_condition in
 *       demo_cctv_traffic_evidence.json. This is a DEMO VEHICLE-ACTIVITY
 *       proxy, NOT a live congestion measurement.)
 *     → weather impact (LIVE provider result when available)
 *     → route weather (SIMULATED demo layer, labelled SIMULATED, never LIVE)
 *     → road condition (SIMULATED / DEMO layer until a real provider replaces it)
 *     → route assessment (configured weights, never a fabricated winner)
 *
 * Honesty rules (kept invariant by tests):
 *   - DEMO CCTV is associated with DEMO route segments; it carries NO real
 *     geographic camera position and is never relabelled as live city CCTV.
 *   - Traffic intelligence is DEMO / derived from recorded CCTV vehicle
 *     activity (never live congestion and never relabelled as live traffic).
 *   - Road conditions are SIMULATED/DEMO until a real provider replaces them.
 *   - Route weather is SIMULATED/DEMO context; the only live weather factor is
 *     a LIVE provider result when one exists, otherwise the factor is UNKNOWN
 *     and excluded (weights renormalised).
 *   - Route scores and explanations are computed from the provided evidence;
 *     missing factors are never invented, incomplete assessments are called
 *     out explicitly, and a recommendation is only picked when the evidence
 *     actually distinguishes the routes.
 */

import demoCctvManifest from '../data/demoCctvManifest.json' with { type: 'json' };

export const ROUTE_WEIGHTS = {
  traffic: 40, // major factor — observed traffic across monitored segments
  weather: 25, // secondary factor — live destination weather impact
  road: 20, // secondary factor — mock road condition on demo segments
  travelTime: 15, // route efficiency factor — estimated drive time
};

export const MIN_KNOWN_WEIGHT = 35;

export const TRAFFIC_PROVIDER = {
  mode: 'DEMO',
  label: 'DEMO TRAFFIC INTELLIGENCE',
  note: 'Derived from the recorded demo CCTV vehicle-activity evidence (demo_cctv_traffic_evidence.json). A vehicle-activity proxy, not live city traffic and not direct congestion measurement.',
};

export const CCTV_PROVIDER = {
  mode: 'DEMO',
  label: 'DEMO CCTV',
  note: 'Pre-recorded demo footage associated with demo route segments. Not live cameras and not geographically mapped.',
};

export const ROAD_CONDITION_PROVIDER = {
  mode: 'SIMULATED',
  label: 'SIMULATED ROAD CONDITIONS (DEMO)',
  note: 'Prototype simulated demo layer that a real road-condition provider can replace later.',
};

export const ROUTE_WEATHER_PROVIDER = {
  mode: 'SIMULATED',
  label: 'SIMULATED ROUTE WEATHER (DEMO)',
  note: 'Deterministic demo route-weather layer. Not a live forecast and not one weather point representing the whole route.',
};

export const ROUTE_INTELLIGENCE_LAYER_NOTE =
  'Route assessment and recommendation are computed from the configured weights over the available ' +
  'intelligence layers: DEMO traffic observations (recorded footage), LIVE weather (when retrieved), ' +
  'SIMULATED road conditions, SIMULATED route weather and REAL routing geometry. Layers are never ' +
  'relabelled, and unknown factors are excluded rather than guessed.';

export const CCTV_LOOKUP = {
  sourceType: 'DEMO / RECORDED',
  status: 'recorded',
};

/**
 * RECORDED-DEMO CCTV REGISTRY (the honest source for the CCTV view).
 *
 * The registry (src/data/demoCctvManifest.json) defines exactly which
 * recorded-demo sources exist per demo route (route_a → CCTV-A01..A03,
 * route_b → CCTV-B01..B03, route_c → CCTV-C01..C03). Every entry carries
 * { live: false, geographically_mapped: false, source_type: 'DEMO / RECORDED' }
 * — nothing in this registry is a live camera or geographically positioned.
 * Routes beyond the registry never gain fabricated cameras.
 */
export const ROUTE_CCTV_CONTRACT = {
  kind: 'PER-ROUTE-REGISTRY',
  totalSlots: 9,
  slotsPerRoute: 3,
  note:
    'Recorded-demo CCTV registry with 9 distinct sources (3 per route, route_a/b/c → CCTV-A*/B*/C*). RECORDED DEMO footage, never live and never geographically mapped.',
};

/** Ordinal route key for a route index: 0 → route_a, 1 → route_b, 2 → route_c … */
export function routeKeyForIndex(index) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const n = Number(index || 0);
  return `route_${letters[n % letters.length]}${Math.floor(n / letters.length) ? Math.floor(n / letters.length) : ''}`;
}

/**
 * PER-ROUTE CCTV CONTRACT (9 distinct slots — 3 per route, never reused).
 * Backward-compatible helper retained for the old call shape; it now resolves
 * honest registry entries (via demoCctvForRoute) rather than awaiting placeholders.
 */
export function cctvContractForRoute({ routeId, routeIndex, videoEvidence = {}, cctvEvidence = [] }) {
  return demoCctvForRoute({ routeId, routeIndex, videoEvidence, cctvEvidence });
}

const TRAFFIC_LEVEL_SCORES = { LOW: 90, MODERATE: 70, CONGESTED: 45 };
const ROAD_SCORES = { GOOD: 95, MODERATE: 75, POOR: 50 };
const WEATHER_IMPACT_SCORES = { none: 100, low: 90, moderate: 75, high: 55 };

/**
 * Transparent mapping from the demo CCTV VEHICLE-ACTIVITY condition recorded in
 * demo_cctv_traffic_evidence.json (LOW / MODERATE / HIGH / VERY_HIGH) to the
 * EXISTING route traffic levels (LOW / MODERATE / CONGESTED) used by the
 * scoring system.
 *
 * These conditions are DEMO vehicle-activity indicators derived from recorded
 * demo CCTV — they are NOT direct measurements of real-road congestion. The
 * mapping keeps the existing scoring semantics: HIGH / VERY_HIGH observed
 * vehicle activity counts as the worst traffic level (CONGESTED), MODERATE
 * stays MODERATE and LOW stays LOW.
 */
export const DEMO_ACTIVITY_TO_TRAFFIC_LEVEL = {
  LOW: 'LOW',
  MODERATE: 'MODERATE',
  HIGH: 'CONGESTED',
  VERY_HIGH: 'CONGESTED',
};

/** Maps a demo CCTV vehicle-activity condition to the scoring traffic level (or null). */
export function trafficLevelFromActivity(activityCondition) {
  return DEMO_ACTIVITY_TO_TRAFFIC_LEVEL[activityCondition] || null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Demo route-segment → recorded clip assignment (intentional demo construction,
 * sourced from the recorded-demo CCTV registry — a single source of truth).
 *
 * Each real route (by its position in the OSRM result) is split into three DEMO
 * ordinal segments, and each segment is associated with one of the registered
 * recorded-demo sources. The traffic metrics for that camera now come from the
 * prepared demo CCTV evidence (data/demo_processed_cctv/demo_cctv_traffic_evidence.json)
 * via demoCctvForRoute — the per-camera activity fields
 * (activity_condition, activity_index_per_1000_frames, conservative_tracks,
 * activity_rate_tracks_per_min) are the recorded vehicle-activity values, never
 * hardcoded scores. The camera list itself is never fabricated: only cameras
 * registered in demoCctvManifest.json receive evidence.
 *
 * This table (kept for backward compatibility) simply exposes which recorded
 * source video each ordinal demo segment points at; it no longer implies any
 * traffic condition.
 */
export const DEMO_SEGMENT_VIDEOS = (demoCctvManifest.routes || []).map((r) =>
  (r.cameras || []).map((c) => c.video)
);

export const DEMO_SEGMENT_COUNT = 3;

/**
 * Ordinal demo segment ids for a real route, e.g. `real-route-1:seg-1`.
 * These are DEMO associations — never a geographic segmentation of the road.
 */
export function segmentIdsForRoute(routeId, count = DEMO_SEGMENT_COUNT) {
  return Array.from({ length: count }, (_, i) => `${routeId}:seg-${i + 1}`);
}

/**
 * Extracts a route number mention from free text ("show CCTV for route 2").
 * Returns a 1-based number or null.
 */
export function routeNumberFrom(text) {
  const match = String(text || '').match(/\broute\s+([1-9]\d*)\b/i);
  if (!match) return null;
  const n = Number(match[1]);
  return n >= 1 ? n : null;
}

/**
 * Builds the recorded-demo CCTV sources for a real route from the registry.
 *
 * The registry (demoCctvManifest.json) stays the source of truth for WHICH
 * cameras belong to each demo route (Route 1 → CCTV-A01/A02/A03, Route 2 →
 * CCTV-B01/B02/B03, Route 3 → CCTV-C01/C02/C03). The prepared demo CCTV
 * evidence (data/demo_processed_cctv/demo_cctv_traffic_evidence.json) ONLY
 * enriches each registered camera — it never adds cameras. Evidence is matched
 * by cctv_id first, with the recorded source_video as a safe fallback.
 *
 * Each enriched camera's traffic_metrics carries the NEW evidence fields
 * (activity_condition, activity_index_per_1000_frames, conservative_tracks,
 * activity_rate_tracks_per_min, total_frames, duration_seconds) plus a
 * transparently MAPPED `traffic_condition` (demo activity level → scoring
 * level via DEMO_ACTIVITY_TO_TRAFFIC_LEVEL). A registered camera with no
 * matching evidence keeps traffic_metrics = null — truly UNKNOWN, never
 * fabricated.
 *
 * The returned objects implement the documented CCTV data model:
 *   camera_id, route_id, route_segment_id, video_id, video_path, timestamp,
 *   status, source_type, analysis_status, traffic_metrics, live,
 *   geographically_mapped, enabled, registry fields
 * plus the UI fields (title, video) that the investigation panels already use.
 * They carry NO geographic position (geographicallyMapped is always false) and
 * are never live (live is always false).
 *
 * Routes BEYOND the registry return an empty list: a route never fabricates
 * demo cameras that do not exist (no padding to 3).
 */
export function demoCctvForRoute({ routeId, routeIndex, cctvEvidence = [], videoEvidence = {} }) {
  const index = Number(routeIndex || 0);
  const registryEntry = (demoCctvManifest.routes || [])[index];
  if (!registryEntry || !Array.isArray(registryEntry.cameras)) return [];
  const evidenceList = Array.isArray(cctvEvidence) ? cctvEvidence : [];
  return registryEntry.cameras.map((camera, seg) => {
    const video = camera.video;
    const cctvId = camera.cctv_id;
    const evidence =
      evidenceList.find((e) => e && e.cctv_id === cctvId) ||
      evidenceList.find((e) => e && e.source_video === video) ||
      null;
    const legacy = evidence ? null : videoEvidence[video] || null; // old-shape fallback
    const analyzed = evidence || legacy;
    let traffic_metrics = null;
    if (evidence) {
      traffic_metrics = {
        activity_condition: evidence.activity_condition || null,
        activity_index_per_1000_frames: numberOrNull(evidence.activity_index_per_1000_frames),
        conservative_tracks: numberOrNull(evidence.conservative_tracks),
        activity_rate_tracks_per_min: numberOrNull(evidence.activity_rate_tracks_per_min),
        total_frames: numberOrNull(evidence.total_frames),
        duration_seconds: numberOrNull(evidence.duration_seconds),
        traffic_condition: trafficLevelFromActivity(evidence.activity_condition),
      };
    } else if (legacy) {
      traffic_metrics = {
        traffic_condition: legacy.traffic_condition || null,
        activity_rate_ids_per_sec: legacy.activity_rate_ids_per_sec ?? null,
        corrected_vehicle_count: legacy.corrected_vehicle_count ?? null,
      };
    }
    return {
      id: cctvId,
      cctv_id: cctvId,
      camera_id: cctvId,
      route_id: routeId,
      route_index: index + 1,
      registry_route_id: registryEntry.route_id,
      route_segment_id: `${routeId}:seg-${seg + 1}`,
      segment_index: seg,
      video_id: video,
      video,
      video_path: `recordings/${encodeURIComponent(video)}`,
      timestamp: 'RECORDED (dataset)',
      status: CCTV_LOOKUP.status,
      source_type: CCTV_LOOKUP.sourceType,
      live: false,
      geographically_mapped: false,
      geographicallyMapped: false,
      enabled: true,
      analysis_status: analyzed ? 'ANALYSED' : 'UNKNOWN',
      traffic_metrics,
      title: `Route ${index + 1} · Segment ${seg + 1} — recorded demo CCTV`,
      kind: 'recorded',
      demo: true,
    };
  });
}

/**
 * Traffic intelligence for a route, aggregated from its demo CCTV cameras.
 *
 * Every level here is a DEMO VEHICLE-ACTIVITY condition (activity_condition
 * from demo_cctv_traffic_evidence.json) mapped transparently to the existing
 * scoring levels via DEMO_ACTIVITY_TO_TRAFFIC_LEVEL — it is NOT a live or
 * directly measured congestion reading. Every count comes from the recorded
 * evidence (activity_rate_tracks_per_min, conservative_tracks,
 * activity_index_per_1000_frames); nothing is invented.
 */
export function trafficForRoute({ routeId, routeIndex, cctvEvidence = [], videoEvidence = {} }) {
  const cameras = demoCctvForRoute({ routeId, routeIndex, cctvEvidence, videoEvidence });
  const segments = cameras.map((cam) => {
    const metrics = cam.traffic_metrics || {};
    const activityCondition = metrics.activity_condition || null;
    const level = trafficLevelFromActivity(activityCondition) || metrics.traffic_condition || null;
    return {
      segmentId: cam.route_segment_id,
      cameraId: cam.id,
      cctvId: cam.id,
      video: cam.video,
      level,
      known: !!level,
      activityCondition,
      activityRate: metrics.activity_rate_tracks_per_min ?? metrics.activity_rate_ids_per_sec ?? null,
      activityIndex: metrics.activity_index_per_1000_frames ?? null,
      vehicles: metrics.conservative_tracks ?? metrics.corrected_vehicle_count ?? null,
      frames: metrics.total_frames ?? null,
      durationSeconds: metrics.duration_seconds ?? null,
    };
  });
  const known = segments.filter((s) => s.known);
  const dominant = known.length
    ? [...known]
        .reduce((acc, s) => {
          acc[s.level] = (acc[s.level] || 0) + 1;
          return acc;
        }, {})
    : {};
  const dominantLevel =
    known.length === 0
      ? null
      : Object.keys(dominant).sort((a, b) => dominant[b] - dominant[a])[0];
  const vehicles = segments.reduce((sum, s) => sum + (s.vehicles ?? 0), 0);
  const activityIndexes = known
    .map((s) => s.activityIndex)
    .filter((v) => Number.isFinite(v));
  const activityIndexEstimate = activityIndexes.length
    ? activityIndexes.reduce((a, b) => a + b, 0) / activityIndexes.length
    : null;
  return {
    routeId,
    routeIndex,
    level: dominantLevel,
    segments,
    knownSegments: known.length,
    totalSegments: segments.length,
    label: known.length
      ? `${dominantLevel} — recorded demo CCTV vehicle-activity on ${known.length} of ${segments.length} monitored demo segment(s). Not live congestion measurement.`
      : 'UNKNOWN — no recorded demo CCTV activity observation for these segments',
    vehicleEstimate: vehicles,
    activityIndexEstimate: activityIndexes.length ? Number(activityIndexEstimate.toFixed(3)) : null,
    layer: TRAFFIC_PROVIDER.mode,
    source: TRAFFIC_PROVIDER.label,
  };
}

/**
 * Weights a single traffic level to a 0–100 score (or null when unknown).
 */
export function trafficLevelScore(level) {
  return TRAFFIC_LEVEL_SCORES[level] ?? null;
}

/**
 * Road condition layer for a route's demo segments — SIMULATED/DEMO data only
 * (clearly labelled, never presented as real roads). Each segment associates
 * deterministically with a row of the protected mock road-condition evidence;
 * a missing row yields UNKNOWN (excluded later).
 */
export function roadConditionForRoute({ routeId, routeIndex, roadRows = [] }) {
  const count = DEMO_SEGMENT_COUNT;
  const segments = Array.from({ length: count }, (_, i) => {
    const row = roadRows.length ? roadRows[(routeIndex * count + i) % roadRows.length] : null;
    return {
      segmentId: `${routeId}:seg-${i + 1}`,
      condition: row ? row.overall_road_condition || row.road_condition || null : null,
      risk: row ? row.road_risk || null : null,
      known: !!(row && row.overall_road_condition),
      sourceType: 'SIMULATED',
      note: 'Simulated demo road-condition row (fictional demo association, NOT real roads)',
    };
  });
  return {
    routeId,
    segments,
    knownSegments: segments.filter((s) => s.known).length,
    layer: ROAD_CONDITION_PROVIDER.mode,
    source: ROAD_CONDITION_PROVIDER.label,
  };
}

/**
 * SIMULATED / DEMO route weather — always labelled SIMULATED, never LIVE.
 *
 * Deterministic per-route states (Route A clear, Route B partly cloudy,
 * Route C rain) so the demo data distinguishes the options. This is context
 * shown to the user; it is NOT scored into the assessment. The only weather
 * factor that is scored is a LIVE provider reading (weatherImpactLevel).
 */
export const ROUTE_WEATHER_STATES = ['CLEAR', 'CLOUDY', 'RAIN'];

export function routeWeatherForRoute({ routeId, routeIndex }) {
  const index = Number(routeIndex || 0);
  const pattern = ROUTE_WEATHER_STATES[index % ROUTE_WEATHER_STATES.length] || 'CLEAR';
  const segments = Array.from({ length: DEMO_SEGMENT_COUNT }, (_, i) => ({
    segmentId: `${routeId}:seg-${i + 1}`,
    state: pattern,
    sourceType: 'SIMULATED',
  }));
  return {
    routeId,
    routeIndex: index,
    segments,
    layer: ROUTE_WEATHER_PROVIDER.mode,
    source: ROUTE_WEATHER_PROVIDER.label,
    label: `Route weather (SIMULATED / DEMO) — ${pattern} across ${DEMO_SEGMENT_COUNT} demo segment(s). Not a live forecast.`,
  };
}

/**
 * Weather impact level derived ONLY from a live weather result:
 *   null weather          → UNKNOWN (excluded from scoring)
 *   precipitation/codes   → none | low | moderate | high
 */
export function weatherImpactLevel(weather) {
  if (!weather) return { level: 'unknown', known: false, score: null };
  const precipitation = weather.precipitationMm;
  const code = weather.weatherCode;
  if (precipitation !== null && precipitation !== undefined && Number.isFinite(Number(precipitation))) {
    const mm = Number(precipitation);
    if (mm > 5) return { level: 'high', known: true, score: WEATHER_IMPACT_SCORES.high };
    if (mm > 1) return { level: 'moderate', known: true, score: WEATHER_IMPACT_SCORES.moderate };
    if (mm > 0) return { level: 'low', known: true, score: WEATHER_IMPACT_SCORES.low };
    return { level: 'none', known: true, score: WEATHER_IMPACT_SCORES.none };
  }
  if (code !== null && code !== undefined && Number.isFinite(Number(code))) {
    const n = Number(code);
    if ([95, 96, 99, 65, 82, 86].includes(n)) {
      return { level: 'high', known: true, score: WEATHER_IMPACT_SCORES.high };
    }
    if ([51, 53, 56, 61, 66, 71, 73, 80, 85].includes(n) || n > 66) {
      return { level: 'moderate', known: true, score: WEATHER_IMPACT_SCORES.moderate };
    }
    if ([48, 55, 57, 63, 75, 77, 81].includes(n)) {
      return { level: 'low', known: true, score: WEATHER_IMPACT_SCORES.low };
    }
    return { level: 'none', known: true, score: WEATHER_IMPACT_SCORES.none };
  }
  return { level: 'unknown', known: false, score: null };
}

function averageKnown(scores) {
  const known = scores.filter((s) => Number.isFinite(s));
  if (known.length === 0) return null;
  return known.reduce((a, b) => a + b, 0) / known.length;
}

/**
 * Factory-shaped, deterministic route assessment. Every factor is computed from
 * the available intelligence; unknown factors are excluded and the known
 * weights are renormalised (never a fabricated winner).
 */
export function assessRoute({
  route,
  traffic,
  weatherImpact,
  road,
  routeWeather = null,
  fastestDuration,
  weights = ROUTE_WEIGHTS,
}) {
  const trafficScore = traffic
    ? averageKnown(traffic.segments.map((s) => trafficLevelScore(s.level)))
    : null;
  const weatherScore = weatherImpact && weatherImpact.known ? weatherImpact.score : null;
  const roadScore = road ? averageKnown(road.segments.map((s) => ROAD_SCORES[s.condition] ?? null)) : null;
  const hasDuration = Number.isFinite(route.durationMin) && route.durationMin > 0;
  const hasFastest = Number.isFinite(fastestDuration) && fastestDuration > 0;
  const travelScore = hasDuration && hasFastest ? Number((100 * (fastestDuration / route.durationMin)).toFixed(2)) : null;

  const factors = {
    traffic: {
      level: traffic ? traffic.level : null,
      score: trafficScore === null ? null : Number(trafficScore.toFixed(2)),
      known: trafficScore !== null,
      weight: weights.traffic,
      source: traffic ? traffic.source : null,
      label: traffic ? traffic.label : null,
    },
    weather: {
      level: weatherImpact ? weatherImpact.level : null,
      score: weatherScore,
      known: weatherScore !== null,
      weight: weights.weather,
      source: weatherImpact && weatherImpact.known ? 'LIVE (Open-Meteo)' : null,
    },
    road: {
      level: road && road.knownSegments > 0 ? road.segments[0].condition : null,
      score: roadScore === null ? null : Number(roadScore.toFixed(2)),
      known: roadScore !== null,
      weight: weights.road,
      source: ROAD_CONDITION_PROVIDER.label,
    },
    travelTime: {
      score: travelScore,
      known: travelScore !== null,
      weight: weights.travelTime,
      source: 'OSRM (REAL provider)',
    },
  };

  const knownWeight =
    (factors.traffic.known ? weights.traffic : 0) +
    (factors.weather.known ? weights.weather : 0) +
    (factors.road.known ? weights.road : 0) +
    (factors.travelTime.known ? weights.travelTime : 0);

  let score = null;
  let recommendationStatus = 'INSUFFICIENT_DATA';
  let explanation = null;

  if (knownWeight >= MIN_KNOWN_WEIGHT) {
    let weighted = 0;
    let totalWeight = 0;
    [factors.traffic, factors.weather, factors.road, factors.travelTime].forEach((f) => {
      if (f.known) {
        weighted += f.weight * f.score;
        totalWeight += f.weight;
      }
    });
    score = Number((weighted / totalWeight).toFixed(1));
    recommendationStatus = 'ELIGIBLE';
    explanation = buildExplanation(route, factors, traffic, road, weatherImpact, routeWeather, knownWeight, weights);
  }

  return {
    routeId: route.id,
    routeName: route.name,
    score,
    factors,
    knownWeight,
    recommendationStatus,
    explanation,
  };
}

/**
 * Data-backed explanation. Sentences reference only factors that are known;
 * unknown factors are never asserted on.
 */
export function buildExplanation(route, factors, traffic, road, weatherImpact, routeWeather = null, knownWeight = null, weights = ROUTE_WEIGHTS) {
  const parts = [];
  const t = factors.traffic;
  const r = factors.road;
  const w = factors.weather;
  const tt = factors.travelTime;

  if (t.known && t.level && t.label) {
    const heavyCount = (traffic.segments || []).filter(
      (s) => s.level === 'CONGESTED'
    ).length;
    parts.push(
      `Route ${traffic.routeIndex + 1} shows ${t.label.toLowerCase()}` +
        (heavyCount > 0
          ? ` (${heavyCount} monitored segment(s) with heavy observed activity).`
          : '.')
    );
  }
  if (w.known) {
    parts.push(
      w.level === 'none'
        ? 'Weather has no impact today according to the live reading.'
        : `Live weather impact is ${w.level}.`
    );
  }
  if (r.known && road && road.knownSegments > 0) {
    const conditions = road.segments.map((s) => s.condition).filter(Boolean);
    const primary = conditions[0];
    const count = conditions.filter((c) => c === primary).length;
    parts.push(`Simulated road condition (DEMO) is ${primary} on ${count} of ${road.segments.length} demo segment(s).`);
  }
  if (routeWeather && Array.isArray(routeWeather.segments) && routeWeather.segments.length > 0) {
    const states = routeWeather.segments.map((s) => s.state);
    parts.push(`Simulated route weather (DEMO) is ${states.join(' / ')} across ${routeWeather.segments.length} demo segment(s).`);
  }
  if (tt.known && Number.isFinite(route.durationMin)) {
    parts.push(`Estimated drive time is ${route.durationMin} min over ${route.distanceKm} km.`);
  }
  if (parts.length > 0 && knownWeight !== null && Number.isFinite(knownWeight)) {
    const totalConfigured = Object.values(weights).reduce((a, b) => a + b, 0);
    if (knownWeight < totalConfigured) {
      const unknownFactors = [
        { key: 'traffic', label: 'traffic' },
        { key: 'weather', label: 'live weather' },
        { key: 'road', label: 'road condition' },
        { key: 'travelTime', label: 'travel time' },
      ]
        .filter((f) => !factors[f.key].known)
        .map((f) => f.label);
      if (unknownFactors.length > 0) {
        parts.push(
          `Assessment is incomplete: ${unknownFactors.join(' and ')} ${
            unknownFactors.length === 1 ? 'is' : 'are'
          } UNKNOWN and was excluded from the score.`
        );
      }
    }
  }
  if (parts.length === 0) {
    return 'Assessment is derived entirely from the available intelligence layers.';
  }
  return parts.join(' ');
}

const PREFERENCE_FACTOR_LABELS = {
  traffic: 'observed traffic',
  weather: 'live weather impact',
  road: 'road condition',
  travelTime: 'travel time efficiency',
};

/**
 * Explicit, data-backed "why" for a unique winner: finds the known assessment
 * factor where the winner most clearly beats the next-best route and states
 * the comparison plainly. Never invents a reason when nothing distinguishes
 * the routes.
 */
function preferenceWhy(winner, challenger) {
  if (!challenger || !winner || !winner.factors) return null;
  let best = null;
  for (const key of Object.keys(PREFERENCE_FACTOR_LABELS)) {
    const w = winner.factors[key];
    const c = challenger.factors ? challenger.factors[key] : null;
    if (!w || !c || !w.known || !c.known) continue;
    if (w.score === null || c.score === null) continue;
    const gap = w.score - c.score;
    if (Number.isFinite(gap) && gap > 0 && (!best || gap > best.gap)) {
      best = { gap, key };
    }
  }
  if (!best) return null;
  const w = winner.factors[best.key];
  const c = challenger.factors[best.key];
  const winnerPoint = w.level !== null && w.level !== undefined ? String(w.level) : `${w.score}`;
  const challengerPoint = c.level !== null && c.level !== undefined ? String(c.level) : `${c.score}`;
  return `Preferred over ${challenger.routeName} on ${PREFERENCE_FACTOR_LABELS[best.key]}: ${winnerPoint} (${w.score}/100) vs ${challengerPoint} (${c.score}/100).`;
}

/**
 * Rank routes by their computed scores. A RECOMMENDED status is only assigned
 * to a unique highest score; ties and missing scores never pick a fake winner.
 * The unique winner also carries a plain-language `why` derived from the
 * known factor comparison (never fabricated).
 */
export function rankRoutes(assessments) {
  const scored = assessments.filter((a) => a.score !== null);
  if (scored.length < 2) {
    return assessments.map((a) => ({
      ...a,
      recommendationStatus:
        a.score === null ? 'INSUFFICIENT_DATA' : scored.length === 1 ? 'ELIGIBLE' : a.recommendationStatus,
    }));
  }
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  const challenger = sorted[1] || null;
  const tied = sorted.filter((s) => s.score === best.score);
  const hasWinner = tied.length === 1;
  const why = hasWinner ? preferenceWhy(best, challenger) : null;
  return assessments.map((a) => {
    if (a.score === null) return { ...a, recommendationStatus: 'INSUFFICIENT_DATA' };
    if (hasWinner && a.routeId === best.routeId) {
      return { ...a, recommendationStatus: 'RECOMMENDED', isRecommended: true, why };
    }
    return { ...a, recommendationStatus: 'ELIGIBLE' };
  });
}

/**
 * Composes the complete per-route intelligence snapshot for a trip:
 *   segments, demo CCTV by route, traffic, road conditions, weather impact,
 *   assessments, ranked recommendation and the layer disclosure.
 */
export function composeTripIntelligence({ routes = [], weather = null, evidence = {} } = {}) {
  const list = Array.isArray(routes) ? routes : [];
  const demoEvidence = evidence.demoCctvEvidence || {};
  const cctvEvidence = Array.isArray(demoEvidence.cameraEvidence) ? demoEvidence.cameraEvidence : [];
  const roadRows = evidence.roadRows || [];
  const durations = list
    .map((r) => r.durationMin)
    .filter((d) => Number.isFinite(d) && d > 0);
  const fastestDuration = durations.length ? Math.min(...durations) : null;

  const segments = {};
  const cctv = { byRoute: {}, cameras: [] };
  const traffic = { byRoute: {} };
  const road = { byRoute: {} };
  const routeWeather = { byRoute: {} };
  const assessments = [];

  list.forEach((route, index) => {
    const routeId = route.id;
    const routeIndex = index;
    segments[routeId] = segmentIdsForRoute(routeId);
    const cameras = demoCctvForRoute({ routeId, routeIndex, cctvEvidence });
    cctv.byRoute[routeId] = cameras;
    cctv.cameras = cctv.cameras.concat(cameras);
    const routeTraffic = trafficForRoute({ routeId, routeIndex, cctvEvidence });
    traffic.byRoute[routeId] = routeTraffic;
    const routeRoad = roadConditionForRoute({ routeId, routeIndex, roadRows });
    road.byRoute[routeId] = routeRoad;
    const routeWeatherEntry = routeWeatherForRoute({ routeId, routeIndex });
    routeWeather.byRoute[routeId] = routeWeatherEntry;
    const weatherImpact = weatherImpactLevel(weather);
    assessments.push(
      assessRoute({
        route,
        traffic: routeTraffic,
        weatherImpact,
        road: routeRoad,
        routeWeather: routeWeatherEntry,
        fastestDuration,
      })
    );
  });

  const ranked = rankRoutes(assessments);
  const assessmentByRoute = {};
  ranked.forEach((a) => {
    assessmentByRoute[a.routeId] = a;
  });
  const recommended = ranked.find((a) => a.recommendationStatus === 'RECOMMENDED') || null;

  return {
    segments,
    cctv,
    traffic,
    road,
    routeWeather,
    weatherImpact: weatherImpactLevel(weather),
    assessments: assessmentByRoute,
    recommendation: recommended
      ? {
          routeId: recommended.routeId,
          routeName: recommended.routeName,
          score: recommended.score,
          explanation: recommended.explanation,
          why: recommended.why || null,
          status: 'RECOMMENDED',
        }
      : null,
    layers: describeLayers(weather),
  };
}

/**
 * Provider/layer disclosure shown across the UI — this is what the user is
 * allowed to call "live" and what must stay demo/mock/static.
 */
export function describeLayers(weather = null) {
  return [
    { layer: 'Routing', mode: 'REAL', provider: 'OSRM public demo server', note: 'Real route geometry and travel metrics (provider-derived).' },
    { layer: 'Location', mode: 'REAL', provider: 'Browser Geolocation API', note: 'Used only with explicit user permission; never fabricated.' },
    { layer: 'Traffic', ...TRAFFIC_PROVIDER },
    { layer: 'CCTV', ...CCTV_PROVIDER },
    { layer: 'Road condition', ...ROAD_CONDITION_PROVIDER },
    { layer: 'Route weather', ...ROUTE_WEATHER_PROVIDER },
    {
      layer: 'Weather',
      mode: weather ? 'LIVE' : 'UNAVAILABLE',
      provider: 'Open-Meteo (no API key)',
      note: weather
        ? 'Live provider reading for the resolved destination.'
        : 'No live reading — the weather factor is UNKNOWN and excluded.',
    },
  ];
}

export const ROUTE_ASSESSMENT_STATUSES = {
  recommended: 'RECOMMENDED',
  eligible: 'ELIGIBLE',
  insufficient: 'INSUFFICIENT_DATA',
};

/**
 * Honesty note for CCTV → route association. The demo footage is recorded
 * dataset media, never live CCTV and never geographically verified on the real
 * route — the association exists only for prototype analysis.
 */
export const ROUTE_EVIDENCE_GEO_NOTE =
  'Demo CCTV evidence associated with this route for prototype analysis — not geographically verified.';

/**
 * Routes the demo CCTV / ML / weather / road / OSRM evidence availability for
 * ONE route into a compact, honest status snapshot for the Intelligence view.
 *
 * Every status is derived from the existing data only:
 *   - camera list (3 demo sources per route),
 *   - ML evidence present per source (traffic_metrics with a level),
 *   - weatherImpact (LIVE only when the live provider returned data),
 *   - road layer (MOCK only when a mock row is available),
 *   - OSRM travel metrics from the real route object.
 * Nothing is invented: a missing observation stays UNKNOWN / DEMO EVIDENCE ONLY.
 */
export function routeEvidenceStatus({
  route = null,
  traffic = null,
  road = null,
  weatherImpact = null,
  cameras = [],
}) {
  const list = Array.isArray(cameras) ? cameras : [];
  const sources = list.map((c) => ({
    id: c.id,
    video: c.video,
    source_type: c.source_type || CCTV_LOOKUP.sourceType,
    analysis_status: c.analysis_status || (c.traffic_metrics ? 'ANALYSED' : 'UNKNOWN'),
    mlEvidence: !!(c.traffic_metrics && c.traffic_metrics.traffic_condition),
    traffic_condition: c.traffic_metrics ? c.traffic_metrics.traffic_condition || null : null,
  }));
  const mlAvailable = sources.filter((s) => s.mlEvidence).length;
  const knownSegments =
    traffic && Number.isFinite(traffic.knownSegments) ? traffic.knownSegments : 0;
  const totalSegments =
    traffic && traffic.totalSegments ? traffic.totalSegments : sources.length || DEMO_SEGMENT_COUNT;
  const observation =
    traffic && knownSegments > 0 && traffic.level
      ? {
          level: traffic.level,
          knownSegments,
          totalSegments,
          label: traffic.label,
          vehicleEstimate: Number.isFinite(traffic.vehicleEstimate) ? traffic.vehicleEstimate : null,
        }
      : null;
  const roadKnown = !!(road && road.knownSegments > 0);
  const weatherKnown = !!(weatherImpact && weatherImpact.known);
  const travelKnown = !!(
    route &&
    Number.isFinite(route.distanceKm) &&
    Number.isFinite(route.durationMin)
  );

  return {
    routeId: route ? route.id : null,
    routeName: route ? route.name : null,
    cctv: {
      total: sources.length,
      mlEvidence: mlAvailable,
      demo: true,
      recorded: true,
      live: false,
      notGeographicallyVerified: true,
    },
    traffic: {
      status: mlAvailable > 0 ? 'DEMO' : 'UNKNOWN',
      mlEvidenceAvailable: mlAvailable,
      totalSources: sources.length,
      observation,
      note:
        mlAvailable > 0
          ? 'recorded ML evidence, not live city traffic'
          : 'no valid ML evidence mapping for these demo sources',
    },
    weather: {
      status: weatherKnown ? 'LIVE' : 'UNKNOWN',
      level: weatherKnown && weatherImpact.level ? weatherImpact.level : null,
    },
    road: {
      status: roadKnown ? 'SIMULATED' : 'UNKNOWN',
      condition: roadKnown && road.segments && road.segments[0] ? road.segments[0].condition : null,
      knownSegments: roadKnown ? road.knownSegments : 0,
      totalSegments: road && road.segments ? road.segments.length : totalSegments,
    },
    travel: {
      status: travelKnown ? 'REAL' : 'UNKNOWN',
      distanceKm: travelKnown ? route.distanceKm : null,
      durationMin: travelKnown ? route.durationMin : null,
    },
    evidenceStatuses: {
      demo: mlAvailable > 0 || sources.length > 0,
      live: weatherKnown,
      simulated: roadKnown,
      real: travelKnown,
      unknown: mlAvailable === 0,
    },
    associationNote: ROUTE_EVIDENCE_GEO_NOTE,
  };
}