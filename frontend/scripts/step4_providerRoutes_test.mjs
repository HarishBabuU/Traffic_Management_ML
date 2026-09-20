/**
 * Step 4 | provider-route count independence (runtime).
 *
 * Boots the real production bundle in jsdom against a mocked OSRM provider that
 * returns FOUR routes. Proves the Chennai → Madurai demo never assumes exactly
 * three routes:
 *
 *   1. Every route the provider actually returns is rendered, in provider order.
 *   2. Reality: exactly {provider count} real-route cards — never 3 hardcoded.
 *   3. A route beyond the registered demo CCTV registry (Route 4 → route_d)
 *      shows the honest empty state — never fabricated cameras.
 *   4. The assistant handles route numbers beyond 3 through the same parser.
 *   5. The source tree contains no assistant-side scoring and no fake
 *      LIVE/geographic CCTV claims.
 *
 * NOTE: requires the production build output (dist/assets/index-*.js). It is
 * skipped with a clear message if the build output is missing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { act } from 'react';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST_DIR = join(ROOT, 'dist', 'assets');
let jsBundle = null;
try {
  const jsFiles = readdirSync(DIST_DIR).filter((f) => f.endsWith('.js'));
  jsBundle = jsFiles[0] || null;
} catch {
  jsBundle = null;
}

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:4174/',
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

function geocodeJson(name) {
  return {
    features: [{ geometry: { coordinates: [80.11, 12.92] }, properties: { name } }],
  };
}

// Four routes — deliberately more than the 3 registered demo CCTV routes.
const ROUTE_NAMES = ['Route via NH 48', 'Route via Madurai Road', 'Route via NH 38', 'Route via NH 32'];
const DISTS = [10000, 12400, 9800, 11000];
const DURATIONS = [1200, 1440, 1150, 1310];

function routesJson() {
  return {
    code: 'Ok',
    routes: ROUTE_NAMES.map((summary, i) => ({
      legs: [{ summary }],
      distance: DISTS[i],
      duration: DURATIONS[i],
      geometry: {
        coordinates: [
          [80.11, 12.92],
          [80.15, 12.95],
          [80.17, 12.99],
        ],
      },
    })),
  };
}

const mockFetch = async (url) => {
  const href = String(url);
  let payload = { message: 'unmocked-request' };
  if (href.includes('photon.komoot.io')) {
    payload = geocodeJson(href.includes('q=Madurai') ? 'Madurai' : 'Chennai');
  } else if (href.includes('router.project-osrm.org')) {
    payload = routesJson();
  } else if (href.includes('open-meteo.com')) {
    payload = {
      current: {
        temperature_2m: 34.5,
        relative_humidity_2m: 49,
        weather_code: 1,
        precipitation: 0,
        wind_speed_10m: 6.6,
        wind_direction_10m: 193,
        time: '2026-09-18T12:00',
      },
    };
  }
  return { ok: true, status: 200, json: async () => payload };
};

globalThis.fetch = mockFetch;

function click(el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

async function actClick(el) {
  await act(async () => {
    click(el);
  });
  await settle();
}

function setInputValue(selector, value) {
  const input = window.document.querySelector(selector);
  assert.ok(input, `expected input at ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

async function submitAssistant(text) {
  setInputValue('#assistant-input', text);
  const form = window.document.querySelector('.assistant-input-row');
  assert.ok(form, 'assistant input form present');
  await act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}

function navButton(label) {
  return Array.from(window.document.querySelectorAll('.nav-link')).find((b) => b.textContent.trim() === label);
}

function activeView() {
  const views = window.document.querySelectorAll('.view[data-view]');
  return { count: views.length, id: views[0] ? views[0].getAttribute('data-view') : null };
}

function openAssistant() {
  const fab = window.document.querySelector('.assistant-fab');
  assert.ok(fab, 'assistant launcher present');
  if (fab.getAttribute('aria-expanded') !== 'true') return actClick(fab);
  return Promise.resolve();
}

if (!jsBundle) {
  test.skip('Step 4 provider-route-count runtime suite — skipped: run `npm run build` first (missing dist/assets/index-*.js)', () => {});
} else {
  const bundleUrl = pathToFileURL(join(DIST_DIR, jsBundle)).href;

  test('Step 4: a 4-route OSRM response renders exactly 4 routes in provider order, never 3', async () => {
    await act(async () => {
      await import(bundleUrl);
    });
    await settle();

    await act(async () => {
      setInputValue('#trip-origin', 'Chennai');
      setInputValue('#trip-destination', 'Madurai');
    });
    const analyzeButton = window.document.querySelector('.trip-form button[type="submit"]');
    assert.ok(analyzeButton, 'Analyze Route button present');
    await actClick(analyzeButton);
    assert.equal(activeView().id, 'home', 'analyze stays on MAP / HOME');

    const cards = () => window.document.querySelectorAll('.real-route-card');
    assert.equal(cards().length, 4, 'exactly as many cards as the provider returned (4), never a hardcoded 3');

    const names = Array.from(cards()).map((c) => c.textContent);
    assert.deepEqual(
      ROUTE_NAMES.map((n) => names.some((t) => t.includes(n))),
      [true, true, true, true],
      'all four provider-returned routes are shown'
    );
    const renderedNames = names
      .map((t) => ROUTE_NAMES.find((n) => t.includes(n)))
      .filter(Boolean);
    assert.deepEqual(renderedNames.slice(0, 4), ROUTE_NAMES, 'cards keep the exact provider order');

    assert.ok(names.some((t) => t.includes('11 km') && t.includes('22 min')), 'Route 4 provider metrics shown');
  });

  test('Step 4: assistant selects route numbers beyond 3 through the same parser', async () => {
    await actClick(navButton('MAP / HOME'));
    await openAssistant();
    await submitAssistant('show route 4');
    const cards = window.document.querySelectorAll('.real-route-card');
    assert.equal(cards.length, 4, 'all four alternatives still listed');
    assert.ok(cards[3].querySelector('button[aria-pressed="true"]'), 'route 4 explicitly selected via the assistant');
  });

  test('Step 4: a route beyond the CCTV registry shows the honest empty state (Route 4), Route 2 keeps its registry', async () => {
    // Select Route 4 and look at its CCTV registry.
    const card4 = () => window.document.querySelectorAll('.real-route-card')[3];
    await actClick(card4().querySelector('.btn'));
    await settle();

    const fab = window.document.querySelector('.assistant-fab');
    if (fab.getAttribute('aria-expanded') !== 'true') await actClick(fab);
    await submitAssistant('show CCTV');
    assert.equal(activeView().id, 'cctv', 'CCTV view opens');

    let cctvText = window.document.body.textContent;
    assert.ok(
      /no recorded-demo CCTV registered/i.test(cctvText) && /no fabricated cameras/i.test(cctvText),
      'Route 4 shows the honest empty state for a route outside the registry'
    );
    assert.ok(!cctvText.includes('CCTV-A01') && !cctvText.includes('CCTV-B01') && !cctvText.includes('CCTV-C01'),
      'no cameras are invented for the unregistered route');

    // Route 2 still shows its registered cameras (switch via the assistant —
    // the empty-state panel intentionally hides the switcher for an unregistered route).
    await submitAssistant('show CCTV for route 2');
    assert.equal(activeView().id, 'cctv', 'CCTV view stays open for Route 2');
    cctvText = window.document.body.textContent;
    assert.ok(cctvText.includes('CCTV-B01') && cctvText.includes('CCTV-B02') && cctvText.includes('CCTV-B03'),
      'Route 2 retains the registered CCTV-B01/B02/B03 sources');
    assert.ok(!cctvText.includes('CCTV-A01') && !cctvText.includes('CCTV-C01'),
      "no other route's cameras leak into Route 2");

    // The switcher lists all four provider routes (never a hardcoded 3).
    const switchBtns = Array.from(window.document.querySelectorAll('.route-switcher-btn'));
    assert.equal(switchBtns.length, 4, 'route switcher lists the actual 4 provider routes');
  });

  test('Step 4: source tree has no assistant-side scoring and no fake LIVE/geographic CCTV claims', () => {
    const { readdirSync: rd, readFileSync: rf } = require_node_fs();
    const servicesDir = join(ROOT, 'src', 'services');
    const offenders = [];
    for (const f of rd(servicesDir).filter((n) => n.endsWith('.js'))) {
      if (f === 'routeIntelligence.js') continue;
      const src = rf(join(servicesDir, f), 'utf-8');
      if (/rankRoutes\s*\(|assessRoute\s*\(|ROUTE_WEIGHTS|TRAFFIC_LEVEL_SCORES|ROAD_SCORES|WEATHER_IMPACT_SCORES/.test(src)) {
        offenders.push(`scoring marker in ${f}`);
      }
    }
    assert.deepEqual(offenders, [], 'no scoring markers exist outside routeIntelligence.js');

    const componentsDir = join(ROOT, 'src', 'components');
    const claims = [];
    for (const f of rd(componentsDir).filter((n) => n.endsWith('.jsx'))) {
      const src = rf(join(componentsDir, f), 'utf-8');
      if (/\bLIVE CCTV\b|\bLive CCTV\b/.test(src)) claims.push(`LIVE CCTV claim in ${f}`);
      if (/collaborators/.test(src)) claims.push(`geographic claim in ${f}`);
    }
    assert.deepEqual(claims, [], 'no fake LIVE CCTV claims in components');
  });
}

// Local helper so the source-scan test keeps the node:fs import list tidy.
function require_node_fs() {
  return { readdirSync, readFileSync };
}