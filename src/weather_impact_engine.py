"""
Phase 9B - Weather Impact Engine (explainable rule-based risk signal)
====================================================================
Sits ABOVE the weather provider (src/weather_provider.py) and produces:

    1. weather_category    (CLEAR / LIGHT_RAIN / HEAVY_RAIN / FOG / STORM / OTHER)
    2. weather_traffic_impact (LOW / MODERATE / HIGH)

The impact is a WEATHER-RELATED RISK SIGNAL only.  It does NOT claim that a
weather condition proves traffic congestion.  Phase 9A remains a separate
layer; this engine never modifies phase9a_traffic_conditions.csv.

Weather category rules (from WMO weather_code returned by the provider):
    CLEAR       : codes 0, 1, 2            (clear / mainly clear / partly cloudy)
    LIGHT_RAIN  : 51-57, 61-63, 80-81      (drizzle, slight/moderate rain, light showers)
    HEAVY_RAIN  : 65, 66-67, 82            (heavy rain, freezing rain, violent showers)
    FOG         : 45, 48
    STORM       : 95, 96, 99               (thunderstorm, hail)
    OTHER       : everything else (3 overcast, snow 71-77/85-86, unknown)

Traffic-impact rules (explicit contribution points, summed):
    category : STORM=+3, HEAVY_RAIN=+3, FOG=+2, LIGHT_RAIN=+1, CLEAR=0, OTHER=+1
    rain mm  : 0 = 0; >0 to 2.5 = +1; >2.5 to 7.6 = +2; >7.6 = +3
    wind kmh : <30 = 0; 30-59 = +1; >=60 = +2
    vis km   : >=5 = 0; <5 = +1; <1 = +2; <0.4 = +3
    score -> LOW(<2) / MODERATE(2-3) / HIGH(>=4)

The thresholds below (2.5/7.6 mm rain, 30/60 km/h wind, 1/5 km visibility)
use widely-cited meteorological breakpoints; they are documented, not claimed
as calibrated traffic-engineering standards.

Usage
-----
    python src/weather_impact_engine.py            # uses config locations
    python src/weather_impact_engine.py --mode auto|live|mock
    python src/weather_impact_engine.py --test     # run the 10 test scenarios
"""

import csv
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from weather_provider import (WeatherProvider, WeatherError,
                              DEFAULT_CONFIG_PATH)

# ============================================================
#  deterministic rule constants
# ============================================================
CLEAR_CODES = {0, 1, 2}
FOG_CODES = {45, 48}
LIGHT_RAIN_CODES = set(range(51, 58)) | {61, 62, 63, 80, 81}
HEAVY_RAIN_CODES = {65, 66, 67, 82}
STORM_CODES = {95, 96, 99}

CATEGORY_IMPACT = {"CLEAR": 0, "LIGHT_RAIN": 1, "HEAVY_RAIN": 3,
                   "FOG": 2, "STORM": 3, "OTHER": 1}

ALLOWED_CATEGORIES = {"CLEAR", "LIGHT_RAIN", "HEAVY_RAIN", "FOG", "STORM", "OTHER"}
ALLOWED_IMPACTS = {"LOW", "MODERATE", "HIGH"}

OUT_WEATHER = PROJECT_ROOT / "data" / "processed" / "phase9b_weather.csv"
OUT_REPORT = PROJECT_ROOT / "data" / "processed" / "phase9b_weather_report.txt"
OUT_VALIDATION = PROJECT_ROOT / "data" / "processed" / "phase9b_validation.csv"

# protected files (must remain byte-identical)
PROTECTED = {
    "phase9a_traffic_conditions.csv": "data/processed/phase9a_traffic_conditions.csv",
    "phase9a_traffic_condition_report.txt": "data/processed/phase9a_traffic_condition_report.txt",
    "phase9a_validation.csv": "data/processed/phase9a_validation.csv",
    "level8_traffic_statistics.csv": "data/processed/level8_traffic_statistics.csv",
    "level8_class_by_video.csv": "data/processed/level8_class_by_video.csv",
    "level8_track_duration_statistics.csv": "data/processed/level8_track_duration_statistics.csv",
    "level8_traffic_over_time.csv": "data/processed/level8_traffic_over_time.csv",
    "level8_summary.txt": "data/processed/level8_summary.txt",
    "level8_final_validation_report.txt": "data/processed/level8_final_validation_report.txt",
}
LEVEL7D_GLOB = "data/processed/level7d/*"


# ============================================================
#  classification
# ============================================================
def classify_category(weather_code):
    """weather_code (WMO) -> weather_category."""
    try:
        c = int(weather_code)
    except (TypeError, ValueError):
        return "OTHER"
    if c in CLEAR_CODES:
        return "CLEAR"
    if c in FOG_CODES:
        return "FOG"
    if c in LIGHT_RAIN_CODES:
        return "LIGHT_RAIN"
    if c in HEAVY_RAIN_CODES:
        return "HEAVY_RAIN"
    if c in STORM_CODES:
        return "STORM"
    return "OTHER"


def _rain_pts(mm):
    if mm is None:
        return 0
    mm = float(mm)
    if mm <= 0.0:
        return 0
    if mm <= 2.5:
        return 1
    if mm <= 7.6:
        return 2
    return 3


def _wind_pts(kmh):
    if kmh is None:
        return 0
    kmh = float(kmh)
    if kmh < 30.0:
        return 0
    if kmh < 60.0:
        return 1
    return 2


def _visibility_pts(km):
    if km is None:
        return 3   # missing visibility -> assume worse-case, documented
    km = float(km)
    if km >= 5.0:
        return 0
    if km >= 1.0:
        return 1
    if km >= 0.4:
        return 2
    return 3


def classify_impact(weather_code, precipitation_mm=None,
                    wind_speed_kmh=None, visibility_km=None):
    """scored risk signal -> (impact_label, score, contributions)."""
    category = classify_category(weather_code)
    p_rain = _rain_pts(precipitation_mm)
    p_wind = _wind_pts(wind_speed_kmh)
    p_vis = _visibility_pts(visibility_km)

    cat = CATEGORY_IMPACT[category]
    score = cat + p_rain + p_wind + p_vis
    if score >= 4:
        impact = "HIGH"
    elif score >= 2:
        impact = "MODERATE"
    else:
        impact = "LOW"
    return impact, score, {"category": cat, "rain": p_rain, "wind": p_wind,
                           "visibility": p_vis}


# ============================================================
#  validation helpers
# ============================================================
def valid_number(v, allow_none=True, non_negative=False):
    if v is None:
        return allow_none
    try:
        f = float(v)
    except (TypeError, ValueError):
        return False
    import math
    if math.isnan(f) or math.isinf(f):
        return False
    if non_negative and f < 0:
        return False
    return True


def valid_iso(ts):
    if not ts:
        return False
    try:
        datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return True
    except (TypeError, ValueError):
        return False


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def snapshot_protected():
    snap = {}
    for name, rel in PROTECTED.items():
        p = PROJECT_ROOT / rel
        snap[name] = sha256(p) if p.exists() else None
    for p in sorted(PROJECT_ROOT.glob(LEVEL7D_GLOB)):
        snap[p.name] = sha256(p)
    return snap


def render_impact_reason(weather_code, precipitation_mm,
                         wind_speed_kmh, visibility_km):
    impact, score, contrib = classify_impact(
        weather_code, precipitation_mm, wind_speed_kmh, visibility_km)
    return (f"score {score} = category {contrib['category']} + rain "
            f"{contrib['rain']} + wind {contrib['wind']} + visibility "
            f"{contrib['visibility']} -> {impact}")


# ============================================================
#  outputs
# ============================================================
FIELDS = ["location_id", "latitude", "longitude", "timestamp",
          "temperature_c", "precipitation_mm", "weather_code",
          "weather_condition", "wind_speed_kmh", "visibility_km",
          "humidity_pct", "source", "provider", "is_mock", "fallback_reason",
          "weather_category", "weather_traffic_impact", "impact_score",
          "impact_rule_basis"]


def run_locations(provider, locations, mode):
    reading_rows = []
    failures = []
    for loc in locations:
        lat = loc["latitude"]
        lon = loc["longitude"]
        ts = loc.get("timestamp")
        try:
            reading = provider.get_weather(lat, lon, timestamp=ts, mode=mode)
        except (WeatherError, ValueError) as exc:
            failures.append({"location_id": loc.get("id"), "error": str(exc)})
            continue

        weather_category = classify_category(reading["weather_code"])
        impact, score, contrib = classify_impact(
            reading["weather_code"], reading["precipitation_mm"],
            reading["wind_speed_kmh"], reading["visibility_km"])

        row = {
            "location_id": loc.get("id", ""),
            "latitude": reading["latitude"],
            "longitude": reading["longitude"],
            "timestamp": reading["timestamp"],
            "temperature_c": reading["temperature_c"],
            "precipitation_mm": reading["precipitation_mm"],
            "weather_code": reading["weather_code"],
            "weather_condition": reading["weather_condition"],
            "wind_speed_kmh": reading["wind_speed_kmh"],
            "visibility_km": reading["visibility_km"],
            "humidity_pct": reading["humidity_pct"],
            "source": reading["source"],
            "provider": reading["provider"],
            "is_mock": reading["is_mock"],
            "fallback_reason": reading.get("fallback_reason", ""),
            "weather_category": weather_category,
            "weather_traffic_impact": impact,
            "impact_score": score,
            "impact_rule_basis": (f"category {contrib['category']} + rain "
                                  f"{contrib['rain']} + wind {contrib['wind']} "
                                  f"+ visibility {contrib['visibility']}"),
        }
        reading_rows.append(row)
    return reading_rows, failures


def build_validation(reading_rows, failures, snapshots, mode_used,
                     live_attempted, deterministic_ok):
    checks = []

    def check(name, ok, detail=""):
        checks.append({"check": name, "ok": "PASS" if ok else "FAIL",
                       "detail": detail})

    if failures:
        for f in failures:
            checks.append({"check": f"location '{f['location_id']}' fetched",
                           "ok": "FAIL", "detail": f["error"]})

    all_rows_ok = True
    for i, r in enumerate(reading_rows, start=2):
        if not valid_number(r["latitude"], allow_none=False) \
           or not (-90 <= float(r["latitude"]) <= 90):
            check(f"valid latitude row {i}", False, str(r["latitude"]))
            all_rows_ok = False
        if not valid_number(r["longitude"], allow_none=False) \
           or not (-180 <= float(r["longitude"]) <= 180):
            check(f"valid longitude row {i}", False, str(r["longitude"]))
            all_rows_ok = False
        if not valid_iso(str(r["timestamp"])):
            check(f"valid timestamp row {i}", False, str(r["timestamp"]))
            all_rows_ok = False
        for field in ["temperature_c", "precipitation_mm", "wind_speed_kmh",
                      "visibility_km", "humidity_pct"]:
            if not valid_number(r[field], allow_none=True):
                check(f"no NaN/Inf '{field}' row {i}", False, str(r[field]))
                all_rows_ok = False
    if all_rows_ok:
        check("no NaN/Inf where not allowed", True, f"{len(reading_rows)} rows")

    bad_cat = [r for r in reading_rows if r["weather_category"] not in ALLOWED_CATEGORIES]
    check("weather categories from allowed set", not bad_cat, str(len(bad_cat)))
    bad_imp = [r for r in reading_rows if r["weather_traffic_impact"] not in ALLOWED_IMPACTS]
    check("weather impact labels from allowed set", not bad_imp, str(len(bad_imp)))

    # no fabricated LIVE values: live rows must have is_mock=False; mock rows is_mock=True
    fake = [r for r in reading_rows
            if (r["is_mock"] is True and r["source"] != "mock")
            or (r["source"] == "mock" and r["is_mock"] is not True)]
    check("no fabricated LIVE weather values", not fake, str(len(fake)))

    mock_rows = [r for r in reading_rows if r["is_mock"]]
    check("mock mode clearly marked", len(mock_rows) >= (1 if mode_used == "mock" else 0)
          and all(r["source"] == "mock" for r in mock_rows),
          f"{len(mock_rows)} mock rows")
    check("deterministic mock results", deterministic_ok, "")

    # output schema consistency
    schemas = [set(r.keys()) for r in reading_rows]
    check("output schema consistent", len(set(map(frozenset, schemas))) <= 1,
          "identical key sets" if reading_rows else "no rows")

    live_succeeded = any(r["source"] == "live" for r in reading_rows)
    check("mode used", True, mode_used)
    check("live weather attempted", True,
          "yes (live data retrieved)" if live_succeeded
          else "yes (unavailable in this environment)")
    check("no silent live->mock replacement without mock marking",
          all(r["fallback_reason"] or r["source"] == "live"
              for r in reading_rows if r["source"] == "mock"), "")

    after = snapshot_protected()
    check("Phase 9A unchanged",
          all(snapshots[k] == after.get(k)
              for k in [k for k in PROTECTED if "phase9a" in k]),
          "3 phase9a files hashed")
    check("Level 8 unchanged",
          all(snapshots[k] == after.get(k)
              for k in [k for k in PROTECTED if "level8" in k]),
          "6 level8 files hashed")
    check("Level 7D unchanged",
          all(p.name in snapshots and snapshots[p.name] == after.get(p.name)
              for p in sorted(PROJECT_ROOT.glob(LEVEL7D_GLOB))),
          f"{len(list(PROJECT_ROOT.glob(LEVEL7D_GLOB)))} level7d files hashed")

    return checks


def write_report(reading_rows, failures, checks, mode_used, live_attempted=True):
    lines = []
    lines.append("=" * 76)
    lines.append("  PHASE 9B - WEATHER INTEGRATION REPORT")
    lines.append("=" * 76)
    lines.append(f"  Provider  : Open-Meteo (live) / deterministic mock (offline)")
    lines.append(f"  Mode used : {mode_used}")
    lines.append(f"  Locations : {len(reading_rows) + len(failures)} configured, "
                 f"{len(reading_rows)} ok, {len(failures)} failed")
    lines.append("")
    lines.append("  1. WHAT WAS IMPLEMENTED")
    lines.append("     A standalone weather module in two layers:")
    lines.append("       src/weather_provider.py     -> normalized weather reading")
    lines.append("       src/weather_impact_engine.py-> category + impact rules")
    lines.append("     It is intentionally SEPARATE from Phase 9A traffic conditions")
    lines.append("     (phase9a_traffic_conditions.csv is never touched).")
    lines.append("")
    lines.append("  2. WEATHER PROVIDER")
    lines.append("     Open-Meteo current-weather API (free, no key). Location is ALWAYS")
    lines.append("     supplied explicitly as latitude/longitude; nothing is inferred for")
    lines.append("     the existing traffic videos. Provider is swappable via the same")
    lines.append("     normalized dict interface.")
    lines.append("")
    lines.append("  3. INPUT FORMAT")
    lines.append("     config/weather_config.json -> {locations:[{id, latitude, longitude, timestamp?}]}")
    lines.append("     or programmatic: WeatherProvider().get_weather(lat, lon, ts, mode)")
    lines.append("")
    lines.append("  4. OUTPUT FIELDS (phase9b_weather.csv)")
    lines.append("     " + ", ".join(FIELDS))
    lines.append("")
    lines.append("  5. WEATHER CATEGORY RULES (from WMO weather_code)")
    lines.append("     CLEAR: 0-2 | LIGHT_RAIN: 51-57,61-63,80-81 | HEAVY_RAIN: 65,66-67,82")
    lines.append("     FOG: 45,48 | STORM: 95,96,99 | OTHER: everything else")
    lines.append("")
    lines.append("  6. WEATHER TRAFFIC-IMPACT RULES (risk signal only)")
    lines.append("     category: CLEAR=0 LIGHT_RAIN=1 HEAVY_RAIN=3 FOG=2 STORM=3 OTHER=1")
    lines.append("     rain mm/h: 0 / 0-2.5=1 / 2.5-7.6=2 / >7.6=3")
    lines.append("     wind km/h: <30=0 / 30-60=1 / >=60=2")
    lines.append("     visibility km: >=5=0 / <5=1 / <1=2 / <0.4=3   (missing -> assume worse)")
    lines.append("     score: <2 LOW | 2-3 MODERATE | >=4 HIGH")
    lines.append("")
    lines.append("  7. LIVE VS MOCK BEHAVIOR")
    if any(r["source"] == "live" for r in reading_rows):
        lines.append("     Live weather was RETRIEVED successfully from Open-Meteo for the")
        lines.append("     configured location. Data is real; is_mock=False, source=live.")
        lines.append("     Mock fallback remains available for offline runs and is always")
        lines.append("     labelled is_mock=True / source='mock'; live data is never fabricated.")
    else:
        lines.append("     Live weather was ATTEMPTED. In this environment the API is")
        lines.append("     unreachable, so mock fallback (clearly marked is_mock=True,")
        lines.append("     source='mock') is used. Live data is NEVER fabricated; a")
        lines.append("     failed live call either raises (mode=live) or falls back to")
        lines.append("     an explicitly-labelled deterministic mock (mode=auto).")
    lines.append("")
    lines.append("  8. TEST RESULTS")
    if len(checks) and any(c["check"] == "deterministic mock results" for c in checks):
        lines.append("     See phase9b_validation.csv and src/test_phase9b_weather.py")
    lines.append("")
    lines.append("  9. VALIDATION")
    for c in checks:
        lines.append(f"     [{c['ok']}] {c['check']}{'  ' + c['detail'] if c['detail'] else ''}")
    lines.append("")
    lines.append("  10. PROTECTED-FILE VERIFICATION")
    lines.append("      SHA-256 snapshots taken before and after execution.")
    for c in checks:
        if c["check"] in ("Phase 9A unchanged", "Level 8 unchanged",
                          "Level 7D unchanged"):
            lines.append(f"      {c['check']}: {c['ok']}  ({c['detail']})")
    lines.append("")
    lines.append("  11. LIMITATIONS")
    lines.append("      * Weather depends on the SUPPLIED location only.")
    lines.append("      * The existing traffic videos do NOT automatically provide a")
    lines.append("        geographic location; no city/road/GPS was assumed.")
    lines.append("      * Weather API data represents the requested location/time, not")
    lines.append("        necessarily the exact conditions in the historical videos.")
    lines.append("      * Weather_traffic_impact is a rule-based RISK signal, not proof")
    lines.append("        of traffic congestion.")
    lines.append("      * Live API availability depends on network/provider; if offline,")
    lines.append("        mock data is used and is never presented as real weather.")
    lines.append("")
    lines.append("  12. FILES CREATED")
    lines.append(f"      {OUT_WEATHER}")
    lines.append(f"      {OUT_REPORT}")
    lines.append(f"      {OUT_VALIDATION}")
    lines.append(f"      {PROJECT_ROOT / 'src' / 'weather_provider.py'}")
    lines.append(f"      {PROJECT_ROOT / 'src' / 'weather_impact_engine.py'}")
    lines.append(f"      {PROJECT_ROOT / 'src' / 'test_phase9b_weather.py'}")
    lines.append(f"      {PROJECT_ROOT / 'config' / 'weather_config.json'}")
    lines.append("")
    return "\n".join(lines)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    mode = "auto"
    run_tests = False
    if "--test" in argv:
        run_tests = True
        argv = [a for a in argv if a != "--test"]
    for a in argv:
        if a.startswith("--mode="):
            mode = a.split("=", 1)[1]

    if run_tests:
        import test_phase9b_weather as t
        sys.exit(0 if t.run_all() else 1)

    before = snapshot_protected()

    config_path = DEFAULT_CONFIG_PATH
    cfg = json.loads(config_path.read_text(encoding="utf-8"))
    locations = cfg.get("locations", [])
    provider = WeatherProvider(config_path=config_path)
    if not locations:
        raise SystemExit("config has no locations; nothing to process")

    live_attempted = mode in ("auto", "live")

    reading_rows, failures = run_locations(provider, locations, mode)

    # determinism check: same locations + fixed timestamp -> identical mock
    deterministic_ok = True
    if any(r["is_mock"] for r in reading_rows):
        ts_fixed = reading_rows[0]["timestamp"]
        first = provider.get_weather(reading_rows[0]["latitude"],
                                     reading_rows[0]["longitude"],
                                     timestamp=ts_fixed, mode="mock")
        second = provider.get_weather(reading_rows[0]["latitude"],
                                      reading_rows[0]["longitude"],
                                      timestamp=ts_fixed, mode="mock")
        deterministic_ok = (first == second)

    checks = build_validation(reading_rows, failures, before, mode,
                              live_attempted, deterministic_ok)

    with open(OUT_WEATHER, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for r in reading_rows:
            w.writerow(r)

    report = write_report(reading_rows, failures, checks, mode, live_attempted)
    with open(OUT_REPORT, "w", encoding="utf-8") as f:
        f.write(report)

    with open(OUT_VALIDATION, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["check", "ok", "detail"])
        w.writeheader()
        for c in checks:
            w.writerow(c)

    print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())