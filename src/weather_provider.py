"""
Phase 9B - Weather Provider (location-configurable, provider-abstraction)
=========================================================================
Reads weather for an EXPLICITLY SUPPLIED (latitude, longitude).

Architecture
------------
The rest of the system talks only to the normalized interface:

    WeatherProvider() -> dict  (normalized weather reading)

A concrete provider can be swapped without touching anything else.

Provider: Open-Meteo (free, no API key) via the current-weather endpoint.
Live access requires network.  If network is unavailable and mock fallback
is enabled (config: "allow_mock_fallback": true) the call returns MOCK data
clearly flagged is_mock=True / source="mock".  Mock data is NEVER presented
as live.

LIVE vs MOCK (never mixed silently):
    * mode="live"  -> network call only; raises WeatherError on any failure.
    * mode="mock"  -> deterministic mock built from (lat, lon, timestamp).
    * mode="auto"  -> try live; on failure fall back to mock ONLY if allowed,
                      and mark is_mock=True with fallback_reason.

Environment overrides (no credentials hardcoded):
    WEATHER_API_URL  : override the live endpoint (e.g. a key-gated proxy).
    WEATHER_API_KEY  : optional key appended as &apikey=<value>.

Normalized output fields:
    source, provider, mode_requested, fallback_reason,
    latitude, longitude, timestamp,
    temperature_c, precipitation_mm, weather_code, weather_condition,
    wind_speed_kmh, visibility_km, humidity_pct, is_mock
"""

import json
import random
import urllib.request
import urllib.parse
import urllib.error
import hashlib
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config" / "weather_config.json"


class WeatherError(RuntimeError):
    """Raised when live weather cannot be fetched (or location invalid)."""


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _load_config(config_path=None):
    path = Path(config_path) if config_path else DEFAULT_CONFIG_PATH
    if not path.exists():
        raise WeatherError(f"weather config not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


class WeatherProvider:
    """Location-configurable weather provider (Open-Meteo live + deterministic mock)."""

    def __init__(self, config=None, config_path=None):
        cfg = config if config is not None else _load_config(config_path)
        self.provider_name = cfg.get("provider", "open-meteo")
        self.mode_default = cfg.get("mode", "auto")
        self.allow_mock_fallback = cfg.get("allow_mock_fallback", False)
        api = cfg.get("api", {})
        self.current_url = api.get("current_url",
                                   "https://api.open-meteo.com/v1/forecast")
        self.timeout = float(api.get("timeout_seconds", 20))
        self.env_url_override = api.get("env_url_override")
        self.env_key = api.get("env_key")

    # ── public interface ───────────────────────────────────────────────────
    def get_weather(self, latitude, longitude, timestamp=None, mode=None):
        """Return a normalized weather reading dict for a given location.

        The location MUST be supplied explicitly; nothing is inferred for any
        existing video.
        """
        validate_latlon(latitude, longitude)
        ts = timestamp or _now_iso()

        requested = mode or self.mode_default
        if requested == "live":
            return self._get_live(latitude, longitude, ts)
        if requested == "mock":
            return self._get_mock(latitude, longitude, ts)
        if requested == "auto":
            try:
                return self._get_live(latitude, longitude, ts)
            except WeatherError as exc:
                if self.allow_mock_fallback:
                    reading = self._get_mock(latitude, longitude, ts)
                    reading["fallback_reason"] = (
                        f"live fetch failed ({exc}); using deterministic mock")
                    return reading
                raise
        raise WeatherError(f"unknown mode '{requested}' (expected live/mock/auto)")

    # ── live branch (network required; never faked) ────────────────────────
    def _get_live(self, lat, lon, ts):
        url = self.current_url
        if self.env_url_override:
            url = __import__("os").environ.get(self.env_url_override, url)
        params = {
            "latitude": lat,
            "longitude": lon,
            "current": "temperature_2m,precipitation,weather_code,"
                       "wind_speed_10m,relative_humidity_2m,visibility",
            "timezone": "auto",
            "wind_speed_unit": "kmh",
            "precipitation_unit": "mm",
            "temperature_unit": "celsius",
        }
        full = url + "?" + urllib.parse.urlencode(params)
        key = __import__("os").environ.get(self.env_key) if self.env_key else None
        if key:
            full += "&apikey=" + urllib.parse.quote(key)
        try:
            req = urllib.request.Request(full,
                                         headers={"User-Agent": "phase9b-weather/1.0"})
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError,
                ConnectionError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            raise WeatherError(f"live weather unavailable: {exc}") from exc

        cur = body.get("current") or {}
        weather_code = cur.get("weather_code")
        return {
            "source": "live",
            "provider": self.provider_name,
            "mode_requested": "live",
            "fallback_reason": "",
            "latitude": float(lat),
            "longitude": float(lon),
            "timestamp": cur.get("time") or ts,
            "temperature_c": cur.get("temperature_2m"),
            "precipitation_mm": cur.get("precipitation"),
            "weather_code": weather_code,
            "weather_condition": wmo_condition(weather_code),
            "wind_speed_kmh": cur.get("wind_speed_10m"),
            "visibility_km": (cur.get("visibility") / 1000.0
                              if cur.get("visibility") is not None else None),
            "humidity_pct": cur.get("relative_humidity_2m"),
            "is_mock": False,
        }

    # ── deterministic mock branch ──────────────────────────────────────────
    def _get_mock(self, lat, lon, ts):
        # seed = pure function of (lat, lon, timestamp) -> deterministic
        seed_src = f"{float(lat):.6f}|{float(lon):.6f}|{ts}".encode("utf-8")
        seed = int.from_bytes(hashlib.sha256(seed_src).digest()[:8], "big")
        rnd = random.Random(seed)
        profile = rnd.choice(MOCK_PROFILES)
        weather_code = profile["weather_code"]

        temperature_c = round(rnd.uniform(-2.0, 38.0), 1)
        precipitation_mm = profile["precipitation_mm"]
        wind_speed_kmh = round(rnd.uniform(3.0, 55.0), 1)
        visibility_km = profile["visibility_km"]
        humidity_pct = round(rnd.uniform(30.0, 98.0), 1)

        return {
            "source": "mock",
            "provider": "mock",
            "mode_requested": "mock",
            "fallback_reason": "deterministic mock mode (no live network used)",
            "latitude": float(lat),
            "longitude": float(lon),
            "timestamp": ts,
            "temperature_c": temperature_c,
            "precipitation_mm": precipitation_mm,
            "weather_code": weather_code,
            "weather_condition": wmo_condition(weather_code),
            "wind_speed_kmh": wind_speed_kmh,
            "visibility_km": visibility_km,
            "humidity_pct": humidity_pct,
            "is_mock": True,
        }


# ============================================================
#  WMO weather-code -> textual condition mapping  (server data)
# ============================================================
WMO_TEXT = {
    0: "clear sky",
    1: "mainly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "fog",
    48: "depositing rime fog",
    51: "drizzle: light",
    53: "drizzle: moderate",
    55: "drizzle: dense",
    56: "freezing drizzle: light",
    57: "freezing drizzle: dense",
    61: "rain: slight",
    63: "rain: moderate",
    65: "rain: heavy",
    66: "freezing rain: light",
    67: "freezing rain: heavy",
    71: "snow fall: slight",
    73: "snow fall: moderate",
    75: "snow fall: heavy",
    77: "snow grains",
    80: "rain showers: slight",
    81: "rain showers: moderate",
    82: "rain showers: violent",
    85: "snow showers: slight",
    86: "snow showers: heavy",
    95: "thunderstorm: slight or moderate",
    96: "thunderstorm with slight hail",
    99: "thunderstorm with heavy hail",
}

# deterministic mock profiles (one per representative weather class)
MOCK_PROFILES = [
    {"weather_code": 0,   "precipitation_mm": 0.0, "visibility_km": 14.0},
    {"weather_code": 61,  "precipitation_mm": 2.2, "visibility_km": 8.0},
    {"weather_code": 65,  "precipitation_mm": 12.5, "visibility_km": 3.5},
    {"weather_code": 45,  "precipitation_mm": 0.0, "visibility_km": 0.4},
    {"weather_code": 3,   "precipitation_mm": 0.0, "visibility_km": 10.0},
    {"weather_code": 95,  "precipitation_mm": 8.0, "visibility_km": 2.0},
]


def wmo_condition(code):
    """Human-readable condition for a WMO weather code (None if unknown)."""
    if code is None:
        return None
    try:
        return WMO_TEXT.get(int(code))
    except (TypeError, ValueError):
        return None


def validate_latlon(latitude, longitude):
    """Raise ValueError if the location is not a valid lat/lon (explicit input)."""
    if latitude is None or longitude is None:
        raise ValueError("latitude and longitude must be supplied explicitly")
    try:
        lat = float(latitude)
        lon = float(longitude)
    except (TypeError, ValueError):
        raise ValueError("latitude/longitude must be numeric") from None
    if not (-90.0 <= lat <= 90.0):
        raise ValueError(f"latitude out of range [-90, 90]: {latitude}")
    if not (-180.0 <= lon <= 180.0):
        raise ValueError(f"longitude out of range [-180, 180]: {longitude}")


# Convenience top-level function matching the requested interface.
def get_weather(latitude, longitude, timestamp=None, mode="auto",
                config_path=None):
    provider = WeatherProvider(config_path=config_path)
    return provider.get_weather(latitude, longitude, timestamp=timestamp,
                                mode=mode)


if __name__ == "__main__":
    import sys
    if len(sys.argv) >= 3:
        print(json.dumps(get_weather(float(sys.argv[1]), float(sys.argv[2])),
                         indent=2))
    else:
        print("usage: python src/weather_provider.py <latitude> <longitude>")