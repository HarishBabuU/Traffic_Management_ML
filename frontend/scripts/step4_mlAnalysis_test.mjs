/**
 * Step 4 | on-demand ML analysis panel (frontend ↔ FastAPI backend).
 *
 * The API client (src/services/mlApi.js) is plain ESM, so it is imported
 * directly here and driven with an injected `fetch`. This proves:
 *
 *   1. The API base URL comes from VITE_API_BASE_URL (no hardcoded domain).
 *   2. A multipart POST is sent to /api/analyze-video with field name `file`.
 *   3. Rendered values are exactly the API response values (no recompute, no
 *      substituted defaults for missing fields).
 *   4. An unsupported extension is rejected before any network call.
 *   5. API unavailable / invalid video / server error all produce friendly
 *      messages and never a fake result.
 *   6. The component source contains no hardcoded ML values.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Blob as NodeBlob } from 'node:buffer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src', 'services', 'mlApi.js');

// Node exposes FormData/File/Blob globally from v18; only fill gaps.
if (typeof globalThis.FormData === 'undefined') {
  globalThis.FormData = class FormDataShim {
    constructor() {
      this._parts = new Map();
    }
    append(name, value) {
      this._parts.set(name, value);
    }
    get(name) {
      return this._parts.has(name) ? this._parts.get(name) : null;
    }
  };
}
if (typeof globalThis.Blob === 'undefined') globalThis.Blob = NodeBlob;

const ml = await import(pathToFileURL(SRC).href);

const BASE = 'http://127.0.0.1:8110';

function fakeFile(name, bytes = 64) {
  const parts = [new Uint8Array(bytes)];
  return new globalThis.File(parts, name, { type: 'video/mp4' });
}

function apiResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const REAL_API_BODY = {
  success: true,
  model: 'YOLOv8n',
  tracker: 'ByteTrack',
  video_name: 'upload_abc123.mp4',
  resolution: '1280x720',
  fps: 25.0,
  total_frames: 150,
  frames_processed: 150,
  elapsed_s: 34.6,
  unique_tracks: 35,
  conservative_tracks: 29,
  new_track_gated: 2,
  vehicle_counts: { car: 28, motorcycle: 2, bus: 2, truck: 3, bicycle: 0 },
  conservative_counts: { car: 24, motorcycle: 1, bus: 2, truck: 2, bicycle: 0 },
  duration_seconds: 6.0,
  activity_rate_ids_per_sec: 5.8333,
  traffic_condition: 'HEAVY',
  short_lived_count: 3,
  suspicious_count: 0,
};

/* ── base URL / environment ────────────────────────────────────────────── */

test('Step 4: the API base URL comes from VITE_API_BASE_URL', () => {
  assert.equal(ml.apiBaseUrl({ VITE_API_BASE_URL: 'http://127.0.0.1:8110' }), 'http://127.0.0.1:8110');
  assert.equal(ml.apiBaseUrl({ VITE_API_BASE_URL: 'https://api.example.org/' }), 'https://api.example.org');
  assert.equal(ml.apiBaseUrl({}), ml.ML_API_DEFAULT_BASE_URL, 'falls back to the documented local default');
  assert.equal(ml.apiBaseUrl(), ml.ML_API_DEFAULT_BASE_URL, 'undefined env is safe');
});

test('Step 4: the frontend and env files hardcode no deployed domain', () => {
  const client = readFileSync(SRC, 'utf8');
  assert.match(client, /VITE_API_BASE_URL/, 'base URL comes from the environment variable');
  const domains = client.match(/https:\/\/[^\s'"`)]+/g) || [];
  const real = domains.filter((u) => !/^https:\/\/127\.0\.0\.1/.test(u));
  assert.deepEqual(real, [], 'no external domain is hardcoded in the API client');

  const envDev = readFileSync(join(ROOT, '.env.development'), 'utf8');
  assert.match(envDev, /VITE_API_BASE_URL=http:\/\/127\.0\.0\.1:8110/, 'dev env points at the local backend');
  const envProd = readFileSync(join(ROOT, '.env.production'), 'utf8');
  assert.match(envProd, /VITE_API_BASE_URL=http:\/\/127\.0\.0\.1:8110/);
  assert.doesNotMatch(envProd, /https:\/\/(?!127\.0\.0\.1)/, 'production env invents no future domain');
});

/* ── request shape ─────────────────────────────────────────────────────── */

test('Step 4: the client POSTs multipart form-data under the field name "file"', () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return apiResponse(REAL_API_BODY);
  };
  return ml.analyzeVideo(fakeFile('CCTV-B01.mp4'), { baseUrl: BASE, fetchImpl }).then(() => {
    assert.equal(calls.length, 1, 'exactly one request is sent');
    assert.equal(calls[0].url, `${BASE}/api/analyze-video`);
    assert.equal(calls[0].init.method, 'POST');
    assert.ok(calls[0].init.body instanceof FormData, 'the body is FormData');
    assert.ok(
      calls[0].init.body.get('file'),
      'the multipart field name is exactly "file"'
    );
    assert.equal(calls[0].init.body.get('file').name, 'CCTV-B01.mp4');
  });
});

/* ── response fidelity ─────────────────────────────────────────────────── */

test('Step 4: every rendered value is taken verbatim from the API response', async () => {
  const fetchImpl = async () => apiResponse(REAL_API_BODY);
  const out = await ml.analyzeVideo(fakeFile('CCTV-B01.mp4'), { baseUrl: BASE, fetchImpl });
  assert.equal(out.ok, true);
  const a = out.analysis;
  assert.equal(a.model, 'YOLOv8n');
  assert.equal(a.tracker, 'ByteTrack');
  assert.equal(a.videoName, 'upload_abc123.mp4');
  assert.equal(a.resolution, '1280x720');
  assert.equal(a.fps, 25.0);
  assert.equal(a.totalFrames, 150);
  assert.equal(a.framesProcessed, 150);
  assert.equal(a.durationSeconds, 6.0);
  assert.equal(a.uniqueTracks, 35);
  assert.equal(a.conservativeTracks, 29);
  assert.equal(a.vehicleCounts.car, 28);
  assert.equal(a.vehicleCounts.motorcycle, 2);
  assert.equal(a.vehicleCounts.bus, 2);
  assert.equal(a.vehicleCounts.truck, 3);
  assert.equal(a.vehicleCounts.bicycle, 0);
  assert.equal(a.conservativeCounts.car, 24);
  assert.equal(a.activityRate, 5.8333);
  assert.equal(a.trafficCondition, 'HEAVY', 'the traffic condition is taken from the API, not computed');
});

test('Step 4: a missing field stays null (shown as unavailable) and is never invented', async () => {
  const fetchImpl = async () =>
    apiResponse({ success: true, model: 'YOLOv8n', tracker: 'ByteTrack', video_name: 'x.mp4' });
  const out = await ml.analyzeVideo(fakeFile('a.mp4'), { baseUrl: BASE, fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(out.analysis.uniqueTracks, null);
  assert.equal(out.analysis.framesProcessed, null);
  assert.equal(out.analysis.activityRate, null);
  assert.equal(out.analysis.trafficCondition, null);
  assert.equal(out.analysis.vehicleCounts, null);
});

test('Step 4: success=false is never treated as a result', async () => {
  const fetchImpl = async () => apiResponse({ success: false, model: 'YOLOv8n' });
  const out = await ml.analyzeVideo(fakeFile('a.mp4'), { baseUrl: BASE, fetchImpl });
  assert.equal(out.ok, false);
  assert.match(out.message, /did not report a successful analysis/i);
});

/* ── validation and failures ───────────────────────────────────────────── */

test('Step 4: an unsupported extension is rejected before any request', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return apiResponse(REAL_API_BODY);
  };
  const out = await ml.analyzeVideo(fakeFile('notes.txt'), { baseUrl: BASE, fetchImpl });
  assert.equal(out.ok, false);
  assert.equal(called, false, 'no upload is attempted');
  assert.match(out.message, /Unsupported video type/i);
});

test('Step 4: a missing file is rejected with a clear message', () => {
  const check = ml.validateVideoFile(null);
  assert.equal(check.ok, false);
  assert.match(check.message, /Choose a video file first/i);
  assert.equal(ml.validateVideoFile(fakeFile('a.MP4')).ok, true, 'extension match is case-insensitive');
  ['.mp4', '.avi', '.mov', '.mkv'].forEach((ext) => {
    assert.equal(ml.validateVideoFile(fakeFile(`clip${ext}`)).ok, true, `${ext} accepted`);
  });
});

test('Step 4: an unavailable backend yields a friendly message and no result', async () => {
  const fetchImpl = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:8110');
  };
  const out = await ml.analyzeVideo(fakeFile('a.mp4'), { baseUrl: BASE, fetchImpl });
  assert.equal(out.ok, false);
  assert.equal(out.analysis, null, 'nothing is fabricated when the API is unreachable');
  assert.match(out.message, /Could not reach the ML backend/i);
  assert.match(out.message, /127\.0\.0\.1:8110/, 'the message names the backend it tried');
});

test('Step 4: a 500 ML error is surfaced as a friendly message, not a stack trace', async () => {
  const fetchImpl = async () => apiResponse({ detail: 'Processing error: boom' }, 500);
  const out = await ml.analyzeVideo(fakeFile('a.mp4'), { baseUrl: BASE, fetchImpl });
  assert.equal(out.ok, false);
  assert.equal(out.analysis, null);
  assert.match(out.message, /failed while processing/i);
});

test('Step 4: rejected / oversized / unreachable videos are distinguishable', () => {
  assert.match(ml.friendlyErrorMessage(400, ''), /rejected/i);
  assert.match(ml.friendlyErrorMessage(413, ''), /larger than the backend accepts/i);
  assert.match(ml.friendlyErrorMessage(404, ''), /not found/i);
  assert.match(ml.friendlyErrorMessage(503, ''), /unavailable/i);
  assert.match(ml.friendlyErrorMessage(500, 'detail text'), /detail text/);
  assert.doesNotMatch(ml.friendlyErrorMessage(500, ''), /undefined|\[object/i, 'no raw JS leaks into the message');
});

/* ── component guarantees ──────────────────────────────────────────────── */

test('Step 4: the panel renders the response and holds no literal ML values', () => {
  const panel = readFileSync(join(ROOT, 'src', 'components', 'MlVideoAnalysisPanel.jsx'), 'utf8');
  assert.match(panel, /value\(result\.trafficCondition\)/, 'the condition is read from the response');
  assert.match(panel, /value\(result\.activityRate/, 'the activity rate is read from the response');
  assert.match(panel, /value\(result\.uniqueTracks\)/, 'the track count is read from the response');
  assert.doesNotMatch(panel, /unique_tracks:\s*\d/, 'no literal track count');
  assert.doesNotMatch(panel, /frames_processed:\s*\d/, 'no literal frame count');
  assert.doesNotMatch(panel, /activity_rate_ids_per_sec:\s*[\d.]/, 'no literal activity rate');
  assert.doesNotMatch(panel, /'HEAVY'\s*[,}]/, 'no hardcoded condition fallback');
  assert.match(panel, /disabled=\{busy\}/, 'the input is disabled while a request is in flight');
});

test('Step 4: the panel is wired into the CCTV view without touching the recorded-demo registry', () => {
  const cctv = readFileSync(join(ROOT, 'src', 'components', 'CctvInvestigationSection.jsx'), 'utf8');
  assert.match(cctv, /import MlVideoAnalysisPanel from '\.\/MlVideoAnalysisPanel';/);
  assert.match(cctv, /<MlVideoAnalysisPanel \/>/, 'the panel is rendered in the CCTV view');
  // The existing recorded-demo contract must be untouched.
  assert.match(cctv, /demoCctvVideoUrl\(selectedEvidence\.route_id, selectedEvidence\.source_video\)/);
  assert.match(cctv, /DEMO_LABEL/);
  assert.match(cctv, /GEO_CCTV_NOTE/);
});

test('Step 4: the existing provider services are untouched by the integration', () => {
  const providers = readFileSync(join(ROOT, 'src', 'services', 'locationProviders.js'), 'utf8');
  assert.match(providers, /photon\.komoot\.io/, 'Photon geocoding endpoint intact');
  assert.match(providers, /router\.project-osrm\.org/, 'OSRM routing endpoint intact');
  const weather = readFileSync(join(ROOT, 'src', 'services', 'weatherProvider.js'), 'utf8');
  assert.match(weather, /api\.open-meteo\.com/, 'Open-Meteo endpoint intact');
});