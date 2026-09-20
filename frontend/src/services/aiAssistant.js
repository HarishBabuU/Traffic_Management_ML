/**
 * Phase 9F-4 Part 4 — AI chat assistant (LOCAL / DEMO).
 *
 * Provider-agnostic assistant service. The implementation is a LOCAL/DEMO
 * assistant built on deterministic intent parsing and response generation:
 * there is NO external LLM connected and NO API key embedded or required.
 *
 * The architecture deliberately mirrors the other provider services
 * (locationProviders / weatherProvider):
 *
 *   createAssistantService({ state, emitAction })
 *     └─ handleMessage(text) → { reply, action? }
 *
 * A real LLM provider could later be added behind the same interface WITHOUT
 * rewriting the React UI. The mode badge must stay "LOCAL ASSISTANT" until a
 * real provider is actually connected.
 *
 * Honesty rules honoured here:
 *   - Never fabricates routes, weather, CCTV locations, or live status.
 *   - Emits structured actions that App.jsx applies to the EXISTING control-
 *     centre state; this module never forks its own copy of that state.
 *   - Respects the Part 1 CCTV gating rules (no auto-selection of resources).
 *   - Never falls back to Phase 9B weather on a failed live weather request.
 *   - Mock Phase 9E routes are never presented as real geographic routes.
 */

import { routeNumberFrom } from './routeIntelligence.js';

export const ASSISTANT_MODE = {
  label: 'LOCAL ASSISTANT',
  engine: 'Deterministic local intent parsing — no external LLM connected',
  provider: null,
  disclaimer:
    'This is a local/demo assistant. No external AI provider or API key is used. Answers come from deterministic parsing of the current control-centre state.',
};

export const INTENT = {
  empty: 'empty',
  greeting: 'greeting',
  help: 'help',
  weather: 'weather',
  cctv: 'cctv',
  scenario: 'scenario',
  route: 'route',
  recommendation: 'recommendation',
  trip: 'trip',
  destinationOnly: 'destination-only',
  originOnly: 'origin-only',
  intelligence: 'intelligence',
  evidence: 'evidence',
  traffic: 'traffic',
  map: 'map',
  back: 'back',
  unknown: 'unknown',
};

/** Small normalisation so "please"/"thanks" tails do not enter locations. */
function cleanPlace(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[?!.,;]+$/g, '')
    .replace(/\s+(please|plz|thanks|thankyou|thx|now|then|ok|okay)\s*$/gi, '')
    .trim();
  return cleaned;
}

/**
 * Deterministically extracts trip places from free text. Returns
 *   null                                    → nothing trip-like found
 *   { kind: 'trip', origin, destination }    → both places present
 *   { kind: 'destination-only', destination }→ origin missing
 *   { kind: 'origin-only', origin }          → destination missing
 */
export function extractTripPlaces(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // from A to B  (checked first so explicit origin→destination always wins)
  const fromTo = raw.match(/\bfrom\s+(.+?)\s+to\s+(.+)$/i);
  if (fromTo) {
    const origin = cleanPlace(fromTo[1]);
    const destination = cleanPlace(fromTo[2]);
    if (origin && destination) {
      return { kind: 'trip', origin, destination };
    }
  }

  // route/plan ... to B  (destination given, origin missing)
  const hasTo = raw.match(
    /\b(?:take\s+me|go|going|travel|head|drive|reach|navigate|commute|fly|ride|plan|route)\b[\s\S]*?\bto\s+(.+)$/i
  );
  if (hasTo) {
    const destination = cleanPlace(hasTo[1]);
    if (destination) return { kind: 'destination-only', destination };
  }

  // ... from A  (origin given, destination missing)
  const hasFrom = raw.match(/\bfrom\s+(.+?)\s*$/i);
  if (hasFrom) {
    const origin = cleanPlace(hasFrom[1]);
    if (origin) return { kind: 'origin-only', origin };
  }

  return null;
}

/**
 * Classifies a free-text message into one of the supported intents. Pure and
 * deterministic — suitable for node --test.
 */
export function classifyIntent(text) {
  const raw = String(text || '').trim();
  if (!raw) return INTENT.empty;

  if (/\b(weather|temperature|forecast)\b/i.test(raw)) return INTENT.weather;
  // Whole-app navigation: the MAP / HOME view (checked before "back to map",
  // which must land on the map rather than popping an arbitrary previous view).
  if (
    /^(?:show|open|display|view)\s+(?:the\s+)?map\b/i.test(raw) ||
    /^(?:go|go\s+back|back|return|take\s+me|navigate)\s+to\s+(?:the\s+)?map\b/i.test(raw) ||
    /\bshow\s+(?:me\s+)?(?:the\s+)?map\b/i.test(raw)
  ) {
    return INTENT.map;
  }
  if (/\b(go\s*back|go\s*to\s*(the\s*)?previous|previous\s*(view|screen))\b/i.test(raw) || /^(back|back up)\.?$/i.test(raw)) {
    return INTENT.back;
  }
  if (/\b(cctv|camera|investigat\w*|footage|surveillance)\b/i.test(raw)) {
    return INTENT.cctv;
  }
  if (/\b(simulat\w*|scenario|what-?if|run a scenario|what if)\b/i.test(raw)) {
    return INTENT.scenario;
  }
  if (
    /\b(help|what can you (do|help)|capabilit|commands|how (do|can) i use|what do you do)\b/i.test(
      raw
    ) ||
    /^(hi|hello|hey|good (morning|afternoon|evening))\b/i.test(raw)
  ) {
    return INTENT.help;
  }

  const tripPlaces = extractTripPlaces(raw);
  if (tripPlaces) {
    if (tripPlaces.kind === 'trip') return INTENT.trip;
    if (tripPlaces.kind === 'destination-only') return INTENT.destinationOnly;
    if (tripPlaces.kind === 'origin-only') return INTENT.originOnly;
    return INTENT.unknown;
  }

  // Whole-application view navigation (checked before generic route/show).
  if (
    /\b(evidence|historical data|statistics|stats|pipeline|validation)\b/i.test(raw)
  ) {
    return INTENT.evidence;
  }
  if (/\b(intelligence|intel|provenance|reasoning)\b/i.test(raw)) {
    return INTENT.intelligence;
  }

  // Route recommendation questions belong to the route-reasoning flow.
  if (/\b(recommend\w*|best route|which route)\b/i.test(raw)) {
    return INTENT.recommendation;
  }

  if (
    /\b(show|view|display|open|check)\b[\s\S]*?\brout(e|es)\b/i.test(raw) ||
    /\bcurrent route\b|\bmy route\b|\broute status\b/i.test(raw)
  ) {
    return INTENT.route;
  }

  if (/\b(traffic|congestion|jams?\b|gridlock|delays?|heavy traffic)\b/i.test(raw)) {
    return INTENT.traffic;
  }

  return INTENT.unknown;
}

/**
 * Greeting / help text shown when the user asks for capabilities or greets.
 */
export const HELP_TEXT =
  'I am a local operations assistant. I can: plan a trip (e.g. "route from Chennai to Madurai"), ' +
  'explain the current real route ("show my current route"), pick one of the live routes ("show route 2"), ' +
  'open the map at any time ("go to map", "show map"), ' +
  'summarise the recorded demo traffic evidence for the selected route ("what is the traffic like?"), ' +
  'tell you which route I recommend and why ' +
  '("which route are you recommending?", "why is route 2 recommended?"), show the demo CCTV for a specific route ("show CCTV for route 2"), ' +
  'summarise the live destination weather, run a deterministic what-if scenario ("simulate heavy traffic"), ' +
  'guide CCTV investigation using the existing gating rules ("help me investigate CCTV"), open the historical ' +
  'evidence view ("show evidence"), switch to the reasoning view ("open intelligence"), or go back to the ' +
  'previous view ("go back"). There is no external ' +
  'AI provider or API key connected; this is LOCAL ASSISTANT mode.';

/**
 * Smallest possible scenario hint extraction: pulls out an optional traffic
 * level the user asked for ("simulate heavy traffic"). Returns
 *   {}                      -> no traffic level requested
 *   { traffic: 'HEAVY' }    -> a documented level was requested
 */
export function scenarioTrafficHint(text) {
  const raw = String(text || '');
  const level = raw.match(/\b(congested|heavy|moderate|low)\b/i);
  if (!level) return {};
  const key = level[1].toUpperCase();
  return {
    traffic:
      key === 'CONGESTED' ? 'CONGESTED' : key === 'HEAVY' ? 'HEAVY' : key === 'MODERATE' ? 'MODERATE' : 'LOW',
  };
}

/** Response for scenario/simulation requests using the current route context. */
export function scenarioReply(state, message) {
  const { trip, analysisStatus, analysis } = state || {};
  const ready =
    analysisStatus === 'ready' &&
    analysis &&
    Array.isArray(analysis.routes) &&
    analysis.routes.length > 0;
  if (!trip || !ready) {
    return {
      reply:
        'Okay. I can run a deterministic what-if scenario on the current route. ' +
        (trip
          ? 'Route analysis has not finished yet, so there is no real route to attach the scenario to.'
          : 'Generate a real route first to run a route-specific simulation.') +
        ' The Scenario Simulation panel stays available as a clearly-labelled static-model demonstration.',
      action: { type: 'SIMULATE_SCENARIO' },
    };
  }
  return {
    reply:
      `Okay. I can run a deterministic what-if scenario on your current route (${trip.origin || 'origin'} → ${trip.destination}). ` +
      'The result is a SIMULATED static-model comparison — not a real traffic prediction. The Scenario Simulation panel is now open; you can adjust traffic, weather and road levels there.',
    action: { type: 'SIMULATE_SCENARIO', ...scenarioTrafficHint(message) },
  };
}

/** Trip response once origin + destination are parsed. */
export function tripReply(places, state) {
  const { origin, destination } = places;
  const alreadySet =
    state &&
    state.destination &&
    state.destination.trim().toLowerCase() === destination.toLowerCase() &&
    state.origin &&
    state.origin.trim().toLowerCase() === origin.toLowerCase();
  const lead = alreadySet
    ? `Your trip is already set to ${origin} → ${destination}.`
    : `I understood your trip as ${origin} → ${destination}. I've prepared the trip details.`;
  return {
    reply:
      `${lead} Run route analysis to generate the real geographic route ` +
      `(Photon geocoding + OSRM routing). The existing demo intelligence includes mock route data, ` +
      `but I won't present those fictional roads as real geographic routes.`,
    action: alreadySet
      ? null
      : { type: 'SET_TRIP', origin, destination },
  };
}

/** Response for route/status requests, based on the current real analysis. */
export function routeReply(state, text) {
  const { analysisStatus, analysis, trip } = state || {};
  if (!trip) {
    return {
      reply:
        'No trip has been analyzed yet. Tell me an origin and destination (e.g. "route from Chennai to Madurai") and I will prepare the trip details.',
      action: null,
    };
  }
  if (analysisStatus === 'ready' && analysis && Array.isArray(analysis.routes)) {
    const routes = analysis.routes;
    const routeNumber = routeNumberFrom(text);
    if (routeNumber !== null && routeNumber >= 1 && routeNumber <= routes.length) {
      const idx = routeNumber - 1;
      const target = routes[idx];
      return {
        reply:
          `Selecting route ${routeNumber} — ${target.name || `route ${routeNumber}`}` +
          (Number.isFinite(target.distanceKm) && Number.isFinite(target.durationMin)
            ? ` (${target.distanceKm} km · ${target.durationMin} min, live provider data).`
            : '.') +
          ` The other ${routes.length - 1} option(s) stay available in the Route Analysis view.`,
        action: { type: 'SELECT_ROUTE', routeIndex: idx },
      };
    }
    const selected =
      state.selectedRealRoute && state.selectedRealRoute.id
        ? state.selectedRealRoute
        : routes[0];
    const metrics =
      selected && Number.isFinite(selected.distanceKm) && Number.isFinite(selected.durationMin)
        ? ` Distance ${selected.distanceKm} km, drive time ${selected.durationMin} min (from the OSRM provider).`
        : '';
    return {
      reply:
        `Your real route is available in the Real Route / Map area: ${routes.length} option(s) generated by OSRM for ` +
        `${trip.origin || 'origin'} → ${trip.destination}.${metrics} This is real provider data, not a mock route.`,
      action: { type: 'SHOW_ROUTE' },
    };
  }
  if (analysisStatus === 'geocoding' || analysisStatus === 'routing') {
    return {
      reply: 'Route analysis is still in progress (resolving locations / calculating route). Please wait a moment.',
      action: null,
    };
  }
  return {
    reply:
      'A real route could not be generated right now. The route area shows the current routing status; no route was fabricated. You can try running analysis again.',
    action: { type: 'SHOW_ROUTE' },
  };
}

/** Response for weather requests, based on the CURRENT live weather state. */
export function weatherReply(state) {
  const weather = (state && state.weather) || { status: 'idle', kind: null, data: null };
  if (weather.status === 'ready' && weather.data) {
    const d = weather.data;
    const parts = [];
    if (d.temperatureC !== null && d.temperatureC !== undefined) {
      parts.push(`${d.temperatureC}°C`);
    }
    if (d.description) parts.push(d.description);
    if (d.precipitationMm !== null && d.precipitationMm !== undefined) {
      parts.push(d.precipitationMm === 0 ? 'no precipitation' : `${d.precipitationMm} mm precipitation`);
    }
    if (d.windSpeedKmh !== null && d.windSpeedKmh !== undefined) {
      parts.push(`wind ${d.windSpeedKmh} km/h`);
    }
    const asOf = d.asOf ? ` Observed ${d.asOf}.` : '';
    return {
      reply:
        `Current destination weather is LIVE. ${parts.join(', ') || 'reading available'}.${asOf} This is a live Open-Meteo reading; recorded footage and mock routes are not weather sources.`,
      action: { type: 'SHOW_WEATHER' },
    };
  }
  if (weather.status === 'loading') {
    return {
      reply: 'Working — fetching the current weather from Open-Meteo. Check the Live Weather section in a moment.',
      action: { type: 'SHOW_WEATHER' },
    };
  }
  return {
    reply:
      'Current weather is UNAVAILABLE right now. I don\'t have a verified live weather reading, so I will not substitute the historical Phase 9B weather data.',
    action: { type: 'SHOW_WEATHER' },
  };
}

/** Whole-app navigation: open the MAP / HOME view. */
export function mapReply() {
  return {
    reply:
      'Opening the Map / Home view — the real provider routes and the live map are shown there.',
    action: { type: 'SHOW_ROUTE' },
  };
}

/** Whole-app navigation: open the Intelligence reasoning view. */
export function intelligenceReply() {
  return {
    reply:
      'Opening the Intelligence view — live provider results stay LIVE, while historical traffic, ' +
      'road-condition, demo-route and provenance layers keep their STATIC / MOCK / RECORDED labels.',
    action: { type: 'OPEN_INTELLIGENCE' },
  };
}

/** Whole-app navigation: open the Evidence / historical statistics view. */
export function evidenceReply() {
  return {
    reply:
      'Opening the Evidence view — the validated historical statistics from the recorded dataset ' +
      '(corrected counts, conservative counts, trajectory rows, validation, pipeline and provenance) are shown there.',
    action: { type: 'OPEN_EVIDENCE' },
  };
}

/**
 * Response for "which route do you recommend?" questions. Uses the ranked
 * result computed by the route-intelligence layer (passed in via state), so
 * the assistant never reasons about the ranking itself.
 */
export function recommendingReply(state, text) {
  const recommendation = state && state.recommendation;
  if (recommendation && recommendation.routeId) {
    const scoreText = Number.isFinite(recommendation.score)
      ? `a route assessment of ${recommendation.score}/100`
      : 'a route assessment';
    const why = recommendation.why
      ? ` Why: ${recommendation.why}`
      : recommendation.explanation
        ? ` ${recommendation.explanation}`
        : '';
    const routeNumber = routeNumberFrom(text);
    const routes =
      state &&
      state.analysisStatus === 'ready' &&
      Array.isArray(state.analysis && state.analysis.routes) &&
      state.analysis.routes.length > 0
        ? state.analysis.routes
        : Array.isArray(state && state.realRoutes)
          ? state.realRoutes
          : [];
    const askedId =
      routeNumber !== null && routeNumber >= 1 && routeNumber <= routes.length
        ? routes[routeNumber - 1] && routes[routeNumber - 1].id
        : null;
    const selectedId = state && state.selectedRealRoute && state.selectedRealRoute.id;
    const candidateIds = [askedId, selectedId, recommendation.routeId].filter(Boolean);
    const selectedAssessment =
      (candidateIds
        .map((id) => state.assessments && state.assessments[id])
        .find((a) => a && a.explanation)) || null;
    const assessmentText = selectedAssessment
      ? ` Selected route assessment: ${selectedAssessment.explanation}`
      : '';
    return {
      reply:
        `Based on the configured criteria (traffic/weather/road/travel-time weights), I recommend ` +
        `${recommendation.routeName || recommendation.routeId} with ${scoreText}.${why}${assessmentText} ` +
        `The recommendation is derived from the available DEMO traffic observations, LIVE weather ` +
        `(when retrieved) and MOCK road conditions — not from a live city traffic feed.`,
      action: { type: 'SHOW_ROUTE' },
    };
  }
  if (state && state.analysisStatus === 'ready') {
    return {
      reply:
        'I can recommend a route once the intelligence layers are computed for this analysis. ' +
        'No recommendation is fabricated from missing evidence — check the Intelligence view for the per-route assessments.',
      action: { type: 'OPEN_INTELLIGENCE' },
    };
  }
  return {
    reply:
      'I can recommend a route once a real trip is analysed. Tell me an origin and destination first ' +
      '(e.g. "route from Chennai to Madurai").',
    action: null,
  };
}

/**
 * Response for CCTV requests. A route-specific request ("show CCTV for route 2")
 * selects that real route and opens its demo CCTV sources; otherwise the Part 1
 * gating rules apply exactly as before.
 */
export function cctvReply(state, text) {
  const routeNumber = routeNumberFrom(text);
  const routes =
    state && state.analysisStatus === 'ready' && Array.isArray(state.analysis && state.analysis.routes)
      ? state.analysis.routes
      : [];
  if (routeNumber !== null && routes.length > 0 && routeNumber <= routes.length) {
    const idx = routeNumber - 1;
    const target = routes[idx];
    const registryCameras =
      routeNumber <= routes.length && state && state.cctv && state.cctv.byRoute
        ? state.cctv.byRoute[target.id] || []
        : [];
    const ids = registryCameras
      .map((c) => c && (c.id || c.cctv_id || c.camera_id))
      .filter(Boolean);
    const cameraText =
      ids.length > 0
        ? `Its registered demo CCTV sources are ${ids.join(', ')}.`
        : 'No registered demo CCTV sources exist for this demo route in the registry — nothing is invented.';
    return {
      reply:
        `Opening the Investigation view for ${target.name || `Route ${routeNumber}`} (route ${routeNumber}). ` +
        `${cameraText} These are RECORDED DEMO sources — not live CCTV, not real-time feeds and not ` +
        'geographically mapped to the real road.',
      action: { type: 'SELECT_ROUTE', routeIndex: idx, openInvestigation: true },
    };
  }
  const cctv = (state && state.cctvPolicy) || { kind: 'no-destination', resources: [] };
  const gate = cctv.kind;
  const base = 'CCTV investigation becomes available after a destination is analyzed and a route is selected. The available recordings are demo/recorded resources, not live CCTV, and they carry no real geographic camera position.';
  if (gate === 'route-selected' && Array.isArray(cctv.resources) && cctv.resources.length > 0) {
    const ids = cctv.resources.map((r) => r.id).join(', ');
    return {
      reply: `${base} For the currently selected route, ${cctv.resources.length} demo resource(s) are available in the CCTV area: ${ids}. I will not pick one for you — open it from the list.`,
      action: { type: 'OPEN_INVESTIGATION' },
    };
  }
  if (gate === 'no-route') {
    return {
      reply: `${base} Your destination has been analyzed, but no route is selected yet, so no generic camera list is shown. Select a demo route candidate first.`,
      action: { type: 'OPEN_INVESTIGATION' },
    };
  }
  if (gate === 'not-analyzed') {
    return { reply: `${base} Set a destination and run route analysis first.`, action: { type: 'OPEN_INVESTIGATION' } };
  }
  return {
    reply: `${base} Enter a destination and analyze a route before CCTV resources are revealed.`,
    action: { type: 'OPEN_INVESTIGATION' },
  };
}

/**
 * Response for traffic-evidence questions ("what is the traffic like?").
 * Reports ONLY the recorded ML evidence that actually maps to the selected
 * route's demo CCTV sources — never a live traffic feed or an invented value.
 */
export function trafficReply(state) {
  const { analysisStatus, analysis, selectedRealRoute } = state || {};
  const trafficByRoute = (state && state.traffic && state.traffic.byRoute) || null;
  const ready =
    analysisStatus === 'ready' &&
    analysis &&
    Array.isArray(analysis.routes) &&
    analysis.routes.length > 0;
  if (!ready || !trafficByRoute) {
    return {
      reply:
        'Traffic evidence is only reported from the recorded ML observations that map to the selected route — a real trip must be analysed first. Nothing is fabricated, and this is never a live city traffic feed. The Intelligence view is open.',
      action: { type: 'OPEN_INTELLIGENCE' },
    };
  }
  const target =
    selectedRealRoute && selectedRealRoute.id
      ? trafficByRoute[selectedRealRoute.id] || null
      : null;
  const route = target || trafficByRoute[Object.keys(trafficByRoute)[0]] || null;
  const routeName =
    selectedRealRoute && selectedRealRoute.id
      ? selectedRealRoute.name || selectedRealRoute.id
      : route
        ? route.routeId
        : 'the selected route';
  if (route && route.knownSegments > 0) {
    return {
      reply:
        `The recorded demo traffic observation for ${routeName} is ${route.label}. ` +
        `${route.knownSegments} of ${route.totalSegments} demo CCTV sources have usable ML evidence. ` +
        'This is DEMO evidence derived from recorded footage — not live city traffic and not geographically mapped to the real road. The Intelligence view is open.',
      action: { type: 'OPEN_INTELLIGENCE' },
    };
  }
  return {
    reply:
      `No recorded ML evidence is available for ${routeName}'s demo CCTV sources — the traffic observation is UNKNOWN / DEMO EVIDENCE ONLY. ` +
      'Nothing is fabricated. The Intelligence view is open.',
    action: { type: 'OPEN_INTELLIGENCE' },
  };
}

/**
 * Deterministic response builder used by the service. Returns
 *   { reply, action? } where action is a structured action for App.jsx.
 */
export function buildReply(text, state) {
  const intent = classifyIntent(text);
  switch (intent) {
    case INTENT.empty:
      return { reply: 'Please type a message so I can help. Empty messages are ignored.', action: null };
    case INTENT.back:
      return {
        reply: 'Going back to the previous view.',
        action: { type: 'GO_BACK' },
      };
    case INTENT.greeting:
      return {
        reply: `Hello! I am the ${ASSISTANT_MODE.label.toLowerCase()}. ${HELP_TEXT}`,
        action: null,
      };
    case INTENT.help:
      return { reply: HELP_TEXT, action: null };
    case INTENT.weather:
      return weatherReply(state);
    case INTENT.cctv:
      return cctvReply(state, text);
    case INTENT.scenario:
      return scenarioReply(state, text);
    case INTENT.intelligence:
      return intelligenceReply();
    case INTENT.map:
      return mapReply();
    case INTENT.evidence:
      return evidenceReply();
    case INTENT.traffic:
      return trafficReply(state);
    case INTENT.route:
      return routeReply(state, text);
    case INTENT.recommendation:
      return recommendingReply(state, text);
    case INTENT.trip: {
      const places = extractTripPlaces(text);
      return tripReply(places, state);
    }
    case INTENT.destinationOnly: {
      const places = extractTripPlaces(text);
      const loc = state && state.location;
      const locationLive = loc && loc.status === 'live' && loc.coords;
      if (locationLive) {
        return {
          reply:
            `Understood — destination "${places.destination}". Since your current location is live, I set the origin to your current location and started the route analysis.`,
          action: {
            type: 'SET_TRIP',
            origin: 'My current location',
            destination: places.destination,
            autoAnalyze: true,
          },
        };
      }
      return {
        reply: `I can plan that trip. I got the destination "${places.destination}", but I need the origin too. Where would you like to start from?`,
        action: null,
      };
    }
    case INTENT.originOnly: {
      const places = extractTripPlaces(text);
      return {
        reply: `Got it — origin "${places.origin}". Where would you like to go? I need a destination to prepare a trip.`,
        action: null,
      };
    }
    default:
      return {
        reply:
          'I couldn\'t parse that request. I can help with trips (origin → destination), the current route, the live weather, and CCTV investigation. Try one of the prompts below.',
        action: null,
      };
  }
}

/**
 * Service factory. `state` is the current control-centre context (owned by
 * App.jsx — never duplicated here). Alternatively pass `getState` (a function
 * returning the latest state) so a long-lived service never reads stale
 * control-centre data. `emitAction` forwards structured actions so App.jsx can
 * apply them to the existing state.
 */
export function createAssistantService({ state, getState, emitAction }) {
  function currentState() {
    return typeof getState === 'function' ? getState() : state;
  }
  function handleMessage(text) {
    const result = buildReply(text, currentState());
    if (result.action && typeof emitAction === 'function') {
      emitAction(result.action);
    }
    return result;
  }
  return { handleMessage, mode: ASSISTANT_MODE };
}