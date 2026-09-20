/**
 * Step 4 | demo CCTV endpoint verification (real HTTP streams).
 *
 * Boots the EXISTING Vite preview server (with the demo-CCTV middleware from
 * vite.config.js) on a scratch port and verifies the recorded-demo clips are
 * genuinely streamed — not SPA HTML fallbacks and never copied into dist:
 *
 *   - every registered route_a/route_b/route_c clip answers 200 video/mp4
 *     with a body byte-identical in length to the source file on disk;
 *   - HTTP Range requests answer 206 with an exact Content-Range;
 *   - an invalid Range falls back to a full 200 video/mp4 response;
 *   - cross-route lookups (e.g. route_a/CCTV-B01.mp4) never return video;
 *   - the build output (dist) contains zero .mp4 files (nothing copied).
 *
 * NOTE: requires `npm run build` output. Skipped with a clear message if the
 * build output is missing (the preview server serves dist).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 4287;
const BASE = `http://127.0.0.1:${PORT}`;

const REGISTRY = [
  ['route_a', 'CCTV-A01.mp4'],
  ['route_a', 'CCTV-A02.mp4'],
  ['route_a', 'CCTV-A03.mp4'],
  ['route_b', 'CCTV-B01.mp4'],
  ['route_b', 'CCTV-B02.mp4'],
  ['route_b', 'CCTV-B03.mp4'],
  ['route_c', 'CCTV-C01.mp4'],
  ['route_c', 'CCTV-C02.mp4'],
  ['route_c', 'CCTV-C03.mp4'],
];

const hasBuild = existsSync(join(ROOT, 'dist', 'index.html'));

let child = null;
let bootError = null;

async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/demo-cctv/route_b/CCTV-B01.mp4`, {
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(2000),
      });
      if (res.status === 206) return true;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

if (hasBuild) {
  before(async () => {
    child = spawn(
      process.execPath,
      [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      { cwd: ROOT, stdio: 'pipe' }
    );
    child.on('error', (err) => {
      bootError = err;
    });
    const ready = await waitForServer();
    if (!ready) {
      bootError = bootError || new Error('vite preview server did not become ready');
    }
  });

  after(() => {
    if (child && !child.killed) child.kill();
  });
}

function sourceFile(routeDir, fileName) {
  return join(ROOT, '..', 'data', 'demo_cctv', routeDir, fileName);
}

test('Step 4: every registered demo CCTV clip streams as video/mp4 with the exact on-disk length', { skip: !hasBuild }, async () => {
  if (bootError) throw bootError;
  for (const [routeDir, fileName] of REGISTRY) {
    const url = `${BASE}/demo-cctv/${routeDir}/${fileName}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    assert.equal(res.status, 200, `${routeDir}/${fileName} → 200`);
    assert.equal(res.headers.get('content-type'), 'video/mp4', `${routeDir}/${fileName} → video/mp4`);
    assert.equal(res.headers.get('accept-ranges'), 'bytes', `${routeDir}/${fileName} → Accept-Ranges: bytes`);
    const size = statSync(sourceFile(routeDir, fileName)).size;
    const body = await res.arrayBuffer();
    assert.equal(body.byteLength, size, `${routeDir}/${fileName} body matches the source file on disk exactly`);
  }
});

test('Step 4: HTTP Range requests answer 206 with an exact Content-Range (video streaming works)', { skip: !hasBuild }, async () => {
  if (bootError) throw bootError;
  const fileName = 'CCTV-B02.mp4';
  const size = statSync(sourceFile('route_b', fileName)).size;

  const start = await fetch(`${BASE}/demo-cctv/route_b/${fileName}`, {
    headers: { Range: 'bytes=0-99' },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(start.status, 206, 'first-byte range → 206 Partial Content');
  assert.equal(start.headers.get('content-type'), 'video/mp4');
  assert.equal(start.headers.get('content-range'), `bytes 0-99/${size}`);
  assert.equal((await start.arrayBuffer()).byteLength, 100, 'range body is exactly the requested 100 bytes');

  const mid = await fetch(`${BASE}/demo-cctv/route_b/${fileName}`, {
    headers: { Range: 'bytes=1024-1123' },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(mid.status, 206, 'mid-file range → 206');
  assert.equal(mid.headers.get('content-range'), `bytes 1024-1123/${size}`);
  assert.equal((await mid.arrayBuffer()).byteLength, 100);

  const badRange = await fetch(`${BASE}/demo-cctv/route_b/${fileName}`, {
    headers: { Range: 'bytes=not-a-range' },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(badRange.status, 200, 'invalid range gracefully falls back to a full 200 response');
  assert.equal(badRange.headers.get('content-type'), 'video/mp4');
});

test('Step 4: HEAD requests are served as media (content length advertised, no SPA fallback)', { skip: !hasBuild }, async () => {
  if (bootError) throw bootError;
  const res = await fetch(`${BASE}/demo-cctv/route_c/CCTV-C03.mp4`, {
    method: 'HEAD',
    signal: AbortSignal.timeout(10000),
  });
  const size = statSync(sourceFile('route_c', 'CCTV-C03.mp4')).size;
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('content-length'), String(size));
});

test('Step 4: cross-route lookups never return video; only the registered route folder is served', { skip: !hasBuild }, async () => {
  if (bootError) throw bootError;
  const res = await fetch(`${BASE}/demo-cctv/route_a/CCTV-B01.mp4`, {
    signal: AbortSignal.timeout(10000),
  });
  assert.notEqual(res.headers.get('content-type'), 'video/mp4', 'a camera from another route folder is never served as video');

  const bogusRoute = await fetch(`${BASE}/demo-cctv/route_z/CCTV-A01.mp4`, {
    signal: AbortSignal.timeout(10000),
  });
  assert.notEqual(bogusRoute.headers.get('content-type'), 'video/mp4', 'unknown route folders are not served as video');
});

test('Step 4: the 9 demo-CCTV clips are never copied into dist (they stream from data/demo_cctv)', { skip: !hasBuild }, async () => {
  if (bootError) throw bootError;
  const videos = [];
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      if (/^CCTV-[A-Z]\d{2}\.mp4$/.test(e.name) || /[\\/]demo_cctv[\\/]/.test(full)) videos.push(full);
    });
  walk(join(ROOT, 'dist'));
  assert.deepEqual(videos, [], 'dist contains no demo-CCTV MP4 files — clips are streamed at runtime from data/demo_cctv');
});