"""
Phase 9D - Road Scoring Engine Tests (17 required scenarios)
============================================================
Run:
    python src/test_phase9d_road_scoring.py

Or via the engine:
    python src/road_scoring_engine.py --test

All tests are OFFLINE (no network).  They verify the deterministic
and explainable scoring behaviour of the Phase 9D prototype.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from road_scoring_engine import (RoadScoringEngine, compute_confidence,
                                 compute_overall, suitability,
                                 DEFAULT_CONFIG_PATH)


def engine():
    return RoadScoringEngine(config_path=DEFAULT_CONFIG_PATH)


def _rec(traffic="LOW", weather="LOW", road_cond="GOOD", road_risk="LOW",
         data_mode="mock", road_id="T"):
    return {
        "road_id": road_id,
        "road_name": "Test",
        "observation_time": "2026-01-01T08:00:00+00:00",
        "traffic_activity": traffic,
        "weather_impact": weather,
        "road_condition": road_cond,
        "road_risk": road_risk,
        "data_mode": data_mode,
        "data_source": "test",
        "is_mock": data_mode == "mock",
    }


def score_of(rec, key="overall_score"):
    return engine().score_record(rec)[key]


# 1. all LOW inputs
def test_all_low():
    r = engine().score_record(_rec())
    assert score_of(_rec()) == "100.0", r["overall_score"]
    assert r["suitability_category"] == "GOOD", r["suitability_category"]
    assert r["traffic_weight"] == 40.0 and r["weather_weight"] == 25.0 \
        and r["road_weight"] == 35.0
    return True


# 2. moderate traffic
def test_moderate_traffic():
    r = engine().score_record(_rec(traffic="MODERATE"))
    assert r["overall_score"] == "88.0", r["overall_score"]
    assert r["suitability_category"] == "GOOD"
    return True


# 3. heavy traffic
def test_heavy_traffic():
    r = engine().score_record(_rec(traffic="HEAVY"))
    assert r["overall_score"] == "76.0", r["overall_score"]
    assert r["suitability_category"] == "MODERATE"
    return True


# 4. congested traffic
def test_congested_traffic():
    r = engine().score_record(_rec(traffic="CONGESTED"))
    assert r["overall_score"] == "66.0", r["overall_score"]
    assert r["suitability_category"] == "MODERATE"
    return True


# 5. moderate weather
def test_moderate_weather():
    r = engine().score_record(_rec(weather="MODERATE"))
    assert r["overall_score"] == "92.5", r["overall_score"]
    return True


# 6. high weather impact
def test_high_weather():
    r = engine().score_record(_rec(weather="HIGH"))
    assert r["overall_score"] == "83.8", r["overall_score"]
    return True


# 7. poor road
def test_poor_road():
    r = engine().score_record(_rec(road_cond="POOR", road_risk="HIGH"))
    assert r["overall_score"] == "73.8", r["overall_score"]
    assert r["suitability_category"] == "MODERATE", r["suitability_category"]
    return True


# 8. high road risk
def test_high_road_risk():
    r = engine().score_record(
        _rec(traffic="MODERATE", road_cond="RESTRICTED", road_risk="HIGH"))
    assert r["overall_score"] == "61.8", r["overall_score"]
    assert r["suitability_category"] == "MODERATE", r["suitability_category"]
    return True


# 9. one UNKNOWN layer (recalculates weights over known layers)
def test_one_unknown_layer():
    r = engine().score_record(_rec(traffic="MODERATE", weather="UNKNOWN"))
    # (70*40 + 100*35) / 75 = 84.0
    assert r["overall_score"] == "84.0", r["overall_score"]
    assert r["suitability_category"] == "GOOD"
    assert r["weather_weight"] == 0.0
    assert abs(r["traffic_weight"] + r["road_weight"] - 100.0) < 0.05
    assert r["confidence"] == 0.29, r["confidence"]   # (2/3)*0.8*0.55
    return True


# 10. two UNKNOWN layers
def test_two_unknown_layers():
    r = engine().score_record(
        _rec(traffic="UNKNOWN", weather="UNKNOWN"))
    assert r["overall_score"] == "100.0", r["overall_score"]  # road LOW only
    assert r["road_weight"] == 100.0
    assert r["traffic_weight"] == 0.0 and r["weather_weight"] == 0.0
    assert r["confidence"] == 0.12, r["confidence"]   # (1/3)*0.64*0.55
    return True


# 11. all UNKNOWN
def test_all_unknown():
    r = engine().score_record(
        _rec(traffic="UNKNOWN", weather="UNKNOWN", road_cond="UNKNOWN",
             road_risk="UNKNOWN"))
    assert r["overall_score"] == "UNKNOWN", r["overall_score"]
    assert r["suitability_category"] == "UNKNOWN", r["suitability_category"]
    assert r["confidence"] == 0.05, r["confidence"]   # floor
    return True


# 12. mock-data confidence (mock < manual < live)
def test_mock_data_confidence():
    c_mock = compute_confidence(3, 0, ["mock", "mock", "mock"],
                                {"confidence": {
                                    "mode_factors": {"live": 1.0, "manual": 0.85,
                                                     "mock": 0.55, "unknown": 0.25},
                                    "unknown_layer_penalty": 0.8, "floor": 0.05}})
    c_manual = compute_confidence(3, 0, ["manual", "manual", "manual"],
                                  {"confidence": {
                                      "mode_factors": {"live": 1.0, "manual": 0.85,
                                                       "mock": 0.55, "unknown": 0.25},
                                      "unknown_layer_penalty": 0.8, "floor": 0.05}})
    c_live = compute_confidence(3, 0, ["live", "live", "live"],
                                {"confidence": {
                                    "mode_factors": {"live": 1.0, "manual": 0.85,
                                                     "mock": 0.55, "unknown": 0.25},
                                    "unknown_layer_penalty": 0.8, "floor": 0.05}})
    assert c_mock == 0.55, c_mock
    assert c_manual == 0.85, c_manual
    assert c_live == 1.0, c_live
    assert c_mock < c_manual < c_live
    return True


# 13. score range 0-100 for all combos
def test_score_range():
    combos = [("LOW", "LOW", "LOW"), ("CONGESTED", "HIGH", "HIGH"),
              ("HEAVY", "MODERATE", "HIGH"), ("MODERATE", "LOW", "HIGH")]
    for t, wth, rd in combos:
        val = float(score_of(_rec(traffic=t, weather=wth, road_risk=rd)))
        assert 0.0 <= val <= 100.0, (t, wth, rd, val)
        assert val == round(val, 1)
    return True


# 14. suitability category mapping
def test_suitability_mapping():
    expected = {100.0: "GOOD", 80.0: "GOOD", 79.0: "MODERATE",
                60.0: "MODERATE", 59.0: "CAUTION", 40.0: "CAUTION",
                39.0: "POOR", 20.0: "POOR", 19.0: "VERY_POOR",
                0.0: "VERY_POOR", None: "UNKNOWN"}
    for val, label in expected.items():
        assert suitability(val) == label, (val, suitability(val))
    return True


# 15. deterministic repeated calculation
def test_determinism():
    eng = engine()
    rec = _rec(traffic="MODERATE", weather="HIGH", road_cond="POOR",
               road_risk="HIGH")
    a = eng.score_record(rec)
    b = eng.score_record(rec)
    assert a == b, "identical inputs must give identical outputs"
    return True


# 16. explanation/reason generation
def test_reason_generation():
    r = engine().score_record(
        _rec(traffic="MODERATE", weather="LOW", road_cond="MODERATE",
             road_risk="MODERATE"))
    reason = r["reason"]
    assert "prototype road suitability score" in reason, reason
    assert "MODERATE" in reason        # traffic + road risk labels
    assert "LOW" in reason             # weather label
    assert "75.8/100" in reason, reason
    assert "confidence" in reason
    assert "renormalized over 3 known layer(s)" in reason
    return True


# 17. weight normalization when UNKNOWN exists (pure helper)
def test_weight_renormalization():
    scores = {
        "traffic": (70.0, 40.0, True),
        "weather": (None, 0.0, False),
        "road": (100.0, 35.0, True),
    }
    score, eff = compute_overall(scores)
    assert score == 84.0, score                 # (70*40 + 100*35) / 75
    assert abs(eff["traffic"] + eff["road"] - 100.0) < 0.05
    assert abs(eff["traffic"] - 53.33) < 0.05
    assert abs(eff["road"] - 46.67) < 0.05
    return True


ALL_TESTS = [
    ("all LOW inputs",                  test_all_low),
    ("moderate traffic",                test_moderate_traffic),
    ("heavy traffic",                   test_heavy_traffic),
    ("congested traffic",               test_congested_traffic),
    ("moderate weather",                test_moderate_weather),
    ("high weather impact",             test_high_weather),
    ("poor road",                       test_poor_road),
    ("high road risk",                  test_high_road_risk),
    ("one UNKNOWN layer",               test_one_unknown_layer),
    ("two UNKNOWN layers",              test_two_unknown_layers),
    ("all UNKNOWN",                     test_all_unknown),
    ("mock-data confidence",            test_mock_data_confidence),
    ("score range 0-100",               test_score_range),
    ("suitability category mapping",    test_suitability_mapping),
    ("deterministic repeated calc",     test_determinism),
    ("explanation/reason generation",   test_reason_generation),
    ("weight renormalization",          test_weight_renormalization),
]


def run_all():
    passed = 0
    print("=" * 60)
    print("  PHASE 9D ROAD SCORING MODULE TESTS")
    print("=" * 60)
    for name, fn in ALL_TESTS:
        try:
            r = fn()
            if r is True:
                passed += 1
                print(f"  PASS  {name}")
            else:
                print(f"  FAIL  {name}  (returned {r!r})")
        except Exception as exc:
            print(f"  FAIL  {name}  {repr(exc)}")
    print("-" * 60)
    print(f"  {passed}/{len(ALL_TESTS)} tests passed")
    print("=" * 60)
    return passed == len(ALL_TESTS)


if __name__ == "__main__":
    sys.exit(0 if run_all() else 1)