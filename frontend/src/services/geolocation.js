/**
 * Current-location provider (browser Geolocation API).
 *
 * The system only ever surfaces a location that the browser actually returned
 * after explicit user permission. States:
 *
 *   live       → LOCATION LIVE (real coordinates + accuracy + timestamp)
 *   loading    → LOCATION DETECTING
 *   idle       → LOCATION PERMISSION REQUIRED (never prompted yet / not detected)
 *   denied     → LOCATION DENIED (user refused permission)
 *   unavailable→ LOCATION UNAVAILABLE (no API, error, or timeout)
 *
 * Precision rules:
 *   - The browser-reported `coords.accuracy` (metres, 95 % confidence radius)
 *     is carried through everywhere and classified into an accuracy band.
 *   - Coordinates are NEVER called exact. A fix is always labelled with its
 *     accuracy, and a poor fix is explicitly labelled approximate.
 *   - Coordinates are never nudged, rounded towards a known place, or replaced
 *     by a hardcoded default. If the device cannot produce a good fix, the UI
 *     says so instead of pretending the point is precise.
 *
 * injectable `geolocation` keeps this deterministic under `node --test`.
 */

export const LOCATION_STATES = {
  idle: 'idle',
  loading: 'loading',
  live: 'live',
  denied: 'denied',
  unavailable: 'unavailable',
};

export const LOCATION_STATUS_TEXT = {
  live: 'LOCATION LIVE',
  loading: 'LOCATION DETECTING',
  idle: 'LOCATION PERMISSION REQUIRED',
  denied: 'LOCATION DENIED',
  unavailable: 'LOCATION UNAVAILABLE',
};

export const LOCATION_UNAVAILABLE_MESSAGE =
  'Current location unavailable — enter your origin manually.';

/**
 * Accuracy bands derived from the browser-reported accuracy radius in metres.
 * Anything at or above LOW is presented to the user as approximate.
 */
export const LOCATION_PRECISION = {
  high: 'high',
  fair: 'fair',
  low: 'low',
  poor: 'poor',
  unknown: 'unknown',
};

/** Upper bound (metres, inclusive) of each band. */
export const LOCATION_ACCURACY_BANDS = {
  high: 50,
  fair: 200,
  low: 1000,
};

/**
 * Normalises a browser-reported accuracy radius. Returns null when the browser
 * gave no usable value — which is unknown precision, never good precision.
 */
export function toAccuracyMeters(accuracy) {
  if (accuracy === null || accuracy === undefined || accuracy === '') return null;
  const meters = Number(accuracy);
  if (!Number.isFinite(meters) || meters < 0) return null;
  return meters;
}

/**
 * Classifies a browser-reported accuracy radius. A missing / non-numeric
 * accuracy is `unknown`, never silently treated as good.
 */
export function accuracyBand(accuracy) {
  const meters = toAccuracyMeters(accuracy);
  if (meters === null) return LOCATION_PRECISION.unknown;
  if (meters <= LOCATION_ACCURACY_BANDS.high) return LOCATION_PRECISION.high;
  if (meters <= LOCATION_ACCURACY_BANDS.fair) return LOCATION_PRECISION.fair;
  if (meters <= LOCATION_ACCURACY_BANDS.low) return LOCATION_PRECISION.low;
  return LOCATION_PRECISION.poor;
}

/** A fix is only called accurate when the browser said so. */
export function isPreciseFix(accuracy) {
  return accuracyBand(accuracy) === LOCATION_PRECISION.high;
}

/** True for anything that must be shown as an approximate position. */
export function isApproximateFix(accuracy) {
  return !isPreciseFix(accuracy);
}

/** Wording per band — never implies more precision than the browser reported. */
export function precisionLabel(accuracy) {
  const meters = toAccuracyMeters(accuracy);
  switch (accuracyBand(meters)) {
    case LOCATION_PRECISION.high:
      return `Precise to ±${Math.round(meters)} m`;
    case LOCATION_PRECISION.fair:
      return `Approximate · accurate to ±${Math.round(meters)} m`;
    case LOCATION_PRECISION.low:
      return `Approximate · only accurate to ±${Math.round(meters)} m`;
    case LOCATION_PRECISION.poor:
      return `Approximate · very rough position, only accurate to ±${Math.round(meters)} m`;
    default:
      return 'Approximate · the browser did not report an accuracy value';
  }
}

/**
 * Extra, code-specific guidance on top of the shared unavailable message.
 */
const LOCATION_ERROR_NOTES = {
  'position-unavailable':
    'Your device could not determine a position (no GPS fix, indoor or airplane mode).',
  timeout: 'The position request timed out. Try again outdoors with GPS enabled.',
  unsupported:
    'This browser does not expose the Geolocation API, so no position can be read.',
  exception: 'The browser refused the position request.',
  unknown: 'The browser could not determine your position.',
};

/**
 * Maps a location result to the UI-facing card:
 * { status, label, note, coords, precision, isApproximate, accuracyMeters }.
 */
export function locationCard(location = {}) {
  const status = location.status || LOCATION_STATES.idle;
  const coords =
    status === LOCATION_STATES.live && location.coords
      ? {
          lat: Number(location.coords.lat),
          lon: Number(location.coords.lon),
          accuracy: location.coords.accuracy ?? null,
          timestamp: location.coords.timestamp ?? null,
        }
      : null;
  if (status === LOCATION_STATES.live) {
    const accuracyMeters = toAccuracyMeters(coords ? coords.accuracy : null);
    const approximate = isApproximateFix(accuracyMeters);
    const observed = coords && coords.timestamp
      ? ` · observed ${new Date(coords.timestamp).toISOString()}`
      : '';
    return {
      status: approximate ? 'APPROX' : 'LIVE',
      label: approximate ? LOCATION_STATUS_TEXT.live.replace('LOCATION LIVE', 'LOCATION (APPROXIMATE)') : LOCATION_STATUS_TEXT.live,
      coords,
      precision: accuracyBand(accuracyMeters),
      isApproximate: approximate,
      accuracyMeters,
      note: `${precisionLabel(accuracyMeters)}${
        approximate ? ' — this is the browser-reported radius, not a precise point.' : ''
      }${observed}`,
    };
  }
  if (status === LOCATION_STATES.loading) {
    return { status: 'STATIC', label: LOCATION_STATUS_TEXT.loading, coords: null, note: 'Requesting your position with your permission…' };
  }
  if (status === LOCATION_STATES.denied) {
    return { status: 'UNKNOWN', label: LOCATION_STATUS_TEXT.denied, coords: null, note: 'Permission was refused — enter your origin manually.' };
  }
  if (status === LOCATION_STATES.unavailable) {
    const detail = LOCATION_ERROR_NOTES[location.code] || '';
    return {
      status: 'UNKNOWN',
      label: LOCATION_STATUS_TEXT.unavailable,
      coords: null,
      note: detail ? `${LOCATION_UNAVAILABLE_MESSAGE} ${detail}` : LOCATION_UNAVAILABLE_MESSAGE,
    };
  }
  return { status: 'STATIC', label: LOCATION_STATUS_TEXT.idle, coords: null, note: 'Press "Use my location" or enter your origin manually.' };
}

/**
 * Browser geolocation wrapper. Returns
 * { status, code, coords, source, precision, isApproximate }.
 *
 * Never fabricates and never adjusts coordinates; a missing API, a refused
 * permission or a failed fix yields an explicit state with a specific reason.
 */
export function createLocationProvider({
  geolocation =
    typeof navigator !== 'undefined' && navigator.geolocation
      ? navigator.geolocation
      : null,
  timeoutMs = 12000,
  // Ask the device for its best fix instead of a coarse network-derived one.
  // The accuracy the browser reports back is what the UI labels the point with.
  enableHighAccuracy = true,
  // 0 ⇒ do not reuse a possibly stale cached fix.
  maximumAge = 0,
} = {}) {
  function supports() {
    return !!(geolocation && typeof geolocation.getCurrentPosition === 'function');
  }

  function unavailable(code) {
    return {
      status: LOCATION_STATES.unavailable,
      code,
      coords: null,
      source: 'browser-geolocation',
      precision: LOCATION_PRECISION.unknown,
      isApproximate: true,
    };
  }

  function detect() {
    if (!supports()) {
      return Promise.resolve(unavailable('unsupported'));
    }
    return new Promise((resolve) => {
      const onSuccess = (position) => {
        const c = position && position.coords;
        if (!c || !Number.isFinite(Number(c.latitude)) || !Number.isFinite(Number(c.longitude))) {
          resolve(unavailable('position-unavailable'));
          return;
        }
        const accuracy = toAccuracyMeters(c.accuracy);
        resolve({
          status: LOCATION_STATES.live,
          code: null,
          coords: {
            lat: Number(c.latitude),
            lon: Number(c.longitude),
            accuracy,
            // Reported radius of confidence around the fix — the raw value the
            // browser gave us, never a recomputed or invented one.
            accuracyRadiusMeters: accuracy,
            precision: accuracyBand(accuracy),
            isApproximate: isApproximateFix(accuracy),
            timestamp: position.timestamp ?? null,
          },
          source: 'browser-geolocation',
          precision: accuracyBand(accuracy),
          isApproximate: isApproximateFix(accuracy),
        });
      };
      const onError = (err) => {
        const code = err && Number(err.code);
        if (code === 1) {
          resolve({
            status: LOCATION_STATES.denied,
            code: 'permission-denied',
            coords: null,
            source: 'browser-geolocation',
            precision: LOCATION_PRECISION.unknown,
            isApproximate: true,
          });
          return;
        }
        resolve(
          unavailable(
            code === 2
              ? 'position-unavailable'
              : code === 3
                ? 'timeout'
                : 'unknown'
          )
        );
      };
      try {
        geolocation.getCurrentPosition(onSuccess, onError, {
          enableHighAccuracy,
          timeout: timeoutMs,
          maximumAge,
        });
      } catch {
        resolve(unavailable('exception'));
      }
    });
  }

  return { detect, supports };
}