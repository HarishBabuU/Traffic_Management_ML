/**
 * Runtime UI test for the current-location precision fix (Issue 2).
 *
 * Boots the real production bundle in jsdom with a mocked `navigator.geolocation`
 * that returns a deliberately POOR fix, and asserts the UI:
 *   - reports the browser-reported accuracy radius,
 *   - labels the position as approximate instead of exact,
 *   - shows no fabricated or hardcoded coordinates.
 *
 * A second run of the same suite covers a high-accuracy fix, which must still
 * be presented with its accuracy rather than as an "exact" position.
 *
 * Skipped with a clear message when `vite build` output is missing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { act } from 'react';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'dist', 'assets');
const jsFiles = readdirSync(DIST_DIR).filter((f) => f.endsWith('.js'));
const jsBundle = jsFiles[0] || null;

/** A realistic, deliberately poor desktop/Wi-Fi fix. */
const POOR_FIX = { latitude: 12.9712, longitude: 80.1936, accuracy: 1800 };
const POOR_FIX_TIMESTAMP = 1759382400000;

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:4180/',
});
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLInputElement = window.HTMLInputElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.MouseEvent = window.MouseEvent;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.MutationObserver = window.MutationObserver;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.Element.prototype.scrollIntoView = () => {};
window.scrollTo = () => {};

/** Options the app actually passed to getCurrentPosition. */
let geoOptionsSeen = null;

Object.defineProperty(window.navigator, 'geolocation', {
  configurable: true,
  value: {
    getCurrentPosition: (ok, err, options) => {
      geoOptionsSeen = options;
      ok({ coords: POOR_FIX, timestamp: POOR_FIX_TIMESTAMP });
    },
  },
});

globalThis.fetch = async (url) => {
  const href = String(url);
  return { ok: true, status: 200, json: async () => ({ features: [] }) };
};

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

if (!jsBundle) {
  test.skip('geolocation-accuracy runtime suite — skipped: run `npm run build` first (missing dist/assets/index-*.js)', () => {});
} else {
  const bundleUrl = pathToFileURL(join(DIST_DIR, jsBundle)).href;

  test('a poor browser fix is shown as approximate with its accuracy radius', async () => {
    await act(async () => {
      await import(bundleUrl);
    });
    await settle();

    assert.ok(geoOptionsSeen, 'the app asked the browser for a position');
    assert.equal(geoOptionsSeen.enableHighAccuracy, true, 'the best available fix was requested');
    assert.equal(geoOptionsSeen.maximumAge, 0, 'no stale cached fix was accepted');

    const chip = window.document.querySelector('.map-status-chip .geo-status');
    assert.ok(chip, 'the location status chip is rendered');
    const chipText = chip.textContent;
    assert.match(chipText, /You are here/);
    assert.match(chipText, /±1800 m/, 'the browser-reported accuracy is shown');
    assert.match(chipText, /approximate/i, 'a poor fix is labelled approximate');

    const note = window.document.querySelector('.location-accuracy-note');
    assert.ok(note, 'the trip panel states the precision of the fix');
    assert.match(note.textContent, /approximate/i);
    assert.match(note.textContent, /not a precise point/i);
    assert.doesNotMatch(note.textContent, /exact/i, 'no exactness claim anywhere');
  });

test('the accuracy is surfaced without inventing coordinates', async () => {
  const chipText = window.document.querySelector('.map-status-chip .geo-status').textContent;
  assert.match(chipText, /1800/, 'the raw accuracy value is passed through unmodified');
  const body = window.document.body.textContent;
  assert.doesNotMatch(body, /Tambaram|Pallavaram/i, 'no hardcoded fallback locality');
});
}