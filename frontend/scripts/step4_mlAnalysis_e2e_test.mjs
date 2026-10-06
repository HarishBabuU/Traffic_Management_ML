/**
 * Step 4 | real end-to-end check: frontend client -> FastAPI -> YOLOv8n +
 * ByteTrack -> values rendered by the frontend view-model.
 *
 * Exercises the ACTUAL production path:
 *   - `analyzeVideo()` — the same client the React panel calls, with the real
 *     multipart body built by `buildUploadBody()` (field name `file`);
 *   - a real uvicorn server running api.main:app (the real ML backend);
 *   - the real project video data/demo_cctv/route_b/CCTV-B01.mp4;
 *   - `readAnalysisResponse()` — the exact function the panel renders from.
 *
 * Nothing is stubbed and no ML value is asserted as a constant: the checks are
 * internally consistent with the video itself, so they stay valid if the model
 * or thresholds change.
 *
 * Run directly:  node scripts/step4_mlAnalysis_e2e_test.mjs
 * Skipped (exit 0) when the backend python env or the source video is missing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PROJECT = join(ROOT, '..');
const SRC = join(ROOT, 'src', 'services', 'mlApi.js');
const VIDEO = join(PROJECT, 'data', 'demo_cctv', 'route_b', 'CCTV-B01.mp4');
const PYTHON = process.env.TRAFFIC_API_PYTHON || join(PROJECT, 'venv', 'Scripts', 'python.exe');
const PORT = Number(process.env.TRAFFIC_API_PORT || 8110);
const BASE = `http://127.0.0.1:${PORT}`;

const ml = await import(pathToFileURL(SRC).href);

const failures = [];
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

if (!existsSync(VIDEO) || !existsSync(PYTHON)) {
  console.log('SKIP: backend python env or source video unavailable.');
  process.exit(0);
}

const server = spawn(
  PYTHON,
  ['-m', 'uvicorn', 'api.main:app', '--host', '127.0.0.1', `--port=${PORT}`],
  { cwd: PROJECT, stdio: ['ignore', 'pipe', 'pipe'] }
);
let serverLog = '';
server.stdout.on('data', (d) => {
  serverLog += d.toString();
});
server.stderr.on('data', (d) => {
  serverLog += d.toString();
});

async function waitForServer(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function shutdown() {
  try {
    if (process.platform === 'win32' && server.pid) {
      spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      server.kill();
    }
  } catch {
    /* best effort */
  }
}

let code = 1;
try {
  if (!(await waitForServer())) {
    console.log('Backend failed to start. Server output:\n' + serverLog);
    process.exit(1);
  }

  const health = await (await fetch(`${BASE}/health`)).json();
  console.log('\n/health:', JSON.stringify(health));
  check('backend healthy', health.status === 'ok');
  check('backend reports ML weights available', health.ml_available === true);

  // ---- real upload through the same client the panel uses ----
  const bytes = readFileSync(VIDEO);
  const file = new File([bytes], 'CCTV-B01.mp4', { type: 'video/mp4' });

  const started = Date.now();
  const out = await ml.analyzeVideo(file, { baseUrl: BASE });
  const elapsed = (Date.now() - started) / 1000;

  console.log(`\nE2E elapsed: ${elapsed.toFixed(1)}s`);
  console.log(
    'API response:\n' +
      JSON.stringify(
        {
          success: out.analysis?.success,
          model: out.analysis?.model,
          tracker: out.analysis?.tracker,
          video_name: out.analysis?.videoName,
          resolution: out.analysis?.resolution,
          fps: out.analysis?.fps,
          total_frames: out.analysis?.totalFrames,
          frames_processed: out.analysis?.framesProcessed,
          unique_tracks: out.analysis?.uniqueTracks,
          conservative_tracks: out.analysis?.conservativeTracks,
          vehicle_counts: out.analysis?.vehicleCounts,
          conservative_counts: out.analysis?.conservativeCounts,
          duration_seconds: out.analysis?.durationSeconds,
          activity_rate_ids_per_sec: out.analysis?.activityRate,
          traffic_condition: out.analysis?.trafficCondition,
        },
        null,
        2
      )
  );

  check('upload + inference succeeded', out.ok === true, out.message);
  const a = out.analysis;
  check('model is YOLOv8n', a.model === 'YOLOv8n');
  check('tracker is ByteTrack', a.tracker === 'ByteTrack');
  check('every frame processed (150/150)', a.totalFrames === 150 && a.framesProcessed === 150);
  check('fps read from the clip', a.fps === 25.0);
  check('duration read from the clip', a.durationSeconds === 6.0);
  check('unique tracks present', typeof a.uniqueTracks === 'number' && a.uniqueTracks > 0, String(a.uniqueTracks));
  check(
    'conservative tracks are a subset',
    a.conservativeTracks <= a.uniqueTracks,
    `${a.conservativeTracks} of ${a.uniqueTracks}`
  );
  const classTotal = Object.values(a.vehicleCounts).reduce((s, n) => s + n, 0);
  check('class counts sum to unique tracks', classTotal === a.uniqueTracks, `${classTotal} = ${a.uniqueTracks}`);
  const consTotal = Object.values(a.conservativeCounts).reduce((s, n) => s + n, 0);
  check(
    'conservative counts sum to conservative tracks',
    consTotal === a.conservativeTracks,
    `${consTotal} = ${a.conservativeTracks}`
  );
  const expectedRate = a.uniqueTracks / a.durationSeconds;
  check(
    'activity rate equals unique_tracks / duration',
    Math.abs(a.activityRate - expectedRate) < 0.001,
    `${a.activityRate} vs ${expectedRate.toFixed(4)}`
  );
  check(
    'condition is one of the four documented bands',
    ['LOW', 'MODERATE', 'HEAVY', 'CONGESTED'].includes(a.trafficCondition),
    a.trafficCondition
  );
  check(
    'band matches the documented thresholds',
    (a.trafficCondition === 'LOW' && a.activityRate < 1) ||
      (a.trafficCondition === 'MODERATE' && a.activityRate >= 1 && a.activityRate < 4) ||
      (a.trafficCondition === 'HEAVY' && a.activityRate >= 4 && a.activityRate < 8) ||
      (a.trafficCondition === 'CONGESTED' && a.activityRate >= 8)
  );
  check(
    'upload stored under a generated name (no client path exposed)',
    typeof a.videoName === 'string' && !a.videoName.includes('\\') && !a.videoName.includes('..')
  );

  // ---- real rejection path ----
  const badFile = new File([Buffer.from('not a video')], 'notes.txt', { type: 'text/plain' });
  const rejected = await ml.analyzeVideo(badFile, { baseUrl: BASE });
  check('unsupported extension rejected by the client', rejected.ok === false);
  check('rejection message is friendly', /Unsupported video type/i.test(rejected.message), rejected.message);

  const badBody = new FormData();
  badBody.append('file', new File([Buffer.from('not a video')], 'notes.txt', { type: 'text/plain' }));
  const badRes = await fetch(`${BASE}/api/analyze-video`, { method: 'POST', body: badBody });
  check('backend rejects it with HTTP 400', badRes.status === 400, `HTTP ${badRes.status}`);

  code = failures.length === 0 ? 0 : 1;
} catch (error) {
  console.log('ERROR:', error && error.message ? error.message : error);
  console.log('Server output:\n' + serverLog);
  code = 1;
} finally {
  shutdown();
}

console.log(
  failures.length === 0
    ? '\nE2E RESULT: all checks passed.'
    : `\nE2E RESULT: ${failures.length} check(s) failed: ${failures.join(', ')}`
);
process.exit(code);
