/**
 * Step 5C — optional external demo-video base URL.
 *
 * Verifies that VITE_DEMO_CCTV_BASE_URL is a genuinely OPTIONAL configuration:
 *
 *   1. absent/blank  -> existing local URL behaviour is byte-identical
 *   2. present       -> generated URLs point at that base
 *   3. route folder and encoded filename are preserved in both cases
 *   4. no route/camera mapping is introduced or altered
 *
 * Nothing here uploads, fetches or hosts anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');

const {
  demoCctvBaseUrl,
  demoVideoUrl,
  demoCctvVideoUrl,
  DEMO_LABEL,
  RECORDED_LABEL,
  GEO_CCTV_NOTE,
  INVESTIGATION_SOURCE_NOTE,
} = await import('../src/services/controlCenter.js');

const { ROUTE_CCTV_CONTRACT } = await import('../src/services/routeIntelligence.js');

const R2_BASE = 'https://demo-assets.example-account.r2.dev';

// The real route -> CCTV mapping that already exists in the project.
const ROUTE_CAMERAS = {
  route_a: ['CCTV-A01', 'CCTV-A02', 'CCTV-A03'],
  route_b: ['CCTV-B01', 'CCTV-B02', 'CCTV-B03'],
  route_c: ['CCTV-C01', 'CCTV-C02', 'CCTV-C03'],
};

test('Step 5C: no env var -> demoCctvBaseUrl() is undefined', () => {
  assert.equal(demoCctvBaseUrl({}), undefined);
  assert.equal(demoCctvBaseUrl(undefined), undefined);
  assert.equal(demoCctvBaseUrl(null), undefined);
});

test('Step 5C: blank / whitespace / non-string base is treated as absent', () => {
  assert.equal(demoCctvBaseUrl({ VITE_DEMO_CCTV_BASE_URL: '' }), undefined);
  assert.equal(demoCctvBaseUrl({ VITE_DEMO_CCTV_BASE_URL: '   ' }), undefined);
  assert.equal(demoCctvBaseUrl({ VITE_DEMO_CCTV_BASE_URL: 123 }), undefined);
  assert.equal(demoCctvBaseUrl({ VITE_DEMO_CCTV_BASE_URL: null }), undefined);
});

test('Step 5C: present base URL is returned, trailing slashes trimmed', () => {
  assert.equal(demoCctvBaseUrl({ VITE_DEMO_CCTV_BASE_URL: R2_BASE }), R2_BASE);
  assert.equal(
    demoCctvBaseUrl({ VITE_DEMO_CCTV_BASE_URL: `${R2_BASE}/` }),
    R2_BASE,
  );
  assert.equal(
    demoCctvBaseUrl({ VITE_DEMO_CCTV_BASE_URL: `  ${R2_BASE}//  ` }),
    R2_BASE,
  );
});

test('Step 5C: local behaviour unchanged with no base — exact previous URLs', () => {
  assert.equal(demoVideoUrl('traffic.mp4'), 'recordings/traffic.mp4');
  assert.equal(demoVideoUrl('no traffic video.mp4'), 'recordings/no%20traffic%20video.mp4');
  assert.equal(demoVideoUrl('low traffic.mp4'), 'recordings/low%20traffic.mp4');
  assert.equal(
    demoCctvVideoUrl('route_b', 'CCTV-B01.mp4'),
    '/demo-cctv/route_b/CCTV-B01.mp4',
  );
});

test('Step 5C: local behaviour identical when baseUrl is explicitly undefined', () => {
  const base = demoCctvBaseUrl({});
  assert.equal(demoVideoUrl('traffic.mp4', base), 'recordings/traffic.mp4');
  assert.equal(
    demoCctvVideoUrl('route_a', 'CCTV-A01.mp4', base),
    '/demo-cctv/route_a/CCTV-A01.mp4',
  );
});

test('Step 5C: with a base URL, generated URLs point at that base', () => {
  const base = demoCctvBaseUrl({ VITE_DEMO_CCTV_BASE_URL: R2_BASE });
  assert.equal(demoVideoUrl('traffic.mp4', base), `${R2_BASE}/recordings/traffic.mp4`);
  assert.equal(
    demoCctvVideoUrl('route_b', 'CCTV-B01.mp4', base),
    `${R2_BASE}/demo-cctv/route_b/CCTV-B01.mp4`,
  );
});

test('Step 5C: a base with a trailing slash never produces a double slash', () => {
  const base = demoCctvBaseUrl({ VITE_DEMO_CCTV_BASE_URL: `${R2_BASE}/` });
  const cctv = demoCctvVideoUrl('route_c', 'CCTV-C01.mp4', base);
  const rec = demoVideoUrl('traffic.mp4', base);
  assert.ok(!cctv.includes('r2.dev//'), `double slash in ${cctv}`);
  assert.ok(!rec.includes('r2.dev//'), `double slash in ${rec}`);
  assert.equal(cctv, `${R2_BASE}/demo-cctv/route_c/CCTV-C01.mp4`);
});

test('Step 5C: route folder and encoded filename are preserved with a base', () => {
  const base = demoCctvBaseUrl({ VITE_DEMO_CCTV_BASE_URL: R2_BASE });
  const withSpaces = demoCctvVideoUrl('route a', 'CCTV A01.mp4', base);
  assert.ok(withSpaces.startsWith(`${R2_BASE}/demo-cctv/`), withSpaces);
  assert.ok(withSpaces.endsWith('/CCTV%20A01.mp4'), withSpaces);
  assert.ok(withSpaces.includes('/route%20a/'), withSpaces);
});

test('Step 5C: every registered route/camera still resolves to its own clip', () => {
  const base = demoCctvBaseUrl({ VITE_DEMO_CCTV_BASE_URL: R2_BASE });
  for (const [routeId, cameras] of Object.entries(ROUTE_CAMERAS)) {
    for (const camera of cameras) {
      const local = demoCctvVideoUrl(routeId, `${camera}.mp4`);
      const external = demoCctvVideoUrl(routeId, `${camera}.mp4`, base);
      const expectedLocal = `/demo-cctv/${routeId}/${camera}.mp4`;
      assert.equal(local, expectedLocal);
      assert.equal(external, `${R2_BASE}${expectedLocal}`);
    }
  }
});

test('Step 5C: missing route/camera input still yields the same empty segments', () => {
assert.equal(demoCctvVideoUrl(null, null), '/demo-cctv//');
assert.equal(demoCctvVideoUrl('', ''), '/demo-cctv//');
const base = demoCctvBaseUrl({ VITE_DEMO_CCTV_BASE_URL: R2_BASE });
assert.equal(demoCctvVideoUrl(null, null, base), `${R2_BASE}/demo-cctv//`);
});

test('Step 5C: no fake route/camera mapping is introduced', () => {
  // The registry contract is untouched: 3 slots per demo route, only routes the
  // project already registers.
  assert.equal(ROUTE_CCTV_CONTRACT.slotsPerRoute, 3);
  assert.equal(ROUTE_CCTV_CONTRACT.totalSlots, 9);
  assert.match(ROUTE_CCTV_CONTRACT.note, /RECORDED DEMO/);
  assert.match(ROUTE_CCTV_CONTRACT.note, /never live/);
  assert.match(ROUTE_CCTV_CONTRACT.note, /never geographically mapped/);
  const contractText = JSON.stringify(ROUTE_CCTV_CONTRACT);
  assert.ok(!/r2\.dev|https?:\/\//.test(contractText), 'registry must stay URL-free');
  // The only routes with cameras are the three the project already defined.
  assert.deepEqual(Object.keys(ROUTE_CAMERAS).sort(), ['route_a', 'route_b', 'route_c']);
});

test('Step 5C: recorded-demo / not-live / not-geographic labels are unchanged', () => {
  // These are the project's pre-existing truthfulness labels. Step 5C must not
  // alter any of them.
  assert.equal(DEMO_LABEL, 'DEMO CCTV');
  assert.equal(RECORDED_LABEL, 'Recorded video');
  assert.match(GEO_CCTV_NOTE, /[Nn]ot yet available for these demo recordings/);
  assert.match(INVESTIGATION_SOURCE_NOTE, /NOT\s+geographically mapped/i);
  assert.match(INVESTIGATION_SOURCE_NOTE, /not live cameras/i);
});

test('Step 5C: no R2 or external host is hardcoded in controlCenter.js', () => {
  const source = fs.readFileSync(
    path.join(frontendRoot, 'src/services/controlCenter.js'),
    'utf8',
  );
  // Strip comments before scanning, so documentation may mention R2.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/r2\.dev/.test(code), 'no hardcoded R2 endpoint in code');
  assert.ok(
    !/https?:\/\/[^\s'"`]*\.(mp4|webm)/.test(code),
    'no hardcoded video URL in code',
  );
});

test('Step 5C: VITE_DEMO_CCTV_BASE_URL is read, never assigned in source', () => {
  const files = [
    'src/services/controlCenter.js',
    'src/components/CctvInvestigationSection.jsx',
    'src/components/VideoInvestigationPanel.jsx',
  ];
  for (const rel of files) {
    const source = fs.readFileSync(path.join(frontendRoot, rel), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !/VITE_DEMO_CCTV_BASE_URL\s*[:=]\s*['"`]/.test(code),
      `${rel} must not assign a hardcoded base URL`,
    );
  }
});

test('Step 5C: local .env.development is untouched and has no base URL', () => {
  const env = fs.readFileSync(path.join(frontendRoot, '.env.development'), 'utf8');
  assert.match(env, /VITE_API_BASE_URL=http:\/\/127\.0\.0\.1:8110/);
  assert.ok(
    !env.includes('VITE_DEMO_CCTV_BASE_URL'),
    '.env.development must not set a demo video base',
  );
});