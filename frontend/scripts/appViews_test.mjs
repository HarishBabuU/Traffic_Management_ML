/**
 * Focused UI/UX architecture tests for the four-view interactive trip app.
 *
 * These are RUNTIME tests: they boot the actual production bundle produced by
 * `vite build` inside jsdom with a mocked `fetch`, and drive the real React
 * application through the real workflow (analyze -> select route -> switch
 * views -> assistant commands). They prove that:
 *
 *   1. The four views are separate views (exactly one `.view` in the DOM at a
 *      time - never a stacked dashboard): MAP / HOME, CCTV, INTELLIGENCE,
 *      EVIDENCE.
 *   2. Navigation highlights the active tab and replaces the content below.
 *   3. The MAP / HOME view is the initial screen with a live map + journey box
 *      and no statistics dashboard.
 *   4. Analyzing a trip stays on MAP / HOME, shows every real OSRM route
 *      alternative, and trip + selected-route state survive view switching.
 *   5. The CCTV view shows ONLY the 3 contracted awaiting slots for the
 *      selected route (per-route placeholders, never another route's sources,
 *      never recorded clips, never coordinates).
 *   6. The INTELLIGENCE view shows compact factor cards plus the live weather,
 *      not huge tables.
 *   7. AI-assistant commands actually navigate the app (evidence /
 *      intelligence / CCTV / route / weather) and can select a route or go
 *      back to the previous view; "show CCTV for route 2" opens the CCTV view
 *      and selects route 2.
 *   8. Voice transcripts funnel through the same assistant onProcess path as
 *      typed text (source contract), and the assistant is a compact floating
 *      overlay that opens/closes.
 *   9. The EVIDENCE view keeps the protected statistics, pipeline, provenance
 *      and the recorded ML video evidence for the selected route.
 *
 * NOTE: this suite requires the production build output (dist/assets/index-*.js).
 * It is skipped with a clear message if the build output is missing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { act } from 'react';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'dist', 'assets');
const jsFiles = readdirSync(DIST_DIR).filter((f) => f.endsWith('.js'));
const jsBundle = jsFiles[0] || null;

// ---------------------------------------------------------------------------
// jsdom globals (Node cannot parse .jsx, so we boot the compiled bundle).
// ---------------------------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:4174/',
});
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', {
  value: window.navigator,
  configurable: true,
});
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

// ---------------------------------------------------------------------------
// Offline, deterministic providers: Photon / OSRM / Open-Meteo are mocked so
// the workflow runs without network and without touching real data. Both App
// services capture `fetch` at module evaluation, so the mock is installed
// BEFORE the bundle is imported.
// ---------------------------------------------------------------------------
function geocodeJson(name) {
  return {
    features: [
      {
        geometry: { coordinates: [80.1131, 12.9251] },
        properties: { name },
      },
    ],
  };
}

const ROUTE_SUMMARIES = ['Route via NH 48', 'Route via Madurai Road', 'Route via NH 38'];

function routesJson() {
  return {
    code: 'Ok',
    routes: ROUTE_SUMMARIES.map((summary, i) => ({
      legs: [{ summary }],
      distance: [10000, 12400, 9800][i],
      duration: [1200, 1440, 1150][i],
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

function weatherJson() {
  return {
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

const mockFetch = async (url) => {
  const href = String(url);
  let payload = { message: 'unmocked-request' };
  if (href.includes('photon.komoot.io')) {
    payload = geocodeJson(href.includes('q=Madurai') ? 'Madurai' : 'Chennai');
  } else if (href.includes('router.project-osrm.org')) {
    payload = routesJson();
  } else if (href.includes('open-meteo.com')) {
    payload = weatherJson();
  }
  return { ok: true, status: 200, json: async () => payload };
};

globalThis.fetch = mockFetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  ).set;
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
  return Array.from(window.document.querySelectorAll('.nav-link')).find(
    (b) => b.textContent.trim() === label
  );
}

function activeView() {
  const views = window.document.querySelectorAll('.view[data-view]');
  if (views.length === 0) return { count: 0, id: null };
  return { count: views.length, id: views[0].getAttribute('data-view') };
}

function activeNavLabel() {
  const active = window.document.querySelector('.nav-link-active');
  return active ? active.textContent.trim() : null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
if (!jsBundle) {
  test.skip('four-view runtime suite — skipped: run `npm run build` first (missing dist/assets/index-*.js)', () => {});
} else {
  const bundleUrl = pathToFileURL(join(DIST_DIR, jsBundle)).href;

  test('boots the production bundle; default MAP / HOME shows only the home view with a live map, no statistics dashboard', async () => {
    await act(async () => {
      await import(bundleUrl);
    });
    await settle();

    assert.equal(activeView().count, 1, 'exactly one view container in the DOM');
    assert.equal(activeView().id, 'home');
    assert.equal(activeNavLabel(), 'MAP / HOME');

    assert.ok(window.document.querySelector('.view[data-view="home"]'), 'home view present');
    assert.ok(!window.document.querySelector('.view[data-view="cctv"]'), 'no CCTV view stacked');
    assert.ok(!window.document.querySelector('.view[data-view="intelligence"]'), 'no intelligence view stacked');
    assert.ok(!window.document.querySelector('.view[data-view="evidence"]'), 'no evidence view stacked');

    const text = window.document.body.textContent;
    assert.ok(text.includes('Where do you want to go?'), 'journey box is the primary task');
    assert.ok(window.document.querySelector('.trip-map-frame .map-container'), 'home renders the live map');
    assert.ok(!text.includes('Total vehicles (corrected)'), 'Evidence traffic stats NOT on the home view');
    assert.ok(!text.includes('Evidence & Historical Data'), 'Evidence header NOT on the home view');
    assert.ok(!text.includes('System Pipeline'), 'pipeline NOT on the home view');
  });

  test('navigation switches exactly one view at a time and keeps the active tab highlighted', async () => {
    for (const [label, id] of [
      ['CCTV', 'cctv'],
      ['INTELLIGENCE', 'intelligence'],
      ['EVIDENCE', 'evidence'],
      ['MAP / HOME', 'home'],
    ]) {
      const button = navButton(label);
      assert.ok(button, `nav link ${label} exists`);
      await actClick(button);
      assert.equal(activeView().count, 1, `${label}: exactly one view in DOM (never stacked)`);
      assert.equal(activeView().id, id, `${label}: active view is ${id}`);
      assert.equal(activeNavLabel(), label, `${label}: nav tab highlighted`);
    }
  });

  test('complete connected workflow: analyze stays on MAP / HOME, select route, weather, view switching preserves trip + route', async () => {
    assert.equal(activeView().id, 'home');

    await act(async () => {
      setInputValue('#trip-origin', 'Chennai');
      setInputValue('#trip-destination', 'Madurai');
    });

    const analyzeButton = window.document.querySelector('.trip-form button[type="submit"]');
    assert.ok(analyzeButton, 'Analyze Route button present');
    assert.ok(!analyzeButton.disabled, 'Analyze Route enabled once destination entered');
    await actClick(analyzeButton);

    // Analyzing a trip stays on the focused MAP / HOME view (map + cards).
    assert.equal(activeView().id, 'home', 'analyze stays on MAP / HOME');

    // Real route alternatives from the (mocked) OSRM provider.
    const cards = () => window.document.querySelectorAll('.real-route-card');
    assert.equal(cards().length, 3, 'three real route alternatives rendered');
    assert.ok(
      window.document.body.textContent.includes('Route via Madurai Road'),
      'provider-derived route names shown'
    );

    // Map present.
    assert.ok(window.document.querySelector('.map-frame .map-container'), 'real map rendered');

    // First route selected by default; pick the second one.
    const secondCard = () => cards()[1];
    assert.ok(
      secondCard().querySelector('button[aria-pressed="true"]') === null,
      'second route not selected yet'
    );
    await actClick(secondCard().querySelector('.btn'));
    assert.match(
      secondCard().querySelector('button[aria-pressed="true"]').textContent,
      /Driving this route/,
      'second route is now explicitly selected'
    );

    // Weather attached to the resolved destination.
    await settle();
    assert.ok(
      window.document.body.textContent.includes('34.5'),
      'live weather temperature shown for the destination'
    );

    // Re-run the nav sweep (all four views, one at a time).
    for (const [label, id] of [
      ['CCTV', 'cctv'],
      ['INTELLIGENCE', 'intelligence'],
      ['EVIDENCE', 'evidence'],
      ['MAP / HOME', 'home'],
    ]) {
      await actClick(navButton(label));
      assert.equal(activeView().count, 1, `${label}: one view at a time`);
      assert.equal(activeView().id, id);
    }

    // Trip state survived every switch.
    assert.equal(activeView().id, 'home');
    assert.equal(
      window.document.querySelector('#trip-origin').value,
      'Chennai',
      'origin survived view switching'
    );
    assert.equal(
      window.document.querySelector('#trip-destination').value,
      'Madurai',
      'destination survived view switching'
    );

    // The SELECTED route also survived every switch (not reset by navigation).
    const second = cards()[1];
    const selectButton = second.querySelector('button[aria-pressed="true"]');
    assert.ok(selectButton, 'selected route card still shows as selected');
    assert.match(selectButton.textContent, /Driving this route/, 'route selection survived view switching');
  });

  test('CCTV view: only the recorded-demo registry sources for the selected route; switcher swaps per-route registry sets', async () => {
    // State from the workflow test: trip analyzed, Route 2 selected.
    await actClick(navButton('CCTV'));
    assert.equal(activeView().id, 'cctv');

    let cctvText = window.document.body.textContent;
    assert.ok(cctvText.includes('CCTV-B01'), 'Route 2 registry source CCTV-B01 shown');
    assert.ok(cctvText.includes('CCTV-B02'), 'Route 2 registry source CCTV-B02 shown');
    assert.ok(cctvText.includes('CCTV-B03'), 'Route 2 registry source CCTV-B03 shown');
    assert.ok(cctvText.includes('RECORDED DEMO'), 'sources are labelled RECORDED DEMO');
    assert.ok(!cctvText.includes('CCTV-A01'), 'route 1 registry sources never shown for route 2');
    assert.ok(!cctvText.includes('CCTV-C01'), 'route 3 registry sources never shown for route 2');
    assert.ok(!cctvText.includes('Awaiting Route'), 'no awaiting placeholders remain');
    assert.ok(cctvText.includes('not geographically mapped'), 'sources stay unmapped');
    assert.ok(cctvText.includes('Route via Madurai Road'), 'trip context still shows selected route');

    // Route switcher: switching to Route 3 swaps to ITS registry sources.
    const route3Btn = Array.from(window.document.querySelectorAll('.route-switcher-btn')).find(
      (b) => b.textContent.trim() === 'Route 3'
    );
    assert.ok(route3Btn, 'route switcher shows Route 1 | Route 2 | Route 3');
    await actClick(route3Btn);
    assert.ok(
      route3Btn.getAttribute('aria-pressed') === 'true',
      'Route 3 is now the selected route'
    );
    cctvText = window.document.body.textContent;
    assert.ok(cctvText.includes('CCTV-C01'), 'Route 3 registry source CCTV-C01 shown');
    assert.ok(cctvText.includes('CCTV-C03'), 'Route 3 registry source CCTV-C03 shown');
    assert.ok(!cctvText.includes('CCTV-B01'), 'route 2 registry sources gone for route 3');

    // Switch back to Route 2 for subsequent tests.
    const route2Btn = Array.from(window.document.querySelectorAll('.route-switcher-btn')).find(
      (b) => b.textContent.trim() === 'Route 2'
    );
    await actClick(route2Btn);
    assert.ok(
      window.document.body.textContent.includes('CCTV-B01'),
      'back to Route 2 registry sources'
    );
  });

  test('CCTV view: selecting a camera plays its recorded demo clip (no reload) and shows its prepared evidence', async () => {
    // State from the workflow test: trip analyzed, Route 2 selected.
    await actClick(navButton('CCTV'));
    assert.equal(activeView().id, 'cctv');

    const sourceCards = () =>
      Array.from(window.document.querySelectorAll('.cctv-source-scroll .cctv-card'));
    assert.equal(sourceCards().length, 3, 'three camera cards for Route 2');

    // Default selected camera is the first registry camera (CCTV-B01).
    const player = () => window.document.querySelector('.cctv-player-frame video');
    assert.ok(player(), 'recorded demo player rendered');
    assert.equal(
      player().getAttribute('src'),
      '/demo-cctv/route_b/CCTV-B01.mp4',
      'default player already streams the first camera clip'
    );

    // Select CCTV-B02: video + evidence follow, card keeps the selected state.
    const b02 = sourceCards().find((c) => c.querySelector('.cctv-card-id').textContent === 'CCTV-B02');
    assert.ok(b02, 'CCTV-B02 card present');
    assert.equal(b02.getAttribute('aria-pressed'), 'false', 'B02 card not selected yet');
    await actClick(b02);
    assert.equal(
      player().getAttribute('src'),
      '/demo-cctv/route_b/CCTV-B02.mp4',
      'video src changes to the recorded B02 clip without any page reload'
    );
    assert.equal(
      b02.getAttribute('aria-pressed'),
      'true',
      'selected card keeps an explicit pressed state'
    );
    const openCard = sourceCards().find((c) => c.className.includes('cctv-card-open'));
    assert.equal(
      openCard && openCard.querySelector('.cctv-card-id').textContent,
      'CCTV-B02',
      'selected card is visually highlighted'
    );

    // Evidence panel reflects the prepared B02 evidence.
    const panel = window.document.querySelector('.cctv-evidence-panel');
    assert.ok(panel, 'evidence panel present beside the player');
    const panelText = panel.textContent;
    assert.ok(panelText.includes('CCTV-B02'), 'panel shows the selected CCTV ID');
    assert.ok(panelText.includes('CCTV-B02.mp4'), 'panel shows the recorded video filename');
    assert.ok(panelText.includes('VERY HIGH'), 'activity condition formatted from VERY_HIGH');
    assert.ok(panelText.includes('45 tracks'), 'panel shows conservative track count');
    assert.ok(panelText.includes('172.634 tracks/min'), 'panel shows activity rate');
    assert.ok(panelText.includes('115.09 / 1000 frames'), 'panel shows activity index');
    assert.ok(panelText.includes('15.64 sec'), 'panel shows duration');
    assert.ok(panelText.includes('391'), 'panel shows total frames');

    // Honesty labels remain visible on the investigation view.
    const viewText = window.document.body.textContent;
    assert.ok(viewText.includes('RECORDED DEMO'), 'RECORDED DEMO badge shown');
    assert.ok(viewText.includes('NOT LIVE'), 'NOT LIVE badge shown');
    assert.ok(viewText.includes('None — not geographically mapped'), 'evidence keeps the unmapped position');

    // Selecting another camera swaps the player again (no duplicate players).
    const b01 = sourceCards().find((c) => c.querySelector('.cctv-card-id').textContent === 'CCTV-B01');
    assert.ok(b01, 'CCTV-B01 card present');
    await actClick(b01);
    assert.equal(
      player().getAttribute('src'),
      '/demo-cctv/route_b/CCTV-B01.mp4',
      'player swaps back to CCTV-B01 on selection'
    );
    assert.equal(
      window.document.querySelectorAll('.cctv-player-frame video').length,
      1,
      'a single player is reused, never duplicated'
    );
  });

  test('route intelligence recommends Route 2; Intelligence uses factor cards plus live weather', async () => {
    // State from the workflow test: trip analyzed, Route 2 selected.
    await actClick(navButton('MAP / HOME'));
    assert.equal(activeView().id, 'home');

    const recommendedCards = window.document.querySelectorAll('.real-route-card-recommended');
    assert.equal(recommendedCards.length, 1, 'exactly one recommended route card');
    const cardText = recommendedCards[0].textContent;
    assert.match(cardText, /RECOMMENDED by route intelligence/, 'recommended badge on card');
    assert.match(cardText, /Route via Madurai Road/, 'the recommended route is Route 2');

    // Decision-context recommendation line.
    assert.ok(
      window.document.body.textContent.includes('Recommended route'),
      'decision context shows the recommended route'
    );

    // Intelligence view: compact factor cards + honest layer disclosure + live weather.
    await actClick(navButton('INTELLIGENCE'));
    assert.equal(activeView().id, 'intelligence');
    assert.ok(window.document.querySelector('.factor-card-grid'), 'factor card grid present');
    assert.ok(!window.document.querySelector('.factor-table'), 'no huge factor table remains');
    const intelText = window.document.body.textContent;
    assert.ok(intelText.includes('Traffic (observed demo)'), 'traffic factor shown');
    assert.ok(intelText.includes('Weather impact (LIVE)'), 'weather factor shown');
    assert.ok(intelText.includes('CCTV (observed demo)'), 'CCTV factor card shown');
    assert.ok(intelText.includes('Provider layer disclosure'), 'layer disclosure shown');
    assert.match(intelText, /DEMO TRAFFIC INTELLIGENCE/, 'traffic layer stays DEMO-labelled');
    assert.match(intelText, /SIMULATED ROAD CONDITIONS \(DEMO\)/, 'road layer stays SIMULATED-labelled');
    assert.ok(intelText.includes('Trip Weather Context'), 'live weather section on Intelligence');
    assert.ok(intelText.includes('34.5'), 'live weather value shown on Intelligence');

    // Route-reasoning evidence reflects the SELECTED route (Route 2).
    const evidenceNode = window.document.querySelector('.route-evidence');
    assert.ok(evidenceNode, 'route reasoning block present');
    const evidenceText = evidenceNode.textContent;
    assert.match(evidenceText, /CCTV sources available:\s*3\/3/, '3 demo CCTV sources reported');
    assert.match(evidenceText, /12\.4 km · 24 min/, 'OSRM travel metrics for Route 2');
    assert.match(intelText, /Route via Madurai Road/, 'reasoning reflects the selected route');
    assert.match(evidenceText, /not geographically verified/, 'demo CCTV stays explicitly unverified');
    assert.ok(
      !evidenceText.includes('CCTV-A01') && !evidenceText.includes('CCTV-C01'),
      'route reasoning only summarises the selected route sources'
    );
  });

  test('intelligence view keeps every provider route visible with recorded-demo CCTV, simulated weather/road and the existing recommendation', async () => {
    // State from the workflow test: trip analyzed, Route 2 selected.
    await actClick(navButton('INTELLIGENCE'));
    assert.equal(activeView().id, 'intelligence');

    const summaryCards = () => window.document.querySelectorAll('.route-intel-card');
    assert.equal(summaryCards().length, 3, 'all three provider-returned routes stay visible in provider order');
    const names = Array.from(summaryCards()).map((c) => c.textContent);
    assert.ok(names.some((t) => t.includes('Route via NH 48')), 'Route 1 name visible');
    assert.ok(names.some((t) => t.includes('Route via Madurai Road')), 'Route 2 name visible');
    assert.ok(names.some((t) => t.includes('Route via NH 38')), 'Route 3 name visible');

    // Provider distance + duration shown per route (OSRM numbers, unchanged).
    assert.ok(names.some((t) => t.includes('10 km') && t.includes('20 min')), 'Route 1 provider metrics');
    assert.ok(names.some((t) => t.includes('12.4 km') && t.includes('24 min')), 'Route 2 provider metrics');
    assert.ok(names.some((t) => t.includes('9.8 km') && t.includes('19 min')), 'Route 3 provider metrics');

    // Every route gets its registered CCTV evidence (3 recorded sources).
    const withCctv = Array.from(summaryCards()).filter((c) =>
      c.textContent.includes('3 recorded CCTV sources')
    );
    assert.equal(withCctv.length, 3, 'each route reports its 3 registered recorded CCTV sources');

    const intelText = window.document.body.textContent;
    assert.ok(intelText.includes('Route weather — SIMULATED / DEMO'), 'route weather clearly labelled SIMULATED / DEMO');
    assert.ok(intelText.includes('CLEAR') && intelText.includes('CLOUDY') && intelText.includes('RAIN'), 'route weather states shown per route');
    assert.ok(intelText.includes('Road condition — SIMULATED / DEMO'), 'road condition clearly labelled SIMULATED / DEMO');
    assert.ok(summaryCards()[1].textContent.includes('GOOD'), 'Route 2 simulated road condition includes GOOD');

    // Recorded-demo CCTV wording — never live.
    assert.ok(intelText.includes('Recorded CCTV vehicle activity'), 'recorded vehicle-activity wording used');
    assert.ok(intelText.includes('VERY HIGH'), 'higher-activity routes show recorded VERY HIGH');
    assert.ok(intelText.includes('Recorded demo evidence'), 'recorded demo evidence wording used');
    assert.ok(!/LIVE CCTV|Live CCTV/i.test(intelText), 'no LIVE CCTV wording anywhere');
    assert.ok(!/LIVE congestion|Live congestion/.test(intelText), 'no live-CONGESTION claim wording');
    assert.ok(intelText.includes('Not live congestion measurement'), 'honest negation of congestion claims is shown');
    assert.ok(!/real-time congestion/i.test(intelText), 'no real-time congestion wording');

    // The recommendation comes from the EXISTING route-intelligence result.
    const recCard = Array.from(summaryCards()).find((c) =>
      c.className.includes('route-intel-card-recommended')
    );
    assert.ok(recCard, 'exactly one card is marked recommended by route intelligence');
    assert.ok(recCard.textContent.includes('Route via Madurai Road'), 'existing recommendation is Route 2');
    assert.ok(
      recCard.textContent.includes('RECOMMENDED by the existing route-intelligence assessment'),
      'recommendation card cites the existing assessment'
    );
    assert.ok(intelText.includes('Why this route is assessed this way'), 'why-this-route section present');

    // Selecting another route's card drills into ITS reasoning below.
    const card3 = Array.from(summaryCards()).find((c) => c.textContent.includes('Route via NH 38'));
    await actClick(card3);
    assert.equal(card3.getAttribute('aria-pressed'), 'true', 'Route 3 card now selected');
    assert.ok(window.document.body.textContent.includes('Route via NH 38'), 'Route 3 reasoning shown for selected route');

    // Back to Route 2 for subsequent tests.
    const card2 = Array.from(summaryCards()).find((c) => c.textContent.includes('Route via Madurai Road'));
    await actClick(card2);
    assert.equal(card2.getAttribute('aria-pressed'), 'true', 'back to Route 2');
  });

  test('AI assistant commands actually navigate the four views', async () => {
    // Open the assistant drawer (compact overlay).
    const fab = window.document.querySelector('.assistant-fab');
    assert.ok(fab, 'assistant launcher present');
    if (fab.getAttribute('aria-expanded') !== 'true') {
      await actClick(fab);
    }

    // Assistant -> Intelligence view.
    await submitAssistant('Open intelligence');
    assert.equal(activeView().id, 'intelligence', 'Open intelligence switches the view');

    // Assistant -> Evidence view.
    await submitAssistant('Show evidence');
    assert.equal(activeView().id, 'evidence', 'Show evidence switches the view');

    // Assistant -> CCTV view.
    await submitAssistant('Help me investigate CCTV');
    assert.equal(activeView().id, 'cctv', 'CCTV request switches the view');

    // Assistant -> MAP / HOME (current route context).
    await submitAssistant('Show my current route');
    assert.equal(activeView().id, 'home', 'route request opens MAP / HOME');

    // Assistant -> weather context (INTELLIGENCE view).
    await submitAssistant("What's the weather?");
    assert.equal(activeView().id, 'intelligence', 'weather request shows the live weather context');
  });

  test('assistant "Go back" returns to the previous view and "Show route 2" selects that route on MAP / HOME', async () => {
    // Deterministic stack: start from the MAP / HOME view.
    await actClick(navButton('MAP / HOME'));
    const fab = window.document.querySelector('.assistant-fab');
    if (fab.getAttribute('aria-expanded') !== 'true') await actClick(fab);

    await submitAssistant('Open intelligence');
    assert.equal(activeView().id, 'intelligence');
    await submitAssistant('Go back');
    assert.equal(activeView().id, 'home', '"Go back" returns to MAP / HOME');

    // "Show route 2" selects and navigates to MAP / HOME.
    await submitAssistant('Show route 2');
    assert.equal(activeView().id, 'home', 'route selection opens MAP / HOME');
    const cards = window.document.querySelectorAll('.real-route-card');
    assert.equal(cards.length, 3, 'all live alternatives stay listed');
    assert.ok(
      cards[1].querySelector('button[aria-pressed="true"]'),
      'route 2 is now explicitly selected'
    );
  });

  test('voice transcript routes through the same assistant onProcess path as typed text (source contract)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'components', 'AIAssistantSection.jsx'), 'utf8');
    // Recognized speech goes through the very same sendMessage -> onProcess flow as typed chat.
    assert.match(src, /onTranscript:\s*\(transcript\)\s*=>\s*\{\s*[\s\S]*?sendMessage\(transcript\)/);
    assert.match(src, /handleSubmit\b[\s\S]*?sendMessage\(input\)/);
    assert.match(src, /onProcessRef\.current\(text\)/);
    // The voice layer never parses commands itself and never duplicates app state.
    assert.doesNotMatch(src, /classifyIntent|extractTripPlaces|buildReply|OPEN_EVIDENCE|OPEN_INTELLIGENCE|SET_TRIP/);
  });

  test('assistant is a compact floating overlay that opens and closes', async () => {
    const fab = window.document.querySelector('.assistant-fab');
    const drawer = window.document.querySelector('.assistant-drawer');
    const layer = window.document.querySelector('.assistant-layer');
    assert.ok(fab && drawer && layer, 'assistant launcher + drawer present');

    await actClick(navButton('MAP / HOME'));

    // Normalise to the closed state first (an earlier test may have opened it).
    if (layer.className.includes('assistant-layer-open')) {
      const firstClose = window.document.querySelector(
        '.assistant-drawer .btn[aria-label="Close assistant"]'
      );
      await actClick(firstClose);
    }

    // Closed by default: overlay-class only, no page reflow of main content.
    assert.ok(layer.className.includes('assistant-layer-closed'), 'closed state class');
    assert.equal(fab.getAttribute('aria-expanded'), 'false');
    assert.equal(drawer.getAttribute('aria-hidden'), 'true');

    // Open.
    await actClick(fab);
    assert.ok(layer.className.includes('assistant-layer-open'), 'open state class');
    assert.equal(fab.getAttribute('aria-expanded'), 'true');
    assert.equal(drawer.getAttribute('aria-hidden'), 'false');

    // Clear close button.
    const closeButton = window.document.querySelector(
      '.assistant-drawer .btn[aria-label="Close assistant"]'
    );
    assert.ok(closeButton, 'clear close button present');
    await actClick(closeButton);
    assert.equal(fab.getAttribute('aria-expanded'), 'false');
    assert.equal(drawer.getAttribute('aria-hidden'), 'true');
  });

  test('Step 3 end-to-end: assistant controls the real workflow (map / intelligence / investigation / routes / CCTV / recommendation / why)', async () => {
    await actClick(navButton('MAP / HOME'));
    assert.equal(activeView().id, 'home');
    const fab = window.document.querySelector('.assistant-fab');
    if (fab.getAttribute('aria-expanded') !== 'true') await actClick(fab);

    // 1. Map navigation commands.
    await submitAssistant('show map');
    assert.equal(activeView().id, 'home', '"show map" opens MAP / HOME');
    await submitAssistant('go to map');
    assert.equal(activeView().id, 'home', '"go to map" stays on MAP / HOME');

    // 2. Intelligence + investigation navigation.
    await submitAssistant('show intelligence');
    assert.equal(activeView().id, 'intelligence', '"show intelligence" opens INTELLIGENCE');
    await submitAssistant('show investigation');
    assert.equal(activeView().id, 'cctv', '"show investigation" opens INVESTIGATION / CCTV');
    await submitAssistant('back to map');
    assert.equal(activeView().id, 'home', '"back to map" returns to MAP / HOME');

    // 3. Route selection: show route 1 / 3 / 2.
    const cards = () => window.document.querySelectorAll('.real-route-card');
    await submitAssistant('show route 1');
    assert.equal(activeView().id, 'home', '"show route 1" stays on MAP / HOME');
    assert.ok(cards()[0].querySelector('button[aria-pressed="true"]'), 'route 1 explicitly selected');
    await submitAssistant('show route 3');
    assert.ok(cards()[2].querySelector('button[aria-pressed="true"]'), 'route 3 explicitly selected');
    await submitAssistant('show route 2');
    assert.ok(cards()[1].querySelector('button[aria-pressed="true"]'), 'route 2 explicitly selected');

    // 4. CCTV for Route 2: Investigation view, route selected, registry cameras shown.
    await submitAssistant('show CCTV for route 2');
    assert.equal(activeView().id, 'cctv', '"show CCTV for route 2" opens the CCTV / Investigation view');
    const cctvText = window.document.body.textContent;
    assert.ok(cctvText.includes('CCTV-B01') && cctvText.includes('CCTV-B02') && cctvText.includes('CCTV-B03'),
      'route 2 registered demo CCTV sources shown (CCTV-B01/B02/B03)');
    assert.ok(!cctvText.includes('CCTV-A01') && !cctvText.includes('CCTV-C01'),
      "no other route's cameras are shown");
    assert.ok(cctvText.includes('RECORDED DEMO'), 'sources stay RECORDED DEMO');
    assert.ok(cctvText.includes('not geographically mapped'), 'sources stay unmapped');

    // 5. Back to the map.
    await submitAssistant('back to map');
    assert.equal(activeView().id, 'home', '"back to map" returns to MAP / HOME');

    // 6. Recommendation reply comes from the existing tripIntel.recommendation.
    await submitAssistant('which route is recommended?');
    assert.ok(window.document.body.textContent.includes('Route via Madurai Road'),
      'recommendation reply names the existing recommendation (Route 2)');

    // 7. "why is route 2 recommended?" uses recommendation.why + the assessment explanation.
    await submitAssistant('why is route 2 recommended?');
    const whyText = window.document.body.textContent;
    assert.ok(/Why: Preferred over/i.test(whyText), 'reply cites the data-backed why from route intelligence');
    assert.ok(whyText.includes('Selected route assessment:'), 'reply cites the selected route assessment explanation');
  });

  test('Intelligence shows the selected route and "Show statistics" opens EVIDENCE', async () => {
    // State persists from earlier tests (trip analysed). Start clean from MAP / HOME.
    await actClick(navButton('MAP / HOME'));
    assert.equal(activeView().id, 'home');

    // Select Route 2 deterministically through the assistant; every alternative
    // must stay visible (never hidden or re-ranked away).
    const fab = window.document.querySelector('.assistant-fab');
    if (fab.getAttribute('aria-expanded') !== 'true') await actClick(fab);
    await submitAssistant('Show route 2');
    assert.equal(activeView().id, 'home', 'route selection lands in MAP / HOME');
    const cards = window.document.querySelectorAll('.real-route-card');
    assert.equal(cards.length, 3, 'all three OSRM alternatives remain visible');
    assert.ok(cards[1].querySelector('button[aria-pressed="true"]'), 'route 2 explicitly selected');

    // "What is the traffic like?" opens the Intelligence view with the evidence.
    await submitAssistant('What is the traffic like?');
    assert.equal(activeView().id, 'intelligence', 'traffic question opens the Intelligence view');

    const body = window.document.body.textContent;
    const evidenceNode = window.document.querySelector('.route-evidence');
    assert.ok(evidenceNode, 'compact route intelligence block present');
    const evidenceText = evidenceNode.textContent;
    assert.match(evidenceText, /CCTV sources available:\s*3\/3/, '3 demo CCTV sources reported');
    assert.match(evidenceText, /ML evidence available:\s*3\/3/, '3/3 ML evidence available from recorded analysis');
    assert.match(body, /Route intelligence/, 'route intelligence heading present');
    assert.match(evidenceText, /Observation:/, 'route-level traffic observation shown');
    assert.match(body, /Route via Madurai Road/, 'intelligence reflects the SELECTED route');
    assert.match(evidenceText, /12\.4 km · 24 min/, 'OSRM travel metrics shown for the selected route');
    assert.match(evidenceText, /Open-Meteo reading/, 'weather stays LIVE-labelled');
    assert.match(evidenceText, /demo layer, not real roads/, 'road stays SIMULATED-labelled');
    assert.match(evidenceText, /Evidence status/, 'evidence status row present');
    assert.match(evidenceText, /not geographically verified/, 'demo CCTV association stays explicitly unverified');
    assert.ok(
      !evidenceText.includes('CCTV-A01') && !evidenceText.includes('CCTV-C01'),
      'the route intelligence block only summarises the selected route sources'
    );

    // "Show statistics" opens the EVIDENCE view with stats + recorded ML video evidence.
    await submitAssistant('Show statistics');
    assert.equal(activeView().id, 'evidence', '"Show statistics" opens EVIDENCE');
    const evidenceBody = window.document.body.textContent;
    assert.ok(evidenceBody.includes('Evidence & Historical Data'), 'evidence header shown');
    assert.ok(evidenceBody.includes('AI Pipeline'), 'pipeline shown');
    assert.ok(evidenceBody.includes('Recorded ML video evidence'), 'recorded ML evidence section shown');
    assert.ok(evidenceBody.includes('CCTV-B01'), 'route 2 recorded registry sources available as ML evidence');
    assert.ok(!evidenceBody.includes('CCTV-A01') && !evidenceBody.includes('CCTV-C01'), 'evidence lists only the selected route sources');
    assert.ok(!evidenceBody.includes('Awaiting Route 2 CCTV'), 'no awaiting-placeholder text in evidence');
    assert.ok(evidenceBody.includes('not on this route'), 'recorded clips stay explicitly unmapped to the route');
    assert.ok(evidenceBody.includes('Data / Status'), 'data footer shown on evidence');
  });

  test('Step 5: home status chip states layer truth, strip carries compact RECOMMENDED pill, and EVIDENCE is a tabbed workspace', async () => {
    await actClick(navButton('MAP / HOME'));
    assert.equal(activeView().id, 'home');

    // Home map status chip reports analysis, but every layer is labelled honestly.
    const chip = window.document.querySelector('.map-status-chip');
    assert.ok(chip, 'map status chip on MAP / HOME');
    const chipText = chip.textContent;
    assert.ok(chipText.includes('ROUTE ANALYSIS READY'), 'chip reports route analysis state');
    assert.ok(chipText.includes('Routing LIVE'), 'routing layer keeps the LIVE label');
    assert.ok(chipText.includes('CCTV recorded · demo'), 'CCTV is labelled recorded demo, never LIVE');
    assert.ok(!/LIVE CCTV/i.test(chipText), 'no LIVE CCTV claim on the command surface');

    // Compact trip summary strip appears after the trip is analysed.
    const summary = window.document.querySelector('.trip-summary-chip');
    assert.ok(summary, 'compact trip summary strip present after analysis');
    assert.ok(summary.textContent.includes('ANALYSIS READY'), 'trip summary states analysis ready');

    // Compact RECOMMENDED pill appears in the route strip without inventing a new route.
    const pill = window.document.querySelector('.recommended-mini-pill');
    assert.ok(pill, 'compact RECOMMENDED pill in route strip');
    assert.ok(pill.textContent.includes('Route via Madurai Road'), 'pill names the existing recommendation');

    // EVIDENCE is a tabbed workspace: default ML RESULTS visible, others hidden but in the DOM.
    await actClick(navButton('EVIDENCE'));
    assert.equal(activeView().id, 'evidence');
    const tabs = Array.from(window.document.querySelectorAll('.evidence-tab'));
    assert.deepEqual(
      tabs.map((t) => t.textContent.trim()),
      ['ML RESULTS', 'TRAJECTORIES', 'VALIDATION', 'PIPELINE', 'PROVENANCE'],
      'evidence workspace tab list'
    );
    const activeTab = window.document.querySelector('.evidence-tab-active');
    assert.ok(activeTab && activeTab.textContent.trim() === 'ML RESULTS', 'default tab is ML RESULTS');
    const mlPanel = window.document.querySelector('[data-evidence-panel="ml"]');
    const trajPanel = window.document.querySelector('[data-evidence-panel="trajectories"]');
    assert.ok(mlPanel && !mlPanel.hasAttribute('hidden'), 'ML RESULTS panel visible by default');
    assert.ok(trajPanel && trajPanel.hasAttribute('hidden'), 'TRAJECTORIES panel hidden until requested');

    await actClick(
      Array.from(window.document.querySelectorAll('.evidence-tab')).find(
        (b) => b.textContent.trim() === 'TRAJECTORIES'
      )
    );
    assert.equal(window.document.querySelector('.evidence-tab-active').textContent.trim(), 'TRAJECTORIES', 'tab click switches workspace');
    assert.equal(trajPanel.hasAttribute('hidden'), false, 'TRAJECTORIES panel now visible');
    assert.equal(mlPanel.hasAttribute('hidden'), true, 'ML RESULTS panel hides once another tab is chosen');
    assert.ok(window.document.body.textContent.includes('Recorded ML video evidence'), 'recorded evidence remains for the selected route');
  });
}