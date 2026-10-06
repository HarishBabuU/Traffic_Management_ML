/**
 * Step 4 — ML backend API client (FastAPI).
 *
 * Talks to the project's own FastAPI service which runs the EXISTING
 * YOLOv8n + ByteTrack pipeline. Every value rendered by the UI comes from the
 * API response; this module never computes, defaults or invents an ML result.
 *
 * Base URL comes from the VITE_API_BASE_URL environment variable so the same
 * build can target a local backend during development and a deployed backend
 * later:
 *
 *   VITE_API_BASE_URL=http://127.0.0.1:8110
 */

export const ML_API_DEFAULT_BASE_URL = 'http://127.0.0.1:8110';

/** Read the backend base URL from the build-time environment. */
export function apiBaseUrl(env = {}) {
  const raw = env && typeof env === 'object' ? env.VITE_API_BASE_URL : undefined;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return ML_API_DEFAULT_BASE_URL;
  return value.replace(/\/+$/, '');
}

/** Video containers the API accepts (kept identical to the backend). */
export const ACCEPTED_VIDEO_EXTENSIONS = ['.mp4', '.avi', '.mov', '.mkv'];

export const ACCEPTED_VIDEO_ATTRIBUTE = ACCEPTED_VIDEO_EXTENSIONS.join(',');

/** Pure — client-side pre-check of a chosen file (the API re-validates). */
export function validateVideoFile(file) {
  if (!file) {
    return { ok: false, code: 'no-file', message: 'Choose a video file first.' };
  }
  const name = typeof file.name === 'string' ? file.name : '';
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot).toLowerCase();
  if (!ACCEPTED_VIDEO_EXTENSIONS.includes(ext)) {
    return {
      ok: false,
      code: 'bad-extension',
      message: `Unsupported video type "${ext || name}". Accepted: ${ACCEPTED_VIDEO_EXTENSIONS.join(', ')}.`,
    };
  }
  return { ok: true, code: null, message: '' };
}

const FRIENDLY_STATUS = {
  400: 'The uploaded video was rejected. It may not be a readable video file.',
  404: 'The ML analysis endpoint was not found on the backend.',
  413: 'The uploaded video is larger than the backend accepts.',
  415: 'The backend refused this video format.',
  422: 'The backend could not read the uploaded file.',
  500: 'The ML backend failed while processing this video.',
  502: 'The ML backend is unreachable through its gateway.',
  503: 'The ML backend is unavailable right now.',
  504: 'The ML backend took too long to answer.',
};

/**
 * Pure — turn a non-OK API response into a user-friendly message without
 * leaking internals. Never invents a result.
 */
export function friendlyErrorMessage(status, detail) {
  const base = FRIENDLY_STATUS[status] || 'The ML backend returned an unexpected error.';
  const text = typeof detail === 'string' ? detail.trim() : '';
  if (!text) return `${base} (HTTP ${status})`;
  if (text.length > 240) return `${base} (HTTP ${status})`;
  return `${base} ${text}`;
}

/**
 * Pure — normalise one successful API payload for rendering. Any field the
 * backend did not return stays `null` (shown as "unavailable") rather than
 * being substituted.
 */
export function readAnalysisResponse(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const counts = src.vehicle_counts && typeof src.vehicle_counts === 'object' ? src.vehicle_counts : null;
  const conservative =
    src.conservative_counts && typeof src.conservative_counts === 'object'
      ? src.conservative_counts
      : null;

  return {
    success: src.success === true,
    model: typeof src.model === 'string' ? src.model : null,
    tracker: typeof src.tracker === 'string' ? src.tracker : null,
    videoName: typeof src.video_name === 'string' ? src.video_name : null,
    resolution: typeof src.resolution === 'string' ? src.resolution : null,
    fps: typeof src.fps === 'number' ? src.fps : null,
    totalFrames: typeof src.total_frames === 'number' ? src.total_frames : null,
    framesProcessed: typeof src.frames_processed === 'number' ? src.frames_processed : null,
    durationSeconds: typeof src.duration_seconds === 'number' ? src.duration_seconds : null,
    uniqueTracks: typeof src.unique_tracks === 'number' ? src.unique_tracks : null,
    conservativeTracks: typeof src.conservative_tracks === 'number' ? src.conservative_tracks : null,
    newTrackGated: typeof src.new_track_gated === 'number' ? src.new_track_gated : null,
    vehicleCounts: counts,
    conservativeCounts: conservative,
    activityRate: typeof src.activity_rate_ids_per_sec === 'number' ? src.activity_rate_ids_per_sec : null,
    trafficCondition: typeof src.traffic_condition === 'string' ? src.traffic_condition : null,
    elapsedSeconds: typeof src.elapsed_s === 'number' ? src.elapsed_s : null,
    shortLivedCount: typeof src.short_lived_count === 'number' ? src.short_lived_count : null,
    suspiciousCount: typeof src.suspicious_count === 'number' ? src.suspicious_count : null,
  };
}

/**
 * Build the multipart body for POST /api/analyze-video.
 * Field name is exactly `file`, as required by the backend.
 */
export function buildUploadBody(file) {
  const body = new FormData();
  body.append('file', file);
  return body;
}

/**
 * POST the video to the ML backend and return the parsed, normalised result.
 * `fetchImpl` is injectable so tests can drive it without a live backend.
 */
export async function analyzeVideo(file, options = {}) {
  const base = (options.baseUrl || apiBaseUrl(options.env || {})).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) {
    return {
      ok: false,
      code: 'no-fetch',
      status: 0,
      message: 'This browser cannot perform the upload request.',
      analysis: null,
    };
  }

  const validation = validateVideoFile(file);
  if (!validation.ok) {
    return { ok: false, code: validation.code, status: 0, message: validation.message, analysis: null };
  }

  let response;
  try {
    response = await fetchImpl(`${base}/api/analyze-video`, {
      method: 'POST',
      body: buildUploadBody(file),
      signal: options.signal,
    });
  } catch (error) {
    return {
      ok: false,
      code: 'network',
      status: 0,
      message: `Could not reach the ML backend at ${base}. Check that it is running, then try again.`,
      analysis: null,
    };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      code: 'http',
      status: response.status,
      message: friendlyErrorMessage(response.status, payload && payload.detail),
      analysis: null,
    };
  }

  const analysis = readAnalysisResponse(payload);
  if (!analysis.success) {
    return {
      ok: false,
      code: 'not-successful',
      status: response.status,
      message: 'The ML backend did not report a successful analysis.',
      analysis,
    };
  }

  return { ok: true, code: null, status: response.status, message: '', analysis };
}

/** Simple factory so the UI can inject a different fetch/base URL in tests. */
export function createMlApiClient(options = {}) {
  return {
    analyzeVideo: (file, opts = {}) => analyzeVideo(file, { ...options, ...opts }),
  };
}