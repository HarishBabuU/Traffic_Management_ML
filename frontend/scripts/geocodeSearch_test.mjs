/**
 * Runtime UI test for the geocoding-result fix (Issue 1).
 *
 * Boots the real production bundle in jsdom with a mocked `fetch` that replays
 * a Photon payload in which the WRONG institution ("Vellore Institute of
 * Technology", Kandigai) is ranked first by the provider, then drives the real
 * search UI for "Chennai Institute of Technology Kundrathur" and asserts that:
 *
 *   1. the provider-first wrong hit is never silently selected — the resolved
 *      coordinates that reach the router belong to the matching institution;
 *   2. an ambiguous query renders the candidate list instead of picking one;
 *   3. picking a candidate re-runs the search with that locality.
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

const CIT_QUERY = 'Chennai Institute of Technology Kundrathur';
const CIT_LON = '80.1936';
const VIT_LON = '79.3392';

/** Photon ranked the Vellore campus first — the exact reported bug. */
const PHOTON_CIT_SEARCH = {
  features: [
    {
      geometry: { type: 'Point', coordinates: [79.3392, 12.9676] },
      properties: {
        name: 'Vellore Institute of Technology',
        street: 'Kandigai',
        city: 'Vellore',
        district: 'Vellore',
        state: 'Tamil Nadu',
        country: 'India',
        type: 'street',
      },
    },
    {
      geometry: { type: 'Point', coordinates: [80.1936, 12.9712] },
      properties: {
        name: 'Chennai Institute of Technology',
        street: 'Kundrathur',
        city: 'Chennai',
        district: 'Kancheepuram',
        state: 'Tamil Nadu',
        country: 'India',
        osm_value: 'university',
        type: 'other',
      },
    },
  ],
};

/** Nothing here explains the query — the UI must ask, not guess. */
function photonNothingExplains() {
  return {
    features: [
      {
        geometry: { type: 'Point', coordinates: [78.1198, 9.9252] },
        properties: { name: 'Madurai Junction', city: 'Madurai', state: 'Tamil Nadu', country: 'India' },
      },
      {
        geometry: { type: 'Point', coordinates: [78.1198, 9.9252] },
        properties: { name: 'Madurai', city: 'Madurai', state: 'Tamil Nadu', country: 'India' },
      },
    ],
  };
}

function jsonOk(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

// ---------------------------------------------------------------------------
// jsdom globals (Node cannot parse .jsx, so we boot the compiled bundle).
// ---------------------------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:4179/',
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

/** Every provider URL the app requested, in order. */
const requestedUrls = [];

/** Photon response per query text. */
let photonResponder = () => PHOTON_CIT_SEARCH;

const singlePlace = (name, lon, lat) => ({
  features: [
    { geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { name, city: name } },
  ],
});

/** Origins that resolve cleanly, so ambiguity tests stay focused. */
const ORIGIN_RESULTS = {
  Madurai: singlePlace('Madurai', 78.1198, 9.9252),
  Chennai: singlePlace('Chennai', 80.2707, 13.0827),
};

globalThis.fetch = async (url) => {
  const href = String(url);
  requestedUrls.push(href);
  if (href.includes('photon.komoot.io')) {
    const query = decodeURIComponent((href.match(/[?&]q=([^&]+)/) || [])[1] || '');
    return jsonOk(ORIGIN_RESULTS[query] || photonResponder(query));
  }
  if (href.includes('router.project-osrm.org')) {
    return jsonOk({
      code: 'Ok',
      routes: [
        {
          distance: 12000,
          duration: 1500,
          legs: [{ summary: '' }],
          geometry: {
            type: 'LineString',
            coordinates: [
              [80.19, 12.97],
              [80.11, 12.92],
            ],
          },
        },
      ],
    });
  }
  if (href.includes('open-meteo.com')) {
    return jsonOk({ current: { temperature_2m: 31, weather_code: 2, time: '2026-10-02T12:00' } });
  }
  return jsonOk({ message: 'unmocked-request' });
};

function setInputValue(selector, value) {
  const input = window.document.querySelector(selector);
  assert.ok(input, `expected input at ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

async function submitTrip(origin, destination) {
  await act(async () => {
    setInputValue('#trip-origin', origin);
    setInputValue('#trip-destination', destination);
  });
  await act(async () => {
    window.document
      .querySelector('.trip-form button[type="submit"]')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

function osrmUrls() {
  return requestedUrls.filter((u) => u.includes('router.project-osrm.org'));
}

if (!jsBundle) {
  test.skip('geocode-search runtime suite — skipped: run `npm run build` first (missing dist/assets/index-*.js)', () => {});
} else {
  const bundleUrl = pathToFileURL(join(DIST_DIR, jsBundle)).href;

  test('searching "Chennai Institute of Technology Kundrathur" does not select the provider-first VIT hit', async () => {
    photonResponder = (query) => (query === CIT_QUERY ? PHOTON_CIT_SEARCH : photonNothingExplains());
    requestedUrls.length = 0;
    await act(async () => {
      await import(bundleUrl);
    });
    await settle();

    await submitTrip('Madurai', CIT_QUERY);

    assert.equal(
      window.document.querySelectorAll('.geocode-candidate-chip').length,
      0,
      'a confident match is selected without bothering the user'
    );
    assert.equal(window.document.querySelector('.routes-error-card'), null, 'no geocoding error was raised');
    assert.equal(
      window.document.querySelectorAll('.real-route-card').length,
      1,
      'the search completed and the real route rendered'
    );

    const routed = osrmUrls();
    assert.equal(routed.length, 1, 'the router was called once');
    assert.ok(routed[0].includes(CIT_LON), 'the routed destination is the Chennai institute (Kundrathur)');
    assert.ok(!routed[0].includes(VIT_LON), 'the provider-first Vellore hit was NOT selected');
  });

  test('an unmatchable search offers the candidates instead of guessing one', async () => {
    photonResponder = (query) =>
      query === CIT_QUERY
        ? photonNothingExplains()
        : {
            features: [
              { geometry: { type: 'Point', coordinates: [78.1198, 9.9252] }, properties: { name: 'Madurai' } },
            ],
          };

    await submitTrip('Chennai', CIT_QUERY);

    const statusLine = window.document.querySelector('.trip-status-line .status-line');
    assert.ok(statusLine, 'a status line explains the ambiguity');
    assert.match(statusLine.textContent, /Several locations match/i);

    const chips = window.document.querySelectorAll('.geocode-candidate-chip');
    assert.equal(chips.length, 2, 'both candidates are offered to the user');
    assert.match(
      Array.from(chips).map((c) => c.textContent).join(' | '),
      /Madurai/,
      'each candidate shows its name and locality'
    );
    assert.equal(window.document.querySelectorAll('.real-route-card').length, 0, 'no route was generated from a guess');
  });

  test('picking a candidate re-runs the search with that locality', async () => {
    const chip = window.document.querySelector('.geocode-candidate-chip');
    assert.ok(chip, 'a candidate chip is available to click');
    const chosenText = chip.textContent;
    assert.match(chosenText, /Madurai/);

    photonResponder = (query) =>
      query.includes('Madurai Junction')
        ? {
            features: [
              {
                geometry: { type: 'Point', coordinates: [78.1198, 9.9252] },
                properties: { name: 'Madurai Junction', city: 'Madurai' },
              },
            ],
          }
        : {
            features: [
              { geometry: { type: 'Point', coordinates: [80.2707, 13.0827] }, properties: { name: 'Chennai' } },
            ],
          };

    await act(async () => {
      chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();

    assert.equal(window.document.querySelectorAll('.geocode-candidate-chip').length, 0, 'the candidate list closed');
    assert.equal(
      window.document.querySelector('#trip-destination').value,
      'Madurai Junction, Madurai, Tamil Nadu',
      'the destination now carries the chosen locality'
    );
    assert.equal(window.document.querySelectorAll('.real-route-card').length, 1, 'the refined search resolved');
  });
}