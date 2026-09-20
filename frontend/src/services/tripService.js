/**
 * Trip service — the application/service orchestration layer.
 *
 * Wraps the REAL providers (Photon geocoding + OSRM routing + Open-Meteo
 * weather) and the deterministic route-intelligence layer into one trip
 * workflow. App.jsx drives the UI from a single trip snapshot; the reasoning
 * itself always lives here / in routeIntelligence, never in a component.
 *
 *   createTripService({ locationService, weatherService, evidence })
 *     ├─ analyzeRealRoutes({ origin, destination, originCoords }) → real routes
 *     ├─ enrichRoutes({ routes, weather })                       → intelligence
 *     └─ layers()                                                → disclosure
 */

import { createLocationService } from './locationProviders.js';
import {
  composeTripIntelligence,
  describeLayers,
} from './routeIntelligence.js';

export function createTripService({
  locationService = createLocationService(),
  evidence = {},
} = {}) {
  /**
   * Real routing for a trip. `origin` is a place-name string; `originCoords` is
   * an optional pre-resolved { lat, lon, name } from the browser location that
   * bypasses geocoding (never fabricated — only a real geolocation result is
   * accepted by the caller).
   */
  async function analyzeRealRoutes({ origin, destination, originCoords = null }) {
    if (originCoords && Number.isFinite(originCoords.lat) && Number.isFinite(originCoords.lon)) {
      const destinationResolved = await locationService.geocode(destination);
      const routes = await locationService.route(originCoords, destinationResolved);
      return {
        originResolved: { name: originCoords.name || 'My current location', lat: originCoords.lat, lon: originCoords.lon },
        destinationResolved,
        routes,
      };
    }
    return locationService.analyzeTrip({ origin, destination });
  }

  /**
   * Attaches the route/segment/CCTV/traffic/road/weather-intelligence snapshot.
   */
  function enrichRoutes({ routes, weather }) {
    return composeTripIntelligence({ routes, weather, evidence });
  }

  return { analyzeRealRoutes, enrichRoutes, layers: () => describeLayers() };
}