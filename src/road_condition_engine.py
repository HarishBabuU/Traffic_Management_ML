"""
Phase 9C - Road Condition Engine (explainable rule-based)
========================================================
Consumes NORMALIZED road-condition records (from the Phase 9C provider),
validates them, normalizes missing/unknown values, and produces for each
road an explainable:

    overall_road_condition : GOOD / MODERATE / POOR / RESTRICTED / UNKNOWN
    road_risk              : LOW / MODERATE / HIGH / UNKNOWN
    confidence             : 0.0 - 1.0  (lower when data is UNKNOWN/mock)
    reason                 : human-readable, field-by-field basis

Data integrity rules (strict):
    * This phase NEVER runs YOLO / ByteTrack and NEVER touches raw videos.
    * It reads ONLY new road-condition inputs (config) and writes the three
      NEW phase9c files.  Phase 9A / Phase 9B / Level 8 / Level 7D files are
      protected and verified byte-identical (SHA-256) after every run.
    * No live road-condition provider is configured, so no live data is ever
      claimed.  Records are either 'manual' (user-supplied) or 'mock'
      (deterministic test data).
    * UNKNOWN must never be treated as GOOD: unknown fields reduce confidence
      and can keep overall_road_condition UNKNOWN.

Scoring (deterministic points, fully documented):
    road_surface         : GOOD=0  MODERATE=1  POOR=3  UNKNOWN=0 (unknown-flag)
    construction_status  : NONE=0  ACTIVE=2
    closure_status       : OPEN=0  PARTIAL=4  CLOSED=6
    flooding_status      : NONE=0  POSSIBLE=1 SEVERE=5
    incident_status      : NONE=0  REPORTED=2

    overall_road_condition:
        CLOSED closure or PARTIAL closure  -> RESTRICTED
        SEVERE flooding                    -> RESTRICTED
        else penalty score:
            0              -> GOOD
            1-2            -> MODERATE
            3-4            -> POOR
            >=5            -> RESTRICTED
        BUT if any status value is UNKNOWN, the label is demoted so that
        missing information never yields GOOD/POOR claims:

            n_unknown == 0            -> GOOD/MODERATE/POOR/RESTRICTED (above)
            n_unknown > 0             -> candidate label
                 if candidate == GOOD ->  UNKNOWN   (cannot claim GOOD from gaps)
                 else                  ->  candidate (known bad factors dominate)
            5/5 fields UNKNOWN        -> overall UNKNOWN, road_risk UNKNOWN

    road_risk:
        overall GOOD         -> LOW   (n_unknown == 0 only)
        overall MODERATE     -> MODERATE
        overall RESTRICTED   -> HIGH
        overall POOR         -> HIGH
        overall UNKNOWN      -> UNKNOWN

    confidence:
        1.00 base
        x0.80 per UNKNOWN field
        x0.90 if data_mode == 'manual'   (unverified user/static input)
        x0.60 if data_mode == 'mock'     (test data - never real-world)
        floor 0.05

Usage
-----
    python src/road_condition_engine.py                 # uses config mode
    python src/road_condition_engine.py --mode=mock      # deterministic test data
    python src/road_condition_engine.py --mode=manual
    python src/road_condition_engine.py --test           # run the 12 test scenarios
"""

import csv
import hashlib
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from road_condition_provider import (RoadConditionProvider,
                                     RoadConditionError,
                                     DEFAULT_CONFIG_PATH)

# ============================================================
#  categories (mirror of config; keep source-of-truth here)
# ============================================================
ALLOWED_SURFACE = {"GOOD", "MODERATE", "POOR", "UNKNOWN"}
ALLOWED_CONSTRUCTION = {"NONE", "ACTIVE", "UNKNOWN"}
ALLOWED_CLOSURE = {"OPEN", "PARTIAL", "CLOSED", "UNKNOWN"}
ALLOWED_FLOODING = {"NONE", "POSSIBLE", "SEVERE", "UNKNOWN"}
ALLOWED_INCIDENT = {"NONE", "REPORTED", "UNKNOWN"}
ALLOWED_OVERALL = {"GOOD", "MODERATE", "POOR", "RESTRICTED", "UNKNOWN"}
ALLOWED_RISK = {"LOW", "MODERATE", "HIGH", "UNKNOWN"}
ALLOWED_MODES = {"live", "manual", "mock", "unknown"}

# deterministic penalty points (documented in the docstring above)
SURFACE_PTS = {"GOOD": 0, "MODERATE": 1, "POOR": 3, "UNKNOWN": 0}
CONSTRUCTION_PTS = {"NONE": 0, "ACTIVE": 2, "UNKNOWN": 0}
CLOSURE_PTS = {"OPEN": 0, "PARTIAL": 4, "CLOSED": 6, "UNKNOWN": 0}
FLOODING_PTS = {"NONE": 0, "POSSIBLE": 1, "SEVERE": 5, "UNKNOWN": 0}
INCIDENT_PTS = {"NONE": 0, "REPORTED": 2, "UNKNOWN": 0}

OUT_CONDITIONS = PROJECT_ROOT / "data" / "processed" / "phase9c_road_conditions.csv"
OUT_REPORT = PROJECT_ROOT / "data" / "processed" / "phase9c_road_condition_report.txt"
OUT_VALIDATION = PROJECT_ROOT / "data" / "processed" / "phase9c_validation.csv"

# protected files (must remain byte-identical after every run)
PROTECTED = {
    "phase9a": [
        "data/processed/phase9a_traffic_conditions.csv",
        "data/processed/phase9a_traffic_condition_report.txt",
        "data/processed/phase9a_validation.csv",
    ],
    "phase9b": [
        "data/processed/phase9b_weather.csv",
        "data/processed/phase9b_weather_report.txt",
        "data/processed/phase9b_validation.csv",
    ],
    "level8": [
        "data/processed/level8_traffic_statistics.csv",
        "data/processed/level8_class_by_video.csv",
        "data/processed/level8_track_duration_statistics.csv",
        "data/processed/level8_traffic_over_time.csv",
        "data/processed/level8_summary.txt",
        "data/processed/level8_final_validation_report.txt",
    ],
}
LEVEL7D_GLOB = "data/processed/level7d/*"

# ============================================================
#  normalization / validation
# ============================================================
def normalize_record(raw):
    """Fill missing optional fields with UNKNOWN; missing coords -> NaN flags.

    Always returns a dict with ALL output fields present, so downstream
    scoring never sees KeyError.
    """
    if isinstance(raw, dict):
        get = raw.get
    else:
        get = lambda k, *a: a[0]  # noqa: E731 - tolerate non-dict input

    def norm(val, allowed):
        return val if val in allowed else "UNKNOWN"

    record = {
        "road_id": str(get("road_id", "") or ""),
        "road_name": str(get("road_name", "") or ""),
        "latitude": get("latitude"),
        "longitude": get("longitude"),
        "observation_time": get("observation_time"),
        "data_mode": get("data_mode"),
        "data_source": get("data_source"),
        "data_provider": get("data_provider"),
        "is_mock": bool(get("is_mock", False)),
        "fallback_reason": get("fallback_reason", ""),
        "road_surface": norm(get("road_surface", "UNKNOWN"), ALLOWED_SURFACE),
        "road_surface_score": get("road_surface_score"),
        "construction_status": norm(get("construction_status", "UNKNOWN"), ALLOWED_CONSTRUCTION),
        "closure_status": norm(get("closure_status", "UNKNOWN"), ALLOWED_CLOSURE),
        "flooding_status": norm(get("flooding_status", "UNKNOWN"), ALLOWED_FLOODING),
        "incident_status": norm(get("incident_status", "UNKNOWN"), ALLOWED_INCIDENT),
    }
    return record


def validate_record(record, errors):
    """Append human-readable problems to `errors` (no exceptions thrown)."""
    lat, lon = record["latitude"], record["longitude"]
    if lat is None or lon is None:
        errors.append(f"road '{record['road_id']}': missing coordinates")
    else:
        try:
            lat_f, lon_f = float(lat), float(lon)
            if not (-90.0 <= lat_f <= 90.0):
                errors.append(f"road '{record['road_id']}': latitude out of range")
            if not (-180.0 <= lon_f <= 180.0):
                errors.append(f"road '{record['road_id']}': longitude out of range")
        except (TypeError, ValueError):
            errors.append(f"road '{record['road_id']}': non-numeric coordinates")
    if record["data_mode"] not in ALLOWED_MODES:
        errors.append(f"road '{record['road_id']}': unknown data_mode")
    if record["road_surface_score"] is not None:
        try:
            sc = float(record["road_surface_score"])
            if sc < 0 or sc > 100:
                errors.append(f"road '{record['road_id']}': surface_score out of [0,100]")
        except (TypeError, ValueError):
            errors.append(f"road '{record['road_id']}': non-numeric surface_score")


# ============================================================
#  explainable scoring (pure, deterministic)
# ============================================================
def score_record(record):
    """Return (overall_road_condition, road_risk, confidence, reason)."""
    surface = record["road_surface"]
    construction = record["construction_status"]
    closure = record["closure_status"]
    flooding = record["flooding_status"]
    incident = record["incident_status"]

    p_surface = SURFACE_PTS[surface]
    p_construction = CONSTRUCTION_PTS[construction]
    p_closure = CLOSURE_PTS[closure]
    p_flooding = FLOODING_PTS[flooding]
    p_incident = INCIDENT_PTS[incident]

    unknown_fields = [n for n, v in (
        ("road_surface", surface),
        ("construction_status", construction),
        ("closure_status", closure),
        ("flooding_status", flooding),
        ("incident_status", incident),
    ) if v == "UNKNOWN"]
    n_unknown = len(unknown_fields)

    penalty = p_surface + p_construction + p_closure + p_flooding + p_incident

    # hard overrides -> RESTRICTED
    if closure == "CLOSED":
        overall = "RESTRICTED"
    elif closure == "PARTIAL":
        overall = "RESTRICTED"
    elif flooding == "SEVERE":
        overall = "RESTRICTED"
    else:
        # ALL FIELDS UNKNOWN -> cannot claim any condition
        if n_unknown == 5:
            overall = "UNKNOWN"
        else:
            if penalty == 0:
                overall = "GOOD"
            elif penalty <= 2:
                overall = "MODERATE"
            elif penalty <= 4:
                overall = "POOR"
            else:
                overall = "RESTRICTED"
            # UNKNOWN must never produce a GOOD (or overly optimistic) claim
            if n_unknown > 0 and overall == "GOOD":
                overall = "UNKNOWN"

    # risk (never LOW from an UNKNOWN overall)
    if overall == "RESTRICTED":
        risk = "HIGH"
    elif overall == "POOR":
        risk = "HIGH"
    elif overall == "MODERATE":
        risk = "MODERATE"
    elif overall == "UNKNOWN":
        risk = "UNKNOWN"
    else:  # overall == GOOD
        risk = "LOW" if n_unknown == 0 else "UNKNOWN"

    # confidence (conservative)
    confidence = 1.0
    for _ in range(n_unknown):
        confidence *= 0.80
    if record["data_mode"] == "manual":
        confidence *= 0.90
    elif record["data_mode"] == "mock":
        confidence *= 0.60
    confidence = round(max(0.05, min(confidence, 1.0)), 2)

    bits = [
        f"surface={surface}({p_surface:+d})",
        f"construction={construction}({p_construction:+d})",
        f"closure={closure}({p_closure:+d})",
        f"flooding={flooding}({p_flooding:+d})",
        f"incident={incident}({p_incident:+d})",
    ]
    reason = (
        f"penalty {penalty}; unknown({n_unknown}): "
        + (", ".join(unknown_fields) if unknown_fields else "none")
        + f"; overall={overall}; risk={risk}; "
        + " ".join(bits)
    )
    return overall, risk, confidence, reason


# ============================================================
#  hashing / snapshots
# ============================================================
def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def snapshot_protected():
    snap = {}
    for group, rels in PROTECTED.items():
        for rel in rels:
            p = PROJECT_ROOT / rel
            snap[f"{group}/{Path(rel).name}"] = sha256(p) if p.exists() else None
    for p in sorted(PROJECT_ROOT.glob(LEVEL7D_GLOB)):
        snap[f"level7d/{p.name}"] = sha256(p)
    return snap


# ============================================================
#  output schema
# ============================================================
FIELDS = [
    "road_id", "road_name", "latitude", "longitude", "observation_time",
    "data_mode", "data_source", "data_provider", "is_mock",
    "fallback_reason", "road_surface", "road_surface_score",
    "construction_status", "closure_status", "flooding_status",
    "incident_status", "overall_road_condition", "road_risk",
    "confidence", "reason",
]

# ============================================================
#  validation builder
# ============================================================
def build_validation(records, errors, before, deterministic_ok, mode_used):
    checks = []

    def check(name, ok, detail=""):
        checks.append({"check": name, "ok": "PASS" if ok else "FAIL",
                       "detail": detail})

    check("records processed", bool(records), f"{len(records)} records")

    off_label = [
        r for r in records
        if r["overall_road_condition"] not in ALLOWED_OVERALL
        or r["road_risk"] not in ALLOWED_RISK
        or r["road_surface"] not in ALLOWED_SURFACE
        or r["construction_status"] not in ALLOWED_CONSTRUCTION
        or r["closure_status"] not in ALLOWED_CLOSURE
        or r["flooding_status"] not in ALLOWED_FLOODING
        or r["incident_status"] not in ALLOWED_INCIDENT
    ]
    check("all labels from allowed category sets", not off_label, str(len(off_label)))

    bad_nan = [r for r in records
               if not (isinstance(r["confidence"], (int, float))
                       and 0.0 <= float(r["confidence"]) <= 1.0)]
    check("confidence within [0,1]", not bad_nan, str(len(bad_nan)))

    # UNKNOWN never treated as GOOD
    too_good = [r for r in records
                if r["overall_road_condition"] == "GOOD"
                and (r["road_surface"] == "UNKNOWN"
                     or r["construction_status"] == "UNKNOWN"
                     or r["closure_status"] == "UNKNOWN"
                     or r["flooding_status"] == "UNKNOWN"
                     or r["incident_status"] == "UNKNOWN")]
    check("UNKNOWN data never treated as GOOD",
          not too_good, str(len(too_good)))

    allunknown = [r for r in records
                  if all(r[f] == "UNKNOWN" for f in (
                      "road_surface", "construction_status", "closure_status",
                      "flooding_status", "incident_status"))]
    bad_allunknown = [r for r in allunknown
                      if r["overall_road_condition"] != "UNKNOWN"
                      or r["road_risk"] != "UNKNOWN"]
    check("all-UNKNOWN rows -> UNKNOWN overall + risk",
          not bad_allunknown, f"{len(allunknown)} all-UNKNOWN records")

    # mock/manual/live marking integrity
    bad_mark = [r for r in records
                if (r["data_mode"] == "mock" and r["is_mock"] is not True)
                or (r["data_mode"] in ("manual", "live") and r["is_mock"] is True)
                or (r["data_mode"] == "mock" and r["data_source"] != "deterministic-mock")
                or (r["data_mode"] == "manual" and r["data_source"] != "manual-config")
                or (r["data_mode"] == "live")]
    check("no live records (no live provider configured); mode/source/label consistent",
          not bad_mark, str(len(bad_mark)))

    check("deterministic mock results", deterministic_ok, "")

    if errors:
        for e in errors:
            check("record " + e, False, "")

    # protected-file integrity
    after = snapshot_protected()
    for group in ("phase9a", "phase9b", "level8", "level7d"):
        rel = [k for k in before if k.startswith(group)]
        diff = [k for k in rel if before.get(k) != after.get(k)]
        check(f"{group} files unchanged", not diff,
              f"{len(rel)} files hashed")

    return checks


# ============================================================
#  report writer
# ============================================================
def write_report(records, errors, checks, mode_used, live_unavailable_reason):
    lines = []
    lines.append("=" * 76)
    lines.append("  PHASE 9C - ROAD CONDITION LAYER REPORT")
    lines.append("=" * 76)
    lines.append(f"  Mode used  : {mode_used}")
    lines.append(f"  Records    : {len(records)}")
    lines.append("")
    lines.append("  1. WHAT PHASE 9C DOES")
    lines.append("     A configurable road-condition data layer producing")
    lines.append("     normalized, explainable per-road outputs: surface /")
    lines.append("     construction / closure / flooding / incident status plus")
    lines.append("     overall_road_condition, road_risk, confidence and a reason.")
    lines.append("     It is independent of Phase 9A (traffic), Phase 9B (weather)")
    lines.append("     and the traffic videos; NO association is made to any video.")
    lines.append("")
    lines.append("  2. INPUT SCHEMA")
    lines.append("     config/road_condition_config.json -> test_roads[] and")
    lines.append("     manual_records[] (plus programmatic input). Required fields:")
    lines.append("     road_id, road_name, latitude, longitude; optional status")
    lines.append("     fields default to UNKNOWN and are normalized.")
    lines.append("")
    lines.append("  3. SUPPORTED DATA MODES")
    lines.append("     live   : external source (NOT configured - never fabricated)")
    lines.append("     manual : user-supplied records from config/manual_records")
    lines.append("     mock   : deterministic, reproducible test records")
    lines.append("     unknown: any record that cannot be sourced (data_mode=unknown)")
    lines.append("")
    lines.append("  4. ROAD-CONDITION CATEGORIES")
    lines.append("     road_surface: GOOD | MODERATE | POOR | UNKNOWN")
    lines.append("     construction: NONE | ACTIVE | UNKNOWN")
    lines.append("     closure     : OPEN | PARTIAL | CLOSED | UNKNOWN")
    lines.append("     flooding    : NONE | POSSIBLE | SEVERE | UNKNOWN")
    lines.append("     incident    : NONE | REPORTED | UNKNOWN")
    lines.append("     overall     : GOOD | MODERATE | POOR | RESTRICTED | UNKNOWN")
    lines.append("     road_risk   : LOW | MODERATE | HIGH | UNKNOWN")
    lines.append("")
    lines.append("  5. EXPLAINABLE RISK LOGIC (deterministic points)")
    lines.append("     surface GOOD=0 MODERATE=1 POOR=3 UNKNOWN=0(unknown)")
    lines.append("     construction NONE=0 ACTIVE=2")
    lines.append("     closure OPEN=0 PARTIAL=4 CLOSED=6")
    lines.append("     flooding NONE=0 POSSIBLE=1 SEVERE=5")
    lines.append("     incident NONE=0 REPORTED=2")
    lines.append("     CLOSED/PARTIAL closure or SEVERE flooding -> RESTRICTED.")
    lines.append("     else penalty: 0=GOOD, 1-2=MODERATE, 3-4=POOR, >=5=RESTRICTED.")
    lines.append("     risk: RESTRICTED/POOR=HIGH, MODERATE=MODERATE, GOOD=LOW,")
    lines.append("           UNKNOWN overall=UNKNOWN risk.")
    lines.append("")
    lines.append("  6. HOW UNKNOWN DATA IS HANDLED")
    lines.append("     - Missing fields become UNKNOWN (never GOOD).")
    lines.append("     - A GOOD label is suppressed whenever any field is UNKNOWN.")
    lines.append("     - All-five UNKNOWN -> overall UNKNOWN and risk UNKNOWN.")
    lines.append("     - Confidence falls x0.80 per UNKNOWN field, plus x0.90 for")
    lines.append("       manual and x0.60 for mock data (test data is not treated")
    lines.append("       as real-world evidence).")
    lines.append("")
    lines.append("  7. TEST/MOCK LIMITATIONS")
    lines.append("     Mock records are DETERMINISTIC TEST DATA with fictional")
    lines.append("     coordinates (labelled TEST-RD-*, lat/lon near null island).")
    lines.append("     They exercise every scoring branch but describe NO real")
    lines.append("     road; they must never be presented as real-world conditions.")
    lines.append("")
    lines.append("  8. LIVE DATA STATUS")
    lines.append("     No live road-condition provider is currently configured.")
    if live_unavailable_reason:
        lines.append(f"     Reason: {live_unavailable_reason}")
    lines.append("     The live branch raises RoadConditionError instead of")
    lines.append("     fabricating data; live records will be produced only once")
    lines.append("     a real source (agency feed / sensor API) is integrated.")
    lines.append("")
    lines.append("  9. VALIDATION")
    for c in checks:
        lines.append(f"     [{c['ok']}] {c['check']}{'  ' + c['detail'] if c['detail'] else ''}")
    lines.append("")
    lines.append("  10. PROTECTED-FILE VERIFICATION (SHA-256 before/after)")
    for c in checks:
        if c["check"].endswith("files unchanged"):
            lines.append(f"      {c['check']}: {c['ok']}  ({c['detail']})")
    lines.append("      Raw videos: not opened or rewritten; YOLO/ByteTrack: not run.")
    lines.append("")
    lines.append("  11. CONNECTION TO PHASE 9D (future)")
    lines.append("      Phase 9D will combine three INDEPENDENT layers:")
    lines.append("        traffic activity  (9A) + weather impact (9B)")
    lines.append("        + road condition  (9C)")
    lines.append("      Each layer is already isolated: a road can be scored using the")
    lines.append("      explainable outputs produced here (overall_road_condition, risk,")
    lines.append("      confidence, reason).  This phase does NOT link roads to videos.")
    lines.append("")
    lines.append("  12. FILES CREATED")
    lines.append(f"      {OUT_CONDITIONS}")
    lines.append(f"      {OUT_REPORT}")
    lines.append(f"      {OUT_VALIDATION}")
    lines.append(f"      {PROJECT_ROOT / 'src' / 'road_condition_provider.py'}")
    lines.append(f"      {PROJECT_ROOT / 'src' / 'road_condition_engine.py'}")
    lines.append(f"      {PROJECT_ROOT / 'src' / 'test_phase9c_road_conditions.py'}")
    lines.append(f"      {PROJECT_ROOT / 'config' / 'road_condition_config.json'}")
    lines.append("")
    return "\n".join(lines)


# ============================================================
#  main
# ============================================================
def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    mode = None
    run_tests = False
    if "--test" in argv:
        run_tests = True
        argv = [a for a in argv if a != "--test"]
    for a in argv:
        if a.startswith("--mode="):
            mode = a.split("=", 1)[1]

    if run_tests:
        import test_phase9c_road_conditions as t
        sys.exit(0 if t.run_all() else 1)

    before = snapshot_protected()

    config_path = DEFAULT_CONFIG_PATH
    cfg = json.loads(config_path.read_text(encoding="utf-8"))
    mode_used = mode or cfg.get("mode", "manual")

    provider = RoadConditionProvider(config_path=config_path)

    live_unavailable_reason = ""
    try:
        records = provider.get_conditions(mode=mode_used)
    except RoadConditionError as exc:
        # e.g. attempted live mode without a live provider.
        # Fall back to manual ONLY if the config allows it; never fabricate live.
        live_unavailable_reason = str(exc)
        if mode_used == "live":
            raise SystemExit("cannot run in live mode: " + str(exc))
        records = provider.get_conditions(mode="manual")

    # normalize + validate + score
    errors = []
    output_rows = []
    for raw in records:
        rec = normalize_record(raw)
        validate_record(rec, errors)
        overall, risk, confidence, reason = score_record(rec)
        row = dict(rec)
        row["overall_road_condition"] = overall
        row["road_risk"] = risk
        row["confidence"] = confidence
        row["reason"] = reason
        output_rows.append(row)

    # determinism check: same mock input twice -> identical result
    deterministic_ok = True
    if mode_used == "mock":
        a = provider.get_conditions(mode="mock", timestamp="2026-01-01T00:00:00+00:00")
        b = provider.get_conditions(mode="mock", timestamp="2026-01-01T00:00:00+00:00")
        deterministic_ok = (a == b)

    checks = build_validation(output_rows, errors, before, deterministic_ok,
                              mode_used)
    all_pass = all(c["ok"] == "PASS" for c in checks)

    # write outputs (new files only)
    OUT_CONDITIONS.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_CONDITIONS, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for row in output_rows:
            w.writerow(row)

    report = write_report(output_rows, errors, checks, mode_used,
                          live_unavailable_reason)
    with open(OUT_REPORT, "w", encoding="utf-8") as f:
        f.write(report)

    with open(OUT_VALIDATION, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["check", "ok", "detail"])
        w.writeheader()
        for c in checks:
            w.writerow(c)

    print(report)
    return 0 if all_pass else 1


if __name__ == "__main__":
    raise SystemExit(main())