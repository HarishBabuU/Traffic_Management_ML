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
 * Maps a location result to the UI-facing card: { status, label, note, coords }.
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
    return {
      status: 'LIVE',
      label: LOCATION_STATUS_TEXT.live,
      coords,
      note:
        coords && Number.isFinite(coords.accuracy)
          ? `Accuracy ±${Math.round(coords.accuracy)} m` +
            (coords.timestamp ? ` · observed ${new Date(coords.timestamp).toISOString()}` : '')
          : 'Real browser-reported position.',
    };
  }
  if (status === LOCATION_STATES.loading) {
    return { status: 'STATIC', label: LOCATION_STATUS_TEXT.loading, coords: null, note: 'Requesting your position with your permission…' };
  }
  if (status === LOCATION_STATES.denied) {
    return { status: 'UNKNOWN', label: LOCATION_STATUS_TEXT.denied, coords: null, note: 'Permission was refused — enter your origin manually.' };
  }
  if (status === LOCATION_STATES.unavailable) {
    return { status: 'UNKNOWN', label: LOCATION_STATUS_TEXT.unavailable, coords: null, note: LOCATION_UNAVAILABLE_MESSAGE };
  }
  return { status: 'STATIC', label: LOCATION_STATUS_TEXT.idle, coords: null, note: 'Press "Use my location" or enter your origin manually.' };
}

/**
 * Browser geolocation wrapper. Returns { status, code, coords, source }.
 * Never fabricates; a missing API or error yields an explicit state.
 */
export function createLocationProvider({
  geolocation =
    typeof navigator !== 'undefined' && navigator.geolocation
      ? navigator.geolocation
      : null,
  timeoutMs = 12000,
} = {}) {
  function supports() {
    return !!(geolocation && typeof geolocation.getCurrentPosition === 'function');
  }

  function detect() {
    if (!supports()) {
      return Promise.resolve({
        status: LOCATION_STATES.unavailable,
        code: 'unsupported',
        coords: null,
        source: 'browser-geolocation',
      });
    }
    return new Promise((resolve) => {
      const onSuccess = (position) => {
        const c = position && position.coords;
        resolve({
          status: LOCATION_STATES.live,
          code: null,
          coords: c
            ? {
                lat: Number(c.latitude),
                lon: Number(c.longitude),
                accuracy: Number.isFinite(Number(c.accuracy)) ? Number(c.accuracy) : null,
                timestamp: position.timestamp ?? null,
              }
            : null,
          source: 'browser-geolocation',
        });
      };
      const onError = (err) => {
        const code = err && Number(err.code);
        resolve({
          status: code === 1 ? LOCATION_STATES.denied : LOCATION_STATES.unavailable,
          code:
            code === 1
              ? 'permission-denied'
              : code === 2
                ? 'position-unavailable'
                : code === 3
                  ? 'timeout'
                  : 'unknown',
          coords: null,
          source: 'browser-geolocation',
        });
      };
      try {
        geolocation.getCurrentPosition(onSuccess, onError, {
          enableHighAccuracy: false,
          timeout: timeoutMs,
          maximumAge: 60000,
        });
      } catch {
        resolve({
          status: LOCATION_STATES.unavailable,
          code: 'exception',
          coords: null,
          source: 'browser-geolocation',
        });
      }
    });
  }

  return { detect, supports };
}