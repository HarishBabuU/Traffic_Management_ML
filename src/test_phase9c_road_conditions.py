"""
Phase 9C - Road Condition Module Tests (12 required scenarios)
==============================================================
Run:
    python src/test_phase9c_road_conditions.py

Or via the engine:
    python src/road_condition_engine.py --test

All tests are OFFLINE (no network).  They exercise the scoring
and normalization logic directly.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from road_condition_engine import normalize_record, score_record


def _record(**overrides):
    base = {
        "road_id": "TEST",
        "road_name": "Test",
        "latitude": 0.0,
        "longitude": 0.0,
        "observation_time": "2026-01-01T00:00:00+00:00",
        "data_mode": "mock",
        "data_source": "deterministic-mock",
        "data_provider": "deterministic-mock",
        "is_mock": True,
        "fallback_reason": "",
        "road_surface": "GOOD",
        "road_surface_score": 85.0,
        "construction_status": "NONE",
        "closure_status": "OPEN",
        "flooding_status": "NONE",
        "incident_status": "NONE",
    }
    base.update(overrides)
    return normalize_record(base)


# 1. GOOD road
def test_good_road():
    r = _record()
    overall, risk, confidence, reason = score_record(r)
    assert overall == "GOOD", overall
    assert risk == "LOW", risk
    assert confidence >= 0.5, confidence         # mock factor applies (0.6)
    assert "penalty 0" in reason
    return True


# 2. MODERATE road
def test_moderate_road():
    r = _record(road_surface="MODERATE")
    overall, risk, confidence, _ = score_record(r)
    assert overall == "MODERATE", overall
    assert risk == "MODERATE", risk
    assert confidence >= 0.5, confidence
    return True


# 3. POOR road
def test_poor_road():
    r = _record(road_surface="POOR")
    overall, risk, _, _ = score_record(r)
    assert overall == "POOR", overall
    assert risk == "HIGH", risk
    return True


# 4. ACTIVE construction
def test_active_construction():
    r = _record(construction_status="ACTIVE")
    overall, risk, _, _ = score_record(r)
    assert overall == "MODERATE", overall
    assert risk == "MODERATE", risk
    return True


# 5. PARTIAL closure
def test_partial_closure():
    r = _record(closure_status="PARTIAL")
    overall, risk, _, reason = score_record(r)
    assert overall == "RESTRICTED", overall
    assert risk == "HIGH", risk
    assert "closure=PARTIAL" in reason
    return True


# 6. CLOSED road
def test_closed_road():
    r = _record(closure_status="CLOSED")
    overall, risk, _, reason = score_record(r)
    assert overall == "RESTRICTED", overall
    assert risk == "HIGH", risk
    assert "closure=CLOSED" in reason
    return True


# 7. flooding (SEVERE and POSSIBLE)
def test_flooding():
    r_severe = _record(flooding_status="SEVERE")
    o1, risk1, _, _ = score_record(r_severe)
    assert o1 == "RESTRICTED" and risk1 == "HIGH"

    r_possible = _record(flooding_status="POSSIBLE")
    o2, _, _, _ = score_record(r_possible)
    assert o2 == "MODERATE", o2
    return True


# 8. reported incident
def test_reported_incident():
    r = _record(incident_status="REPORTED")
    overall, risk, _, _ = score_record(r)
    assert overall == "MODERATE", overall
    assert risk == "MODERATE", risk
    return True


# 9. UNKNOWN road condition (all fields UNKNOWN)
def test_all_unknown():
    r = _record(
        road_surface="UNKNOWN", road_surface_score=None,
        construction_status="UNKNOWN",
        closure_status="UNKNOWN",
        flooding_status="UNKNOWN",
        incident_status="UNKNOWN",
    )
    overall, risk, confidence, reason = score_record(r)
    assert overall == "UNKNOWN", overall
    assert risk == "UNKNOWN", risk
    assert confidence < 0.5, confidence         # 1.0 * 0.8^5 * 0.6 = 0.196
    assert "unknown(5)" in reason
    return True


# 10. deterministic mock behavior
def test_deterministic_mock():
    from road_condition_provider import RoadConditionProvider
    prov = RoadConditionProvider(config={
        "provider": "manual", "mode": "mock", "allow_mock_fallback": False,
        "test_roads": [{"road_id": "A", "road_name": "A",
                        "latitude": 10.0, "longitude": 20.0,
                        "label": "test"}],
        "manual_records": [],
    })
    a = prov.get_conditions(mode="mock", timestamp="2026-01-01T00:00:00+00:00")
    b = prov.get_conditions(mode="mock", timestamp="2026-01-01T00:00:00+00:00")
    assert a == b, "same inputs -> same mock output"
    c = prov.get_conditions(mode="mock", timestamp="2026-01-02T00:00:00+00:00")
    assert a != c, "different timestamp -> different deterministic output"
    return True


# 11. normalization
def test_normalization():
    raw = {"road_id": "EMPTY", "road_name": "", "latitude": None, "longitude": None}
    rec = normalize_record(raw)
    assert rec["road_surface"] == "UNKNOWN"
    assert rec["construction_status"] == "UNKNOWN"
    assert rec["closure_status"] == "UNKNOWN"
    assert rec["flooding_status"] == "UNKNOWN"
    assert rec["incident_status"] == "UNKNOWN"
    rec2 = normalize_record({"road_surface": "invalid!", "road_id": "X"})
    assert rec2["road_surface"] == "UNKNOWN"
    return True


# 12. explainable reason generation
def test_reason_generation():
    r = _record(road_surface="POOR", flooding_status="SEVERE")
    _, _, _, reason = score_record(r)
    assert "surface=POOR" in reason, reason
    assert "flooding=SEVERE" in reason, reason
    assert "overall=RESTRICTED" in reason, reason
    assert "penalty" in reason
    return True


ALL_TESTS = [
    ("GOOD road",               test_good_road),
    ("MODERATE road",           test_moderate_road),
    ("POOR road",               test_poor_road),
    ("ACTIVE construction",     test_active_construction),
    ("PARTIAL closure",         test_partial_closure),
    ("CLOSED road",             test_closed_road),
    ("flooding",                test_flooding),
    ("reported incident",       test_reported_incident),
    ("all UNKNOWN",             test_all_unknown),
    ("deterministic mock",      test_deterministic_mock),
    ("normalization",           test_normalization),
    ("reason generation",       test_reason_generation),
]


def run_all():
    passed = 0
    print("=" * 60)
    print("  PHASE 9C ROAD CONDITION MODULE TESTS")
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