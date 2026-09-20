"""
Phase 9C - Road Condition Provider (configurable, provider-abstraction)
======================================================================
Supplies normalized road-condition records for a configurable set of roads.

Provider modes
--------------
    live   : only a live external source (currently NOT configured; always
             raises RoadConditionError in this project).
    manual : user-supplied static records supplied in the config file.
    mock   : deterministic, reproducible test/mock records derived from
             (road_id, latitude, longitude, timestamp).
    auto   : live if a live provider were configured; otherwise manual.
             NEVER fabricates live data.

No live road-condition provider is currently integrated.  That is by design:
the architecture is ready, but the data must come from a real source before
the live branch is enabled.  All coordinates below are FICTIONAL TEST DATA
and are NOT linked to any existing traffic video.

Usage
-----
    from road_condition_provider import RoadConditionProvider

    prov = RoadConditionProvider(config_path=...)
    records = prov.get_conditions(mode="mock")          # deterministic test data
    records = prov.get_conditions(mode="manual")         # config manual_records
    records = prov.get_conditions(mode="live")           # raises RoadConditionError
"""

import hashlib
import json
import random
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config" / "road_condition_config.json"


class RoadConditionError(RuntimeError):
    """Raised when road-condition data cannot be fetched or is invalid."""


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _load_config(config_path=None):
    path = Path(config_path) if config_path else DEFAULT_CONFIG_PATH
    if not path.exists():
        raise RoadConditionError(f"road-condition config not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ============================================================
#  Mock profiles: deterministic test cases that exercise every
#  road-condition branch without fabricating real-world claims.
# ============================================================
# Each profile is a dict of (road_surface, construction, closure,
# flooding, incident).  They cycle deterministically so that 8 test
# roads receive 8 distinct, documented conditions.

MOCK_PROFILES = [
    # 0  - GOOD: clear open road, good surface
    {"road_surface": "GOOD",    "construction_status": "NONE",
     "closure_status": "OPEN",  "flooding_status": "NONE",
     "incident_status": "NONE"},
    # 1  - MODERATE: slightly worn surface
    {"road_surface": "MODERATE","construction_status": "NONE",
     "closure_status": "OPEN",  "flooding_status": "NONE",
     "incident_status": "NONE"},
    # 2  - POOR: poor surface, active construction
    {"road_surface": "POOR",    "construction_status": "ACTIVE",
     "closure_status": "OPEN",  "flooding_status": "NONE",
     "incident_status": "NONE"},
    # 3  - PARTIAL closure
    {"road_surface": "MODERATE","construction_status": "NONE",
     "closure_status": "PARTIAL","flooding_status": "NONE",
     "incident_status": "NONE"},
    # 4  - CLOSED road
    {"road_surface": "GOOD",    "construction_status": "NONE",
     "closure_status": "CLOSED","flooding_status": "NONE",
     "incident_status": "NONE"},
    # 5  - SEVERE flooding
    {"road_surface": "MODERATE","construction_status": "NONE",
     "closure_status": "OPEN",  "flooding_status": "SEVERE",
     "incident_status": "NONE"},
    # 6  - REPORTED incident
    {"road_surface": "GOOD",    "construction_status": "NONE",
     "closure_status": "OPEN",  "flooding_status": "NONE",
     "incident_status": "REPORTED"},
    # 7  - UNKNOWN: everything unspecified (simulates incomplete data)
    {"road_surface": "UNKNOWN", "construction_status": "UNKNOWN",
     "closure_status": "UNKNOWN","flooding_status": "UNKNOWN",
     "incident_status": "UNKNOWN"},
]


def _mock_seed(road_id, lat, lon, ts):
    src = f"{road_id}|{float(lat):.6f}|{float(lon):.6f}|{ts}".encode("utf-8")
    return int.from_bytes(hashlib.sha256(src).digest()[:8], "big")


class RoadConditionProvider:
    """Configurable road-condition provider (manual + deterministic mock)."""

    def __init__(self, config=None, config_path=None):
        cfg = config if config is not None else _load_config(config_path)
        self.provider_name = cfg.get("provider", "manual")
        self.mode_default = cfg.get("mode", "manual")
        self.test_roads = cfg.get("test_roads", [])
        self.manual_records = cfg.get("manual_records", [])
        api = cfg.get("api", {})
        self.timeout = float(api.get("timeout_seconds", 20))
        self.env_url_override = api.get("env_url_override")
        self.env_key = api.get("env_key")
        self.allow_mock_fallback = cfg.get("allow_mock_fallback", False)

    # -- public interface ---------------------------------------------------
    def get_conditions(self, mode=None, timestamp=None):
        """Return a list of normalized road-condition record dicts.

        All coordinates are supplied by the config or caller; nothing is
        inferred for any existing traffic video.
        """
        requested = mode or self.mode_default
        ts = timestamp or _now_iso()

        if requested == "live":
            return self._get_live()
        if requested == "manual":
            return self._get_manual(ts)
        if requested == "mock":
            return self._get_mock(ts)
        if requested == "auto":
            # No live provider configured; fall back to manual.
            return self._get_manual(ts)
        raise RoadConditionError(
            f"unknown mode '{requested}' (expected live/manual/mock/auto)")

    # -- live (currently unconfigured) --------------------------------------
    def _get_live(self):
        """Live mode: no external road-condition provider is currently
        configured in this project.  Instead of fabricating data, we raise."""
        raise RoadConditionError(
            "no live road-condition provider is configured; "
            "set mode='manual' or mode='mock', or implement a live provider "
            "in src/road_condition_provider.py")

    # -- manual (static records from config) --------------------------------
    def _get_manual(self, ts):
        """User-supplied static records from config.manual_records."""
        records = []
        for rec in self.manual_records:
            road_id = rec.get("road_id", "")
            record = {
                "road_id": road_id,
                "road_name": rec.get("road_name", ""),
                "latitude": float(rec.get("latitude", 0.0)),
                "longitude": float(rec.get("longitude", 0.0)),
                "observation_time": rec.get("observation_time", ts),
                "data_mode": "manual",
                "data_source": "manual-config",
                "data_provider": "manual",
                "is_mock": False,
                "fallback_reason": "",
                "road_surface": rec.get("road_surface", "UNKNOWN"),
                "road_surface_score": rec.get("road_surface_score"),
                "construction_status": rec.get("construction_status", "UNKNOWN"),
                "closure_status": rec.get("closure_status", "UNKNOWN"),
                "flooding_status": rec.get("flooding_status", "UNKNOWN"),
                "incident_status": rec.get("incident_status", "UNKNOWN"),
            }
            records.append(record)
        return records

    # -- deterministic mock -------------------------------------------------
    def _get_mock(self, ts):
        """Deterministic, reproducible mock records for every test road."""
        records = []
        for road in self.test_roads:
            road_id = road["road_id"]
            lat = road["latitude"]
            lon = road["longitude"]
            seed = _mock_seed(road_id, lat, lon, ts)
            rnd = random.Random(seed)
            profile = MOCK_PROFILES[rnd.randint(0, len(MOCK_PROFILES) - 1)]

            # small random jitter for any numeric fields where the profile
            # does not specify a fixed value (maintains determinism)
            surface_score = round(rnd.uniform(20, 100), 1)

            record = {
                "road_id": road_id,
                "road_name": road.get("road_name", ""),
                "latitude": float(lat),
                "longitude": float(lon),
                "observation_time": ts,
                "data_mode": "mock",
                "data_source": "deterministic-mock",
                "data_provider": "deterministic-mock",
                "is_mock": True,
                "fallback_reason": "deterministic mock mode (no live network used)",
                "road_surface": profile["road_surface"],
                "road_surface_score": surface_score if profile["road_surface"] != "UNKNOWN" else None,
                "construction_status": profile["construction_status"],
                "closure_status": profile["closure_status"],
                "flooding_status": profile["flooding_status"],
                "incident_status": profile["incident_status"],
            }
            records.append(record)
        return records


# -- convenience top-level function ----------------------------------------
def get_conditions(mode="auto", timestamp=None, config_path=None):
    provider = RoadConditionProvider(config_path=config_path)
    return provider.get_conditions(mode=mode, timestamp=timestamp)


if __name__ == "__main__":
    import sys
    mode = sys.argv[1] if len(sys.argv) > 1 else "auto"
    results = get_conditions(mode=mode)
    print(json.dumps(results, indent=2))
