"""
Phase 9B - Weather Module Tests (10 required scenarios)
========================================================
Run:
    python src/test_phase9b_weather.py

Or via the engine:
    python src/weather_impact_engine.py --test

Exit code 0 = all tests passed; 1 = at least one failed.
No network is required; live-failure tests use an unreachable endpoint.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from weather_provider import WeatherProvider, WeatherError, validate_latlon
from weather_impact_engine import (classify_category, classify_impact,
                                   render_impact_reason)


def mock_provider(**kwargs):
    cfg = {
        "provider": "open-meteo",
        "mode": "mock",
        "allow_mock_fallback": False,
        "api": {
            "current_url": kwargs.get(
                "url",
                "https://127.0.0.1:9/unreachable"),  # guaranteed dead endpoint
            "timeout_seconds": 2,
        },
    }
    return WeatherProvider(config=cfg)


def test_valid_coordinates():
    p = mock_provider()
    w = p.get_weather(13.0827, 80.2707, timestamp="2026-01-01T12:00:00+00:00")
    assert w["is_mock"] is True
    assert w["source"] == "mock"
    assert -90 <= w["latitude"] <= 90 and -180 <= w["longitude"] <= 180
    assert w["weather_code"] is not None
    assert w["temperature_c"] is not None
    return True


def test_invalid_latitude():
    for bad in (91.0, -91.0):
        try:
            validate_latlon(bad, 0.0)
            return False
        except ValueError:
            pass
    return True


def test_invalid_longitude():
    for bad in (181.0, -181.0):
        try:
            validate_latlon(0.0, bad)
            return False
        except ValueError:
            pass
    return True


def test_missing_location():
    for args in [(None, 0.0), (0.0, None), (None, None)]:
        try:
            validate_latlon(*args)
            return False
        except ValueError:
            pass
    return True


def test_api_network_failure():
    # mode="live" against a dead endpoint must RAISE, never fake live data
    p = mock_provider()
    try:
        p.get_weather(13.08, 80.27, timestamp="2026-01-01T12:00:00+00:00",
                      mode="live")
        return False
    except WeatherError:
        return True


def test_mock_mode():
    w = mock_provider().get_weather(10.0, 20.0,
                                    timestamp="2026-01-01T12:00:00+00:00")
    assert w["is_mock"] is True and w["source"] == "mock"
    assert w["provider"] == "mock"
    assert "fallback_reason" in w
    return True


def test_weather_classification():
    expect = {
        0: "CLEAR", 2: "CLEAR", 45: "FOG", 61: "LIGHT_RAIN",
        65: "HEAVY_RAIN", 81: "LIGHT_RAIN", 82: "HEAVY_RAIN",
        95: "STORM", 3: "OTHER", None: "OTHER", "abc": "OTHER",
    }
    for code, cat in expect.items():
        assert classify_category(code) == cat, (code, classify_category(code))
    return True


def test_impact_classification():
    # heavy rain + gale + near-zero visibility -> HIGH
    imp, score, _ = classify_impact(65, precipitation_mm=12.0,
                                    wind_speed_kmh=65, visibility_km=0.1)
    assert imp == "HIGH" and score >= 4
    # clear + calm -> LOW
    imp2, score2, _ = classify_impact(0, precipitation_mm=0.0,
                                      wind_speed_kmh=5, visibility_km=12.0)
    assert imp2 == "LOW" and score2 < 2
    # moderate: light rain + moderate vis
    imp3, _, _ = classify_impact(61, precipitation_mm=2.0,
                                 wind_speed_kmh=20, visibility_km=4.0)
    assert imp3 in ("LOW", "MODERATE", "HIGH")
    assert imp3 == "MODERATE"
    return True


def test_missing_optional_fields():
    # no wind / no visibility / no precipitation -> must not crash
    imp, score, _ = classify_impact(45, precipitation_mm=None,
                                    wind_speed_kmh=None, visibility_km=None)
    assert imp in ("LOW", "MODERATE", "HIGH")
    # FOG with missing optional fields still gives >=2 (visibility default worst)
    assert score >= 2
    return True


def test_deterministic_mock():
    p = mock_provider()
    ts = "2026-01-01T12:00:00+00:00"
    a = p.get_weather(13.0827, 80.2707, timestamp=ts)
    b = p.get_weather(13.0827, 80.2707, timestamp=ts)
    assert a == b, "mock must be deterministic for identical inputs"
    c = p.get_weather(13.0827, 80.2707, timestamp="2026-01-02T12:00:00+00:00")
    assert a != c, "different timestamp should give different (deterministic) output"
    return True


ALL_TESTS = [
    ("valid coordinates", test_valid_coordinates),
    ("invalid latitude", test_invalid_latitude),
    ("invalid longitude", test_invalid_longitude),
    ("missing location", test_missing_location),
    ("api/network failure", test_api_network_failure),
    ("mock/test mode", test_mock_mode),
    ("weather classification", test_weather_classification),
    ("weather impact classification", test_impact_classification),
    ("missing optional weather fields", test_missing_optional_fields),
    ("deterministic mock behavior", test_deterministic_mock),
]


def run_all():
    passed = 0
    print("=" * 60)
    print("  PHASE 9B WEATHER MODULE TESTS")
    print("=" * 60)
    for name, fn in ALL_TESTS:
        try:
            ok = fn()
        except Exception as exc:  # noqa: BLE001 - report any failure
            ok, exc = False, repr(exc)
        if ok is True:
            passed += 1
            print(f"  PASS  {name}")
        else:
            print(f"  FAIL  {name}{'  ' + str(exc) if isinstance(exc, str) else ''}")
    print("-" * 60)
    print(f"  {passed}/{len(ALL_TESTS)} tests passed")
    print("=" * 60)
    return passed == len(ALL_TESTS)


if __name__ == "__main__":
    sys.exit(0 if run_all() else 1)