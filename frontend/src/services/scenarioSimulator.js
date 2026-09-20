/**
 * Phase 9F-4 Part 6 — Scenario (WHAT-IF) simulator.
 *
 * This is a deterministic DEMONSTRATION layer. It does NOT predict real-world
 * traffic. It mirrors the documented Phase 9D weighted-layer rule — a suitability
 * score is a weighted average of per-layer suitability values, and UNKNOWN layers
 * are never treated as zero risk: they are excluded and the known weights are
 * renormalised. If too little information is known the model reports
 * SIMULATION INCOMPLETE instead of inventing a number.
 *
 * The model is fully isolated from the Phase 9D engine and is explicitly a
 * static/demo model. Constants are exported so tests can pin the exact mapping.
 */

export const SCENARIO_INPUTS = {
  traffic: ['LOW', 'MODERATE', 'HEAVY', 'CONGESTED'],
  weather: ['CLEAR', 'MODERATE', 'HIGH', 'UNKNOWN'],
  road: ['LOW', 'MODERATE', 'HIGH', 'UNKNOWN'],
  incident: ['NONE', 'REPORTED'],
};

/** Documented weights for the demonstration model (suitability composition). */
export const LAYER_WEIGHTS = {
  traffic: 0.4,
  weather: 0.25,
  road: 0.25,
  incident: 0.1,
};

/** Documented per-level suitability (higher = better road suitability). */
export const LAYER_SCORES = {
  traffic: { LOW: 90, MODERATE: 72, HEAVY: 52, CONGESTED: 34 },
  weather: { CLEAR: 92, MODERATE: 68, HIGH: 42, UNKNOWN: null },
  road: { LOW: 88, MODERATE: 70, HIGH: 48, UNKNOWN: null },
  incident: { NONE: 100, REPORTED: 30 },
};

/** Documented baseline scenario that every simulation is compared against. */
export const BASELINE_INPUTS = {
  traffic: 'LOW',
  weather: 'CLEAR',
  road: 'LOW',
  incident: 'NONE',
};

/** Minimum fraction of the model's weight that must be known to run a result. */
export const MIN_KNOWN_WEIGHT = 0.5;

export const LAYER_LABELS = {
  traffic: 'Traffic',
  weather: 'Weather',
  road: 'Road condition',
  incident: 'Incident',
};

function normalize(value) {
  const raw = String(value === undefined || value === null ? 'UNKNOWN' : value)
    .trim()
    .toUpperCase();
  return raw === 'UNKNOWN' ? 'UNKNOWN' : raw;
}

/**
 * Deterministic per-layer score for an input level (0–100 suitability).
 * UNKNOWN always maps to null (excluded, never zero-risk).
 */
export function layerScore(layer, level) {
  const table = LAYER_SCORES[layer];
  if (!table) return null;
  const normalized = normalize(level);
  const value = Object.prototype.hasOwnProperty.call(table, normalized)
    ? table[normalized]
    : null;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Renormalise the known layer weights so they sum to 1 (shared Phase 9D idea). */
export function renormalizeWeights(weightedLayers) {
  const knownWeight = weightedLayers.reduce(
    (sum, layer) => (layer.score === null ? sum : sum + layer.weight),
    0
  );
  return {
    knownWeight,
    layers: weightedLayers.map((layer) => ({
      ...layer,
      effectiveWeight:
        layer.score === null || knownWeight === 0
          ? 0
          : layer.weight / knownWeight,
    })),
  };
}

/** Build the deterministic explanation for a scenario result. */
export function scenarioExplanation(layers, scenarioScore, baselineScore) {
  if (layers.length === 0) {
    return 'Not enough known information to explain a simulated score.';
  }
  const changed = layers
    .filter((layer) => layer.score !== null && layer.baselineScore !== null)
    .filter((layer) => layer.score - layer.baselineScore !== 0)
    .sort(
      (a, b) =>
        a.score - a.baselineScore - (b.score - b.baselineScore)
    );

  const suffix =
    scenarioScore > baselineScore
      ? 'Simulated suitability for this WHAT-IF scenario is higher than the documented baseline. This is a deterministic static-model comparison, not a real-world prediction.'
      : scenarioScore < baselineScore
        ? 'Simulated suitability for this WHAT-IF scenario is lower than the documented baseline. This is a deterministic static-model comparison, not a real-world prediction.'
        : 'This scenario does not change simulated suitability from the documented baseline. Deterministic static-model comparison only.';

  if (changed.length === 0) {
    return `Every known layer matches the baseline values, so the simulated score equals the baseline. ${suffix}`;
  }

  const negative = changed.filter((layer) => layer.score - layer.baselineScore < 0);
  const positive = changed.filter((layer) => layer.score - layer.baselineScore > 0);
  const phrases = [];
  if (negative.length > 0) {
    const parts = negative.map(
      (layer) =>
        `${levelDescriptor(layer)} contributes a lower ${levelPhraseSuffix(layer)}`
    );
    phrases.push(`the simulated suitability decreases because ${joinPhrases(parts)}`);
  }
  if (positive.length > 0) {
    const parts = positive.map(
      (layer) =>
        `${levelDescriptor(layer)} contributes a higher ${levelPhraseSuffix(layer)}`
    );
    phrases.push(`the simulated suitability increases because ${joinPhrases(parts)}`);
  }
  return `${phrases.join(' and ')}. ${suffix}`;
}

function levelDescriptor(layer) {
  const level = (layer.level || '').toUpperCase();
  if (layer.key === 'traffic') {
    return { 'LOW': 'low traffic', 'MODERATE': 'moderate traffic', 'HEAVY': 'heavy traffic', 'CONGESTED': 'congested traffic' }[level] || layer.level;
  }
  if (layer.key === 'weather') {
    return { 'CLEAR': 'clear weather', 'MODERATE': 'moderate weather', 'HIGH': 'heavy weather' }[level] || layer.level;
  }
  if (layer.key === 'road') {
    return { 'LOW': 'good road condition', 'MODERATE': 'moderate road condition', 'HIGH': 'poor road condition' }[level] || layer.level;
  }
  if (layer.key === 'incident') {
    return { 'REPORTED': 'a reported incident', 'NONE': 'no incident' }[level] || layer.level;
  }
  return String(layer.level || '').toLowerCase();
}

function levelPhraseSuffix(layer) {
  return `${layer.label.toLowerCase()} score`;
}

function joinPhrases(parts) {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/**
 * Run one deterministic scenario.
 * Input: { traffic, weather, road, incident } — level labels or 'UNKNOWN'.
 * Returns:
 *   { status: 'READY', baseline, scenario, change, knownWeight, layers, explanation }
 *   { status: 'INCOMPLETE', knownWeight, explanation, layers }
 */
export function runScenario(input) {
  const inputs = { ...BASELINE_INPUTS, ...(input || {}) };
  const baselineLayers = Object.keys(LAYER_WEIGHTS).map((key) => {
    const baseline = BASELINE_INPUTS[key];
    return { key, level: baseline, baselineScore: layerScore(key, baseline) };
  });
  const baselineScore = weightedRoundedScore(baselineLayers, LAYER_WEIGHTS);

  const weightedLayers = Object.keys(LAYER_WEIGHTS).map((key) => ({
    key,
    label: LAYER_LABELS[key],
    level: normalize(inputs[key]),
    score: layerScore(key, inputs[key]),
    weight: LAYER_WEIGHTS[key],
    baselineScore: baselineLayers.find((layer) => layer.key === key).baselineScore,
  }));

  const { knownWeight, layers } = renormalizeWeights(weightedLayers);
  if (knownWeight < MIN_KNOWN_WEIGHT) {
    return {
      status: 'INCOMPLETE',
      knownWeight,
      layers,
      explanation:
        'SIMULATION INCOMPLETE — less than half of the model weight is known. UNKNOWN layers are never treated as zero risk, so no score is fabricated. Add traffic, weather, road or incident information and run again.',
    };
  }

  const scenarioScore = Math.round(
    layers.reduce((sum, layer) => {
      if (layer.score === null) return sum;
      return sum + layer.score * layer.effectiveWeight;
    }, 0)
  );

  return {
    status: 'READY',
    baseline: baselineScore,
    scenario: scenarioScore,
    change: scenarioScore - baselineScore,
    knownWeight,
    layers,
    explanation: scenarioExplanation(layers, scenarioScore, baselineScore),
  };
}

function weightedRoundedScore(layers, weights) {
  const known = layers.filter((layer) => layer.baselineScore !== null);
  const weightsSum = known.reduce((sum, layer) => sum + weights[layer.key], 0);
  const score = known.reduce(
    (sum, layer) => sum + layer.baselineScore * (weights[layer.key] / weightsSum),
    0
  );
  return Math.round(score);
}

/**
 * Route context for the scenario UI. NEVER fabricates a route.
 * Comes back as:
 *   { kind: 'none',   reason }  -> "Generate a real route first…"
 *   { kind: 'real',   realRoute, demoRoute? }
 *   { kind: 'mock',   demoRoute }  -> only when no real route exists
 */
export function scenarioUiState({ trip, analysisReady, realRoute, demoRoute }) {
  if (!trip) {
    return {
      kind: 'none',
      reason: 'No trip context yet. Enter an origin and destination first.',
    };
  }
  if (analysisReady && realRoute) {
    return { kind: 'real', realRoute, demoRoute: demoRoute || null };
  }
  if (demoRoute) {
    return { kind: 'mock', demoRoute };
  }
  return {
    kind: 'none',
    reason: 'Generate a real route first to run a route-specific simulation.',
  };
}

export function isMockRoute(route) {
  if (!route) return false;
  return (
    String(route.route_id || route.id || '').toUpperCase().includes('MOCK') ||
    route.recommendation_status === 'MOCK' ||
    route.data_mode === 'MOCK' ||
    route.isMock === true
  );
}

export const SCENARIO_SUMMARY =
  'SCENARIO SIMULATION · WHAT-IF · SIMULATED · STATIC MODEL · DEMO';