"""
Phase 9E - Route Recommendation Tests (12 required scenarios)
=============================================================
Run:
    python src/test_phase9e_route_recommendation.py

All tests are OFFLINE (no network). They exercise route scoring and
ranking logic using deterministic MOCK/TEST candidate routes over the
fictional MOCK-ROAD-* Phase 9D road IDs. No real roads are claimed.
"""

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from route_recommendation_engine import (
    DEFAULT_CONFIG_PATH,
    RouteRecommendationEngine,
)

# Synthetic Phase 9D-like road scores (mirrors the real Phase 9D output
# for the fictional MOCK-ROAD-* records: scores and confidences).
D9_SCORES = {
    "MOCK-ROAD-01": {"overall_score": 100.0, "confidence": 0.55, "data_mode": "mock", "is_mock": "True", "data_source": "phase9d-deterministic-mock", "road_name": "Fictional Road 01"},
    "MOCK-ROAD-02": {"overall_score": 75.8, "confidence": 0.55, "data_mode": "mock", "is_mock": "True", "data_source": "phase9d-deterministic-mock", "road_name": "Fictional Road 02"},
    "MOCK-ROAD-03": {"overall_score": 42.2, "confidence": 0.55, "data_mode": "mock", "is_mock": "True", "data_source": "phase9d-deterministic-mock", "road_name": "Fictional Road 03"},
    "MOCK-ROAD-04": {"overall_score": 23.5, "confidence": 0.55, "data_mode": "mock", "is_mock": "True", "data_source": "phase9d-deterministic-mock", "road_name": "Fictional Road 04"},
    "MOCK-ROAD-05": {"overall_score": 84.0, "confidence": 0.29, "data_mode": "mock", "is_mock": "True", "data_source": "phase9d-deterministic-mock", "road_name": "Fictional Road 05"},
    "MOCK-ROAD-06": {"overall_score": 100.0, "confidence": 0.12, "data_mode": "mock", "is_mock": "True", "data_source": "phase9d-deterministic-mock", "road_name": "Fictional Road 06"},
    "MOCK-ROAD-07": {"overall_score": None, "confidence": 0.05, "data_mode": "mock", "is_mock": "True", "data_source": "phase9d-deterministic-mock", "road_name": "Fictional Road 07"},
    "MOCK-ROAD-08": {"overall_score": 75.8, "confidence": 0.55, "data_mode": "mock", "is_mock": "True", "data_source": "phase9d-deterministic-mock", "road_name": "Fictional Road 08"},
}


def _seg(order, road_id, dist=None, travel=None):
    return {
        "segment_order": order,
        "road_id": road_id,
        "road_name": road_id,
        "distance_km": dist,
        "travel_time_minutes": travel,
    }


def _mroute(route_id, segments, mode="mock"):
    return {
        "route_id": route_id,
        "route_name": route_id,
        "data_mode": mode,
        "data_source": "phase9e-mock-route-det",
        "segments": segments,
    }


def _make_engine(routes):
    tmp_dir = tempfile.mkdtemp()
    cfg = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    cfg["routes"] = routes
    p = Path(tmp_dir) / "config.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    return RouteRecommendationEngine(config_path=p, scores_map=D9_SCORES)


# 1. single-segment route
def test_single_segment_route():
    engine = _make_engine([_mroute("SINGLE", [_seg(1, "MOCK-ROAD-04")])])
    rows = [engine.evaluate_route(r) for r in engine.config["routes"]]
    assert rows[0]["route_score"] == 23.5
    assert rows[0]["route_category"] == "POOR"
    assert rows[0]["known_segment_count"] == 1
    assert rows[0]["total_segment_count"] == 1
    assert rows[0]["weighting_method"] == "equal"
    assert rows[0]["is_mock"] == "True"


# 2. multi-segment route
def test_multi_segment_route():
    engine = _make_engine([_mroute("MULTI", [
        _seg(1, "MOCK-ROAD-01"), _seg(2, "MOCK-ROAD-02"), _seg(3, "MOCK-ROAD-03"),
    ])])
    rows = [engine.evaluate_route(r) for r in engine.config["routes"]]
    assert rows[0]["route_score"] == 72.7
    assert rows[0]["route_category"] == "MODERATE"
    assert rows[0]["known_segment_count"] == 3
    assert rows[0]["segment_sequence"] == "MOCK-ROAD-01;MOCK-ROAD-02;MOCK-ROAD-03"


# 3. equal weighting when distance unavailable
def test_equal_weighting_when_distance_unavailable():
    engine = _make_engine([_mroute("EQ", [_seg(1, "MOCK-ROAD-01"), _seg(2, "MOCK-ROAD-02")])])
    rows = [engine.evaluate_route(r) for r in engine.config["routes"]]
    assert rows[0]["weighting_method"] == "equal"
    assert rows[0]["route_score"] == round((100.0 + 75.8) / 2, 1)
    assert rows[0]["explicit_distance_km_total"] == ""


# 4. distance-weighted scoring when explicit distance exists
def test_distance_weighted_scoring():
    engine = _make_engine([_mroute("DIST", [
        _seg(1, "MOCK-ROAD-01", dist=2.0),
        _seg(2, "MOCK-ROAD-02", dist=8.0),
    ])])
    rows = [engine.evaluate_route(r) for r in engine.config["routes"]]
    assert rows[0]["weighting_method"] == "distance"
    expected = (100.0 * 2.0 + 75.8 * 8.0) / (2.0 + 8.0)
    assert rows[0]["route_score"] == round(expected, 1)
    assert rows[0]["explicit_distance_km_total"] == 10.0


# 5. UNKNOWN segment handling
def test_unknown_segment_handling():
    engine = _make_engine([_mroute("UNK", [_seg(1, "MOCK-ROAD-05"), _seg(2, "MOCK-ROAD-07")])])
    rows = [engine.evaluate_route(r) for r in engine.config["routes"]]
    row = rows[0]
    assert row["known_segment_count"] == 1
    assert row["unknown_segment_count"] == 1
    assert row["route_score"] == 84.0
    assert "MOCK-ROAD-07=UNKNOWN" in row["segment_scores"]


# 6. all-UNKNOWN route
def test_all_unknown_route():
    engine = _make_engine([_mroute("ALLUNK", [_seg(1, "MOCK-ROAD-07"), _seg(2, "MOCK-ROAD-07")])])
    rows = [engine.evaluate_route(r) for r in engine.config["routes"]]
    assert rows[0]["route_score"] == "UNKNOWN"
    assert rows[0]["route_category"] == "UNKNOWN"
    assert rows[0]["recommendation_status"] == "INSUFFICIENT_DATA"
    assert rows[0]["route_confidence"] == 0.05


# 7. invalid road ID
def test_invalid_road_id():
    engine = _make_engine([_mroute("BAD", [_seg(1, "MOCK-ROAD-01"), _seg(2, "NOT-A-ROAD")])])
    rows = [engine.evaluate_route(r) for r in engine.config["routes"]]
    assert rows[0]["recommendation_status"] == "INVALID_ROUTE"
    assert rows[0]["route_score"] == "UNKNOWN"
    assert rows[0]["route_category"] == "UNKNOWN"
    assert "NOT-A-ROAD" in rows[0]["reason"]


# 8. route category boundaries
def test_route_category_boundaries():
    engine = _make_engine([_mroute("X", [_seg(1, "MOCK-ROAD-01")])])
    assert engine.category_for(100) == "GOOD"
    assert engine.category_for(80) == "GOOD"
    assert engine.category_for(79) == "MODERATE"
    assert engine.category_for(60) == "MODERATE"
    assert engine.category_for(59) == "CAUTION"
    assert engine.category_for(40) == "CAUTION"
    assert engine.category_for(39) == "POOR"
    assert engine.category_for(20) == "POOR"
    assert engine.category_for(19) == "VERY_POOR"
    assert engine.category_for(0) == "VERY_POOR"
    assert engine.category_for(None) == "UNKNOWN"


# 9. confidence remains between 0 and 1
def test_confidence_between_0_and_1():
    routes = [
        _mroute("R1", [_seg(1, "MOCK-ROAD-01")]),
        _mroute("R2", [_seg(1, "MOCK-ROAD-01"), _seg(2, "MOCK-ROAD-07")]),
        _mroute("R3", [_seg(1, "MOCK-ROAD-07"), _seg(2, "MOCK-ROAD-07")]),
        _mroute("R4", [_seg(1, "MOCK-ROAD-05"), _seg(2, "MOCK-ROAD-06"), _seg(3, "MOCK-ROAD-07")]),
    ]
    engine = _make_engine(routes)
    rows = [engine.evaluate_route(r) for r in engine.config["routes"]]
    for row in rows:
        assert 0.0 <= float(row["route_confidence"]) <= 1.0
    unknown = [r for r in rows if r["route_id"] == "R3"][0]
    assert unknown["route_confidence"] == 0.05


# 10. deterministic repeated execution
def test_deterministic_repeated_execution():
    routes = [
        _mroute("A", [_seg(1, "MOCK-ROAD-01"), _seg(2, "MOCK-ROAD-02"), _seg(3, "MOCK-ROAD-03")]),
        _mroute("B", [_seg(1, "MOCK-ROAD-04")]),
        _mroute("C", [_seg(1, "MOCK-ROAD-01"), _seg(2, "MOCK-ROAD-07")]),
    ]
    engine = _make_engine(routes)
    first = engine.run(write_outputs=False)
    second = engine.run(write_outputs=False)
    assert [
        (r["route_id"], r["route_score"], r["route_category"],
         r["route_confidence"], r["recommendation_status"])
        for r in first["rows"]
    ] == [
        (r["route_id"], r["route_score"], r["route_category"],
         r["route_confidence"], r["recommendation_status"])
        for r in second["rows"]
    ]


# 11. mock data remains labelled mock
def test_mock_data_remains_labelled_mock():
    engine = _make_engine([_mroute("M", [_seg(1, "MOCK-ROAD-01")])])
    summary = engine.run(write_outputs=False)
    for row in summary["rows"]:
        assert row["data_mode"] == "mock"
        assert row["is_mock"] == "True"
        assert row["data_source"] == "phase9e-mock-route-det"
    assert all(c["ok"] == "PASS" for c in summary["checks"])


# 12. source Phase 9D data is not modified
def test_source_phase9d_data_not_modified():
    import hashlib
    source = Path(__file__).resolve().parents[1] / "data" / "processed" / "phase9d_road_scores.csv"
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    engine = _make_engine([_mroute("S", [_seg(1, "MOCK-ROAD-01")])])
    engine.run(write_outputs=False)
    after = hashlib.sha256(source.read_bytes()).hexdigest()
    assert before == after


ALL_TESTS = [
    ("single-segment route", test_single_segment_route),
    ("multi-segment route", test_multi_segment_route),
    ("equal weighting when distance unavailable", test_equal_weighting_when_distance_unavailable),
    ("distance-weighted scoring when explicit distance exists", test_distance_weighted_scoring),
    ("UNKNOWN segment handling", test_unknown_segment_handling),
    ("all-UNKNOWN route", test_all_unknown_route),
    ("invalid road ID", test_invalid_road_id),
    ("route category boundaries", test_route_category_boundaries),
    ("confidence between 0 and 1", test_confidence_between_0_and_1),
    ("deterministic repeated execution", test_deterministic_repeated_execution),
    ("mock data remains labelled mock", test_mock_data_remains_labelled_mock),
    ("source Phase 9D data not modified", test_source_phase9d_data_not_modified),
]


def run_all():
    passed = 0
    for desc, fn in ALL_TESTS:
        try:
            fn()
            print(f"  PASS  {desc}")
            passed += 1
        except Exception as exc:
            print(f"  FAIL  {desc}: {exc}")
    print(f"  {passed}/{len(ALL_TESTS)} tests passed")
    return passed == len(ALL_TESTS)


if __name__ == "__main__":
    sys.exit(0 if run_all() else 1)