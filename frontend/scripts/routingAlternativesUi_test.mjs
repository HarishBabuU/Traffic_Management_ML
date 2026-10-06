/**
 * Runtime UI tests for route alternatives (Issue 2).
 *
 * Boots the real production bundle in jsdom with a mocked OSRM provider whose
 * route count is controlled by the test, then drives the real workflow:
 *
 *   - 1 route  -> exactly one card, an honest single-route note, no padding;
 *   - 2 routes -> both cards rendered and individually selectable;
 *   - 3+ routes-> every card rendered and individually selectable;
 *   - regression: clicking "Driving this route" collapses the route panel, and
 *     the map status chip control brings the FULL list back, so no returned
 *     route ever becomes unreachable.
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

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:4191/',
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

/** Number of routes the mocked OSRM provider returns; set per test. */
let providerRouteCount = 3;
/** Every OSRM URL the app requested, to prove alternatives=true is sent. */
const osrmUrls = [];

const SUMMARIES = [
  'Route via NH 48',
  'Route via Madurai Road',
  'Route via NH 38',
  'Route via Poonamallee Road',
  'Route via Velachery Link',
];

function routesJson() {
  return {
    code: 'Ok',
    routes: Array.from({ length: providerRouteCount }, (_, i) => ({
      legs: [{ summary: SUMMARIES[i % SUMMARIES.length] }],
      distance: 100000 + i * 9000,
      duration: 6000 + i * 600,
      geometry: {
        coordinates: [
          [80.11, 12.92],
          [80.15 + i * 0.01, 12.95],
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
    payload = {
      features: [
        {
          geometry: { coordinates: [80.1131, 12.9251] },
          properties: {
            name: href.includes('q=Madurai') ? 'Madurai' : 'Chennai',
            city: href.includes('q=Madurai') ? 'Madurai' : 'Chennai',
            country: 'India',
          },
        },
      ],
    };
  } else if (href.includes('router.project-osrm.org')) {
    osrmUrls.push(href);
    payload = routesJson();
  } else if (href.includes('open-meteo.com')) {
    payload = {
      current: {
        temperature_2m: 31.5,
        relative_humidity_2m: 60,
        weather_code: 1,
        precipitation: 0,
        wind_speed_10m: 5.5,
        wind_direction_10m: 180,
        time: '2026-09-18T12:00',
      },
    };
  }
  return { ok: true, status: 200, json: async () => payload };
};

globalThis.fetch = mockFetch;

function click(element) {
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

async function actClick(element) {
  await act(async () => {
    click(element);
  });
  await settle();
}

function setInputValue(selector, value) {
  const input = window.document.querySelector(selector);
  assert.ok(input, `expected input at ${selector}`);
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

/** Runs a fresh trip analysis with the provider returning `count` routes. */
async function analyzeWithRouteCount(count) {
  providerRouteCount = count;
  await act(async () => {
    setInputValue('#trip-origin', 'Chennai');
    setInputValue('#trip-destination', 'Madurai');
  });
  const button = window.document.querySelector('.trip-form button[type="submit"]');
  assert.ok(button, 'Analyze Route button present');
  await actClick(button);
}

function cards() {
  return Array.from(window.document.querySelectorAll('.real-route-card'));
}

function stripHidden() {
  const strip = window.document.querySelector('.routes-strip');
  return strip ? strip.hasAttribute('hidden') : null;
}

function panelToggle() {
  return window.document.querySelector('[data-route-panel-toggle]');
}

/** Clicks a card's "Driving this route" control. */
async function driveCard(index) {
  const card = cards()[index];
  assert.ok(card, `route card ${index + 1} exists`);
  const button = card.querySelector('.btn');
  assert.ok(button, `route card ${index + 1} has a drive button`);
  await actClick(button);
}

if (!jsBundle) {
  test.skip('routing-alternatives runtime suite — skipped: run `npm run build` first (missing dist/assets/index-*.js)', () => {});
} else {
  const bundleUrl = pathToFileURL(join(DIST_DIR, jsBundle)).href;

  test('boots and asks OSRM for alternatives', async () => {
    await act(async () => {
      await import(bundleUrl);
    });
    await settle();
    await analyzeWithRouteCount(3);

    assert.ok(osrmUrls.length > 0, 'the app called the routing provider');
    for (const url of osrmUrls) {
      assert.match(url, /alternatives=true/, 'alternatives requested on every call');
      assert.match(url, /geometries=geojson/, 'real geometry requested');
    }
    assert.equal(cards().length, 3, 'three provider routes rendered');
  });

  test('every returned route is rendered, and driving one never removes the others', async () => {
    await analyzeWithRouteCount(4);
    assert.equal(cards().length, 4, 'all four provider routes are rendered');

    const names = cards().map((c) => c.textContent);
    for (const summary of SUMMARIES.slice(0, 4)) {
      assert.ok(
        names.some((text) => text.includes(summary)),
        `"${summary}" is present in the route list`
      );
    }

    // Each route is individually selectable and the selection is explicit.
    for (const index of [1, 2, 3, 0]) {
      await driveCard(index);
      const card = cards()[index];
      assert.ok(
        card.querySelector('button[aria-pressed="true"]'),
        `route ${index + 1} is explicitly selected after clicking it`
      );
      assert.equal(cards().length, 4, 'selecting a route never drops another one');
    }
  });

  test('collapsing the panel after driving still leaves every route reachable', async () => {
    await analyzeWithRouteCount(3);
    assert.equal(stripHidden(), false, 'the route panel starts open');

    await driveCard(0);
    assert.equal(stripHidden(), true, 'driving the route collapses the panel to show the map');
    assert.equal(cards().length, 3, 'no route is removed from state while collapsed');

    // The regression guard: the collapsed panel is not a dead end.
    const toggle = panelToggle();
    assert.ok(toggle, 'a route panel control is present while collapsed');
    assert.equal(toggle.getAttribute('data-route-panel-toggle'), 'collapsed');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'collapsed state is announced');
    assert.match(toggle.textContent, /3 OSRM alternatives/);

    await actClick(toggle);
    assert.equal(stripHidden(), false, 'the panel can be reopened');
    assert.equal(panelToggle().getAttribute('data-route-panel-toggle'), 'open');
    assert.equal(cards().length, 3, 'all three routes are back and selectable');

    // And an alternative can still be chosen after the panel was collapsed.
    await driveCard(2);
    assert.equal(stripHidden(), true, 'driving another route collapses the panel again');
    assert.ok(
      cards()[2].querySelector('button[aria-pressed="true"]'),
      'route 3 is selectable after the panel was collapsed and reopened'
    );

    // The control toggles in both directions, so the panel is never a dead end.
    await actClick(panelToggle());
    assert.equal(stripHidden(), false, 'the control reopens the panel');
    await actClick(panelToggle());
    assert.equal(stripHidden(), true, 'the control collapses the panel again');
    await actClick(panelToggle());
    assert.equal(stripHidden(), false, 'and reopens it again');
  });

  test('a two-route response renders exactly two selectable routes', async () => {
    await analyzeWithRouteCount(2);
    assert.equal(cards().length, 2, 'both provider routes are rendered');
    assert.match(
      window.document.querySelector('.route-provider-count').textContent,
      /2 routes returned by provider/
    );
    await driveCard(1);
    assert.ok(cards()[1].querySelector('button[aria-pressed="true"]'), 'route 2 selectable');
    assert.equal(cards().length, 2, 'route 1 is still listed');
  });

  test('a single-route response renders one route and is disclosed honestly', async () => {
    await analyzeWithRouteCount(1);
    assert.equal(cards().length, 1, 'exactly one card — nothing is invented to fill the list');

    const note = window.document.querySelector('.route-single-note');
    assert.ok(note, 'the single-route case is explained to the user');
    assert.match(note.textContent, /returned 1 route/i);
    assert.match(note.textContent, /no alternative path was available/i);
    assert.match(
      window.document.querySelector('.route-provider-count').textContent,
      /1 route returned by provider/
    );
    assert.match(panelToggle().textContent, /1 OSRM alternative\b/);

    // The app still works with a single route.
    await driveCard(0);
    assert.ok(cards()[0].querySelector('button[aria-pressed="true"]'), 'the route is selectable');
  });

  test('five provider routes all stay visible and individually selectable', async () => {
    await analyzeWithRouteCount(5);
    assert.equal(cards().length, 5, 'all five provider routes are rendered');
    for (const index of [4, 0, 2]) {
      await driveCard(index);
      assert.ok(
        cards()[index].querySelector('button[aria-pressed="true"]'),
        `route ${index + 1} is selectable`
      );
      assert.equal(cards().length, 5, 'the full list is never truncated');
    }
  });

  test('the route panel is visible and usable with the assistant open', async () => {
    await analyzeWithRouteCount(3);
    // Reopen the panel so we are testing a visible panel, not a collapsed one.
    if (stripHidden()) await actClick(panelToggle());
    assert.equal(stripHidden(), false, 'route panel is visible after a destination search');

    // Open the assistant the way a user does, via its launcher button.
    const fab = window.document.querySelector('.assistant-fab');
    assert.ok(fab, 'the assistant launcher still exists — the feature is kept');
    await actClick(fab);

    const layer = window.document.querySelector('.assistant-layer');
    assert.ok(layer, 'the assistant layer is rendered');
    assert.match(layer.className, /assistant-layer-open/, 'the assistant is open');

    // Route selection must remain usable while the assistant is open.
    assert.equal(stripHidden(), false, 'the route panel is still visible with the assistant open');
    assert.equal(cards().length, 3, 'all provider routes remain present');
    await driveCard(1);
    assert.ok(
      cards()[1].querySelector('button[aria-pressed="true"]'),
      'a route can still be selected while the assistant is open'
    );

    // Closing the assistant returns the strip to its normal inset.
    await actClick(window.document.querySelector('.assistant-close-btn'));
    assert.match(
      window.document.querySelector('.assistant-layer').className,
      /assistant-layer-closed/,
      'the assistant can be closed'
    );
  });

  test('no temporary diagnostics panel or debug overlay is rendered', async () => {
    await analyzeWithRouteCount(3);
    const html = window.document.body.innerHTML;
    for (const marker of [
      'dev-diagnostics',
      'DEV DIAGNOSTICS',
      'devdiag',
      'RAW BROWSER',
      'OSRM REQUEST',
      'ROUTES (provider',
    ]) {
      assert.ok(!html.includes(marker), `no "${marker}" diagnostic markup in the DOM`);
    }
    assert.equal(window.document.querySelector('.devdiag'), null, 'no diagnostics panel element');
    assert.equal(
      window.document.querySelector('[data-testid="dev-diagnostics"]'),
      null,
      'no diagnostics test hook'
    );
    // The real feature must still be there.
    assert.ok(window.document.querySelector('.assistant-fab'), 'the AI assistant is still present');
    assert.ok(cards().length > 0, 'route cards are still rendered');
  });
}
