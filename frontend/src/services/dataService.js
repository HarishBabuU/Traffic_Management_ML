/**
 * Central data-access layer for the dashboard.
 *
 * All data comes from explicit JSON copies that were prepared from the
 * protected processed outputs (see scripts/prepare_data.mjs). The JSON
 * copies preserve the original values, data_mode, is_mock and source
 * information. Nothing here transforms mock data into live data.
 */

import trafficJson from '../data/traffic.json' with { type: 'json' };
import weatherJson from '../data/weather.json' with { type: 'json' };
import roadConditionsJson from '../data/roadConditions.json' with { type: 'json' };
import roadScoresJson from '../data/roadScores.json' with { type: 'json' };
import routesJson from '../data/routes.json' with { type: 'json' };
import level8Json from '../data/level8.json' with { type: 'json' };
import trackSummariesJson from '../data/trackSummaries.json' with { type: 'json' };
import trackTrajectoriesJson from '../data/trackTrajectories.json' with { type: 'json' };
import validationJson from '../data/validation.json' with { type: 'json' };
import demoCctvEvidenceJson from '../data/demoCctvEvidence.json' with { type: 'json' };

function sectionStatus(rows, fallback = { status: 'STATIC', note: 'Processed analysis' }) {
  if (!rows || rows.length === 0) {
    return { status: 'UNKNOWN', note: 'No data available' };
  }
  const anyMock = rows.some((r) => String(r.is_mock ?? '').toLowerCase() === 'true');
  if (anyMock) {
    return { status: 'MOCK', note: 'Mock/test data — not real' };
  }
  const anyLive = rows.some(
    (r) => String(r.source ?? '').toLowerCase() === 'live'
  );
  if (anyLive) {
    return { status: 'LIVE', note: 'Point-in-time observation, not real-time' };
  }
  return fallback;
}

function metricMap(rows) {
  const map = {};
  (rows || []).forEach((r) => {
    map[r.metric] = r.value;
  });
  return map;
}

function getTraffic() {
  const rows = trafficJson.rows || [];
  const overview = rows.filter((r) => r.row_type === 'video_overview');
  const intervals = rows.filter((r) => r.row_type === 'interval');
  return {
    source: trafficJson.generated_from,
    status: { status: 'STATIC', note: 'Processed video analysis (historical)' },
    overview,
    intervals,
  };
}

function getWeather() {
  const rows = weatherJson.rows || [];
  return {
    source: weatherJson.generated_from,
    status: sectionStatus(rows),
    rows,
    first: rows[0] || null,
  };
}

function getRoadConditions() {
  const rows = roadConditionsJson.rows || [];
  return {
    source: roadConditionsJson.generated_from,
    status: sectionStatus(rows),
    rows,
  };
}

function getRoadScores() {
  const rows = roadScoresJson.rows || [];
  let top = null;
  let topValue = -1;
  rows.forEach((r) => {
    if (r.overall_score === 'UNKNOWN' || r.overall_score === '') return;
    const v = Number(r.overall_score);
    if (!Number.isNaN(v) && v > topValue) {
      topValue = v;
      top = r;
    }
  });
  return {
    source: roadScoresJson.generated_from,
    status: sectionStatus(rows),
    rows,
    top,
  };
}

function getRoutes() {
  const rows = routesJson.rows || [];
  const recommended = rows.find((r) => r.recommendation_status === 'RECOMMENDED') || null;
  return {
    source: routesJson.generated_from,
    status: sectionStatus(rows),
    rows,
    recommended,
  };
}

function getLevel8() {
  const stats = level8Json.traffic_statistics || [];
  const metrics = metricMap(stats);
  return {
    source: level8Json.generated_from,
    status: { status: 'STATIC', note: 'Processed video analysis (historical)' },
    metrics,
    classByVideo: level8Json.class_by_video || [],
    trafficOverTime: level8Json.traffic_over_time || [],
  };
}

/**
 * Final corrected track identities (Level 8A) with full per-track longevity.
 * Read straight from the prepared evidence copy; no computation or invention.
 */
function getTrackSummaries() {
  return {
    source: trackSummariesJson.generated_from,
    status: { status: 'STATIC', note: 'Final corrected track identities (Level 8A)' },
    finalTrackIdentities: trackSummariesJson.finalTrackIdentities,
    trackCountByVideo: trackSummariesJson.track_count_by_video,
    tracksByVideo: trackSummariesJson.per_video || {},
  };
}

/**
 * Vertex-preserved centroid trajectories for the longest corrected tracks per
 * video. Duplicate artifact rows are retained exactly as recorded.
 */
function getTrackTrajectories() {
  return {
    source: trackTrajectoriesJson.generated_from,
    status: { status: 'STATIC', note: 'Recorded centroid trajectories (Level 7D, read-only)' },
    totalTrajectoryRows: trackTrajectoriesJson.total_trajectory_rows,
    artifactDuplicateRows: trackTrajectoriesJson.artifact_duplicate_rows,
    perVideo: trackTrajectoriesJson.per_video || {},
  };
}

/**
 * Validation evidence copied verbatim from the protected reports/CSVs.
 */
function getValidation() {
  return {
    source: validationJson.generated_from,
    status: { status: 'STATIC', note: 'Validation evidence copied verbatim' },
    level8: validationJson.level8,
    phase9a: validationJson.phase9a,
    phase9b: validationJson.phase9b,
    phase9c: validationJson.phase9c,
    phase9d: validationJson.phase9d,
    phase9e: validationJson.phase9e,
  };
}

/**
 * Demo CCTV traffic evidence prepared from the already-generated demo
 * processing output. Read-only; evidence values are preserved verbatim.
 */
function getDemoCctvEvidence() {
  return {
    source: demoCctvEvidenceJson.generated_from,
    status: {
      status: 'DEMO',
      note: 'Recorded demo CCTV evidence — not live and not geographically mapped',
    },
    live: demoCctvEvidenceJson.live,
    geographicallyMapped: demoCctvEvidenceJson.geographically_mapped,
    normalizedMetric: demoCctvEvidenceJson.normalized_metric,
    cameraEvidence: demoCctvEvidenceJson.camera_evidence || [],
    routeSummary: demoCctvEvidenceJson.route_summary || [],
    limitations: demoCctvEvidenceJson.limitations || [],
  };
}

function getOverview() {
  const traffic = getTraffic();
  const weather = getWeather();
  const scores = getRoadScores();
  const routes = getRoutes();
  const level8 = getLevel8();

  const trafficLabels = traffic.overview.map((r) => r.traffic_condition).join(' / ');

  return {
    totalVehicles: {
      label: 'Total Vehicles',
      value: level8.metrics.total_corrected_identities || 'UNKNOWN',
      sub: `Corrected count across ${level8.metrics.number_of_videos || '?'} analysed video(s)`,
      status: traffic.status,
    },
    conservativeCount: {
      label: 'Conservative Count',
      value: level8.metrics.total_conservative_identities || 'UNKNOWN',
      sub: 'Lower-bound conservative counting result',
      status: traffic.status,
    },
    trafficCondition: {
      label: 'Traffic Condition',
      value: trafficLabels ? `Per-video: ${trafficLabels}` : 'UNKNOWN',
      sub: 'Dataset-relative activity labels (not congestion or speed)',
      status: traffic.status,
    },
    weatherImpact: {
      label: 'Weather Impact',
      value: weather.first ? weather.first.weather_traffic_impact || 'UNKNOWN' : 'UNKNOWN',
      sub: weather.first
        ? `${weather.first.weather_condition || 'UNKNOWN'} | ${weather.first.temperature_c || 'UNKNOWN'} °C`
        : 'Weather data not available',
      status: weather.status,
    },
    roadScore: {
      label: 'Road Suitability',
      value: scores.top
        ? `${scores.top.overall_score} (${scores.top.suitability_category})`
        : 'UNKNOWN',
      sub: scores.top
        ? `${scores.top.road_id} — fictional MOCK road`
        : 'No scored roads available',
      status: scores.status,
    },
    recommendedRoute: {
      label: 'Recommended Route',
      value: routes.recommended
        ? `${routes.recommended.route_id} · ${routes.recommended.route_score} (${routes.recommended.route_category})`
        : 'No eligible route',
      sub: routes.recommended
        ? 'Prototype / Mock route — not a real road'
        : 'No recommendation (insufficient data)',
      status: routes.status,
    },
  };
}

export {
  getOverview,
  getTraffic,
  getWeather,
  getRoadConditions,
  getRoadScores,
  getRoutes,
  getLevel8,
  getTrackSummaries,
  getTrackTrajectories,
  getValidation,
  getDemoCctvEvidence,
};