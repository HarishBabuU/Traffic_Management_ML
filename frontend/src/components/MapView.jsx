/**
 * Real route map — command-centre Layer 1.
 *
 * Vanilla Leaflet wrapper (not react-leaflet) rendering EVERY OSRM alternative
 * route returned by the live provider, with the selected route emphasised and
 * clickable polylines that synchronise with the route cards.
 *
 * Honesty: only data passed in is rendered. There is no default pan/zoom
 * centre that would imply a fake location; when bounds exist we fit to them.
 * The route layer colours are a pure visual mapping to the on-page legend.
 */
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MAP_PROVIDERS } from '../services/locationProviders';
import { accuracyBand, isApproximateFix, LOCATION_PRECISION } from '../services/geolocation';

export const ROUTE_COLORS = ['#1d4ed8', '#0d9488', '#7c3aed', '#c2410c', '#be185d', '#2563eb'];

function routeColor(index) {
  return ROUTE_COLORS[index % ROUTE_COLORS.length];
}

function placeMarker(map, point, { color, label }) {
  const marker = L.circleMarker([point.lat, point.lon], {
    radius: 9,
    color: '#ffffff',
    weight: 2,
    fillColor: color,
    fillOpacity: 1,
  });
  marker.bindTooltip(label, { direction: 'top' });
  marker.addTo(map);
  return marker;
}

/**
 * Draws the browser-reported accuracy radius around the current position.
 *
 * `currentLocation.accuracy` is the 95 % confidence radius the Geolocation API
 * returned; it is drawn verbatim (never re-estimated, never offset) and stays
 * centred on the actual browser coordinates. The label always states that the
 * point inside the circle is approximate, so a coarse network fix can never be
 * read as an exact address.
 */
function accuracyCircle(map, currentLocation) {
  const accuracy = Number(currentLocation.accuracy);
  if (!Number.isFinite(accuracy) || accuracy <= 0) return null;
  const radius = accuracy;
  const circle = L.circle([currentLocation.lat, currentLocation.lon], {
    radius,
    color: '#2563eb',
    weight: 1,
    opacity: 0.6,
    fillColor: '#2563eb',
    fillOpacity: 0.12,
    interactive: false,
  });
  const band = accuracyBand(accuracy);
  const word =
    band === LOCATION_PRECISION.high
      ? 'Precise to'
      : band === LOCATION_PRECISION.fair
        ? 'Approximate, accurate to'
        : band === LOCATION_PRECISION.low
          ? 'Approximate, only accurate to'
          : 'Approximate, very rough position, only accurate to';
  circle.bindTooltip(`${word} ±${Math.round(radius)} m`, { direction: 'top', sticky: true });
  circle.addTo(map);
  return circle;
}

function routeLine(map, route, color, selected, onClick) {
  const line = L.polyline(
    Array.isArray(route.geometry) && route.geometry.length >= 2
      ? route.geometry.map((p) => [p.lat, p.lon])
      : [],
    {
      color,
      weight: selected ? 8 : 5,
      opacity: selected ? 0.95 : 0.55,
      dashArray: selected ? null : '6 6',
      lineCap: 'round',
      lineJoin: 'round',
    }
  );
  line
    .bindTooltip(
      `${route.name} · ${route.distanceKm} km · ${route.durationMin} min${
        selected ? ' (selected)' : ' — click to select'
      }`,
      { direction: 'top', sticky: true }
    )
    .on('click', () => {
      if (onClick) onClick(route.id);
    });
  line.addTo(map);
  return line;
}

export default function MapView({
  origin,
  destination,
  routes,
  selectedRouteId,
  onSelectRoute,
  currentLocation = null,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef([]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;
    const map = L.map(containerRef.current, {
      center: [14.0, 78.0],
      zoom: 5,
      zoomControl: true,
    });
    L.tileLayer(MAP_PROVIDERS.tiles, {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;
    const cleanup = () => {
      map.remove();
      mapRef.current = null;
      layersRef.current = [];
    };
    return cleanup;
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    map.invalidateSize();
    layersRef.current.forEach((layer) => layer.remove());
    layersRef.current = [];

    const bounds = [];
    if (currentLocation && Number.isFinite(currentLocation.lat) && Number.isFinite(currentLocation.lon)) {
      // `lat`/`lon` are used exactly as the browser reported them — the accuracy
      // circle is centred on the same unmodified point.
      const accuracy = Number(currentLocation.accuracy);
      const hasAccuracy = Number.isFinite(accuracy) && accuracy > 0;
      const approximate = isApproximateFix(hasAccuracy ? accuracy : null);
      // The radius is drawn first so the marker stays readable on top of it.
      const circle = accuracyCircle(map, currentLocation);
      if (circle) layersRef.current.push(circle);
      layersRef.current.push(
        placeMarker(map, currentLocation, {
          color: '#2563eb',
          label: approximate
            ? hasAccuracy
              ? `My current location (approximate, ±${Math.round(accuracy)} m)`
              : 'My current location (approximate — browser reported no accuracy)'
            : `My current location (±${Math.round(accuracy)} m)`,
        })
      );
      bounds.push([currentLocation.lat, currentLocation.lon]);
      // Keep the whole uncertainty circle in view, otherwise a poor fix would
      // look like a precise pin just because the map zoomed in on it.
      if (hasAccuracy) {
        bounds.push(
          [currentLocation.lat - accuracy / 111320, currentLocation.lon],
          [currentLocation.lat + accuracy / 111320, currentLocation.lon]
        );
      }
    }
    if (origin) {
      layersRef.current.push(placeMarker(map, origin, { color: '#16a34a', label: 'Origin' }));
      bounds.push([origin.lat, origin.lon]);
    }
    if (destination) {
      layersRef.current.push(
        placeMarker(map, destination, { color: '#b91c1c', label: 'Destination' })
      );
      bounds.push([destination.lat, destination.lon]);
    }

    const list = Array.isArray(routes) ? routes : [];
    if (list.length > 0) {
      const selected = list.find((r) => r.id === selectedRouteId) || list[0];
      // Non-selected routes first; the selected route is drawn on top so it is
      // never hidden behind another line.
      const drawingOrder = [
        ...list.filter((r) => r.id !== selected.id),
        selected,
      ];
      drawingOrder.forEach((route, idx) => {
        const isSelected = route.id === selected.id;
        layersRef.current.push(
          routeLine(
            map,
            route,
            routeColor(
              isSelected ? list.length - 1 : list.findIndex((r) => r.id === route.id)
            ),
            isSelected,
            onSelectRoute
          )
        );
        if (Array.isArray(route.geometry)) {
          route.geometry.forEach((p) => bounds.push([p.lat, p.lon]));
        }
      });

      if (selected && Array.isArray(selected.geometry) && selected.geometry.length >= 2) {
        const selBounds = L.latLngBounds(
          selected.geometry.map((p) => [p.lat, p.lon])
        );
        if (bounds.length >= 2) {
          const allBounds =
            bounds.length >= 2 ? L.latLngBounds(bounds) : selBounds;
          map.fitBounds(allBounds, { padding: [48, 48], maxZoom: 15 });
        } else {
          map.fitBounds(selBounds, { padding: [48, 48], maxZoom: 15 });
        }
      } else if (bounds.length >= 2) {
        map.fitBounds(L.latLngBounds(bounds), { padding: [48, 48], maxZoom: 15 });
      }
    } else if (bounds.length >= 2) {
      map.fitBounds(L.latLngBounds(bounds), { padding: [48, 48], maxZoom: 15 });
    } else if (bounds.length === 1) {
      map.setView([bounds[0][0], bounds[0][1]], 14);
    }
    return undefined;
  }, [origin, destination, routes, selectedRouteId, onSelectRoute, currentLocation]);

  return (
    <div
      className="map-container"
      ref={containerRef}
      role="region"
      aria-label="Real route map with selectable alternative routes"
    />
  );
}