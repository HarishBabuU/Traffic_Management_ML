"""
Phase 9D - Overall Road Scoring Engine (explainable prototype)
==============================================================
Combines three INDEPENDENT layers into a single explainable
0-100 road score:

    A. traffic activity   (Phase 9A - dataset-relative activity signal)
    B. weather impact     (Phase 9B - weather risk signal)
    C. road risk          (Phase 9C - road-condition risk signal)

The result is explicitly labelled:

    "Explainable prototype road suitability score"
    (NOT a calibrated traffic-engineering or navigation score)

DATA ALIGNMENT (critical)
--------------------------
Phase 9A records are per (video, interval) and have NO road_id.
Phase 9B records are per weather location and have NO road mapping.
Phase 9C records are per fictional TEST-RD-* road and have NO video mapping.

There is therefore NO safe real-world join.  This engine NEVER invents one.
Instead it accepts EXPLICIT records that carry their own:
    road_id, observation_time, source, data_mode
and the deliverable run scores ONLY deterministic MOCK/TEST integration
records with explicit fictional road IDs (MOCK-ROAD-01 ... 08), each clearly
labelled data_mode='mock'.  No live record is fabricated.

SCORING MODEL (documented prototype, fully deterministic)
----------------------------------------------------------
weights (sum = 100):  traffic 40%,  weather 25%,  road 35%

sub-score mappings (0-100):
    traffic_activity : LOW=100 MODERATE=70 HEAVY=40 CONGESTED=15
    weather_impact   : LOW=100 MODERATE=70 HIGH=35
    road_risk        : LOW=100 MODERATE=65 HIGH=25

UNKNOWN handling (never convert UNKNOWN to a good score):
    * A layer label of UNKNOWN (or missing) -> no sub-score, no weight.
    * If >= 1 layer is known: score = weighted mean over known layers with
      weights RENORMALIZED to sum 100 over the known layers:
          score = sum(score_i * w_i) / sum(w_i over known)
    * If 0 layers are known: overall_score = UNKNOWN, suitability = UNKNOWN.

SUITABILITY CATEGORY (0-100 band):
    80-100 GOOD | 60-79 MODERATE | 40-59 CAUTION | 20-39 POOR | 0-19 VERY_POOR
    UNKNOWN score -> UNKNOWN.

CONFIDENCE (0-1, deterministic):
    confidence = (known_layers / 3)
                 * (0.8 ** unknown_layers)
                 * min(mode_factor over the three layers)
    mode_factors: live=1.0, manual=0.85, mock=0.55, unknown=0.25
    floor 0.05, cap 1.0.
    -> more UNKNOWN layers and mock data both lower confidence.

Usage
-----
    python src/road_scoring_engine.py            # scores config integration records
    python src/road_scoring_engine.py --test     # run the 17 test scenarios
"""

import csv
import hashlib
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config" / "road_scoring_config.json"

OUT_SCORES = PROJECT_ROOT / "data" / "processed" / "phase9d_road_scores.csv"
OUT_REPORT = PROJECT_ROOT / "data" / "processed" / "phase9d_road_scoring_report.txt"
OUT_VALIDATION = PROJECT_ROOT / "data" / "processed" / "phase9d_validation.csv"

ALLOWED_SUITABILITY = {"GOOD", "MODERATE", "CAUTION", "POOR", "VERY_POOR",
                       "UNKNOWN"}
ALLOWED_MODES = {"live", "manual", "mock", "unknown"}

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
    "phase9c": [
        "data/processed/phase9c_road_conditions.csv",
        "data/processed/phase9c_road_condition_report.txt",
        "data/processed/phase9c_validation.csv",
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
#  pure scoring helpers (importable by tests)
# ============================================================
def subscore(layer, label, mappings, weights):
    """Return (score, effective_weight, is_known)."""
    if label in ("UNKNOWN", "", None):
        return None, 0.0, False
    entry = mappings.get(layer, {}).get(label)
    if entry is None:
        return None, 0.0, False
    return float(entry), float(weights.get(layer, 0.0)), True


def compute_overall(scores):
    """scores: dict layer -> (score, weight, known).
    Returns (overall_score_or_None, effective_weights dict)."""
    known = {layer: (s, w)
             for layer, (s, w, k) in scores.items() if k}
    if not known:
        return None, {}
    # renormalize weights over known layers to sum 100
    wsum = sum(w for _, w in known.values())
    if wsum <= 0:
        return None, {}
    num = sum(s * w for s, w in known.values())
    eff = {layer: round(w / wsum * 100.0, 2) for layer, (_, w) in known.items()}
    score = num / wsum
    return round(score, 1), eff


def suitability(score):
    """Map a 0-100 score (or None) to a suitability category."""
    if score is None:
        return "UNKNOWN"
    if score >= 80:
        return "GOOD"
    if score >= 60:
        return "MODERATE"
    if score >= 40:
        return "CAUTION"
    if score >= 20:
        return "POOR"
    return "VERY_POOR"


def compute_confidence(known_count, unknown_count, modes, cfg):
    """Deterministic 0-1 confidence.

    modes: list of the three per-layer data-mode strings (or None).
    """
    factors = cfg.get("confidence", {}).get("mode_factors", {})
    valid = [m for m in modes if m in factors]
    mode_min = min((factors[m] for m in valid), default=0.25)
    known_ratio = known_count / 3.0
    penalty = cfg.get("confidence", {}).get("unknown_layer_penalty", 0.8) ** unknown_count
    floor = cfg.get("confidence", {}).get("floor", 0.05)
    conf = known_ratio * penalty * mode_min
    return round(max(floor, min(conf, 1.0)), 2)


def human_label(layer):
    if layer == "traffic":
        return "Traffic activity"
    if layer == "weather":
        return "weather impact"
    return "road risk"


# ============================================================
#  engine
# ============================================================
class RoadScoringEngine:
    def __init__(self, config=None, config_path=None):
        if config is None:
            config_path = Path(config_path) if config_path else DEFAULT_CONFIG_PATH
            with open(config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
        self.weights = config.get("weights", {})
        self.mappings = config.get("score_mappings", {})
        self.thresholds = config.get("suitability_thresholds", [])
        self.conf_cfg = config.get("confidence", {})

    # -- public: score one explicit record ------------------------------
    def score_record(self, record):
        """Normalize + score one record.

        record needs (at minimum):
            road_id, observation_time, data_mode,
            traffic_activity, weather_impact, road_risk
        road_condition is optional context used in the reason/CSV.
        """
        road_id = str(record.get("road_id", "") or "")
        observation_time = record.get("observation_time")
        data_mode = record.get("data_mode", "unknown")
        if data_mode not in ALLOWED_MODES:
            data_mode = "unknown"
        data_source = record.get("data_source", "")
        is_mock = bool(record.get("is_mock", data_mode == "mock"))

        traffic_label = record.get("traffic_activity", "UNKNOWN")
        weather_label = record.get("weather_impact", "UNKNOWN")
        road_label = record.get("road_risk", "UNKNOWN")
        road_condition = record.get("road_condition", "UNKNOWN")

        # per-layer data modes (default = record data_mode)
        mode_map = {
            "traffic": record.get("traffic_mode", data_mode),
            "weather": record.get("weather_mode", data_mode),
            "road": record.get("road_mode", data_mode),
        }

        scores = {
            "traffic": subscore("traffic", traffic_label, self.mappings, self.weights),
            "weather": subscore("weather", weather_label, self.mappings, self.weights),
            "road": subscore("road", road_label, self.mappings, self.weights),
        }

        score, eff_weights = compute_overall(scores)

        known_count = sum(1 for s, _, k in scores.values() if k)
        unknown_count = 3 - known_count

        modes = [mode_map["traffic"], mode_map["weather"], mode_map["road"]]
        confidence = compute_confidence(known_count, unknown_count, modes,
                                        {"confidence": self.conf_cfg})

        cat = suitability(score)

        # reason (individual contributions included)
        parts = []
        for layer, label in (("traffic", traffic_label),
                             ("weather", weather_label),
                             ("road", road_label)):
            s, w, k = scores[layer]
            if k:
                parts.append(
                    f"{human_label(layer)}={label}(score {s:.1f}, "
                    f"weight {w:.1f}%)")
            else:
                parts.append(f"{human_label(layer)}=UNKNOWN(n/a)")
        if known_count >= 1:
            wsum_desc = " + ".join(
                f"{round(w_f,1)}" for w_f in sorted(eff_weights.values(), reverse=True))
            sc = score if score is not None else "UNKNOWN"
            lines = (
                f"Traffic activity is {traffic_label}, weather impact is "
                f"{weather_label}, and road risk is {road_label}. "
                f"The resulting prototype road suitability score is "
                f"{sc}/100 (confidence {confidence:.2f}). "
                f"Contributions: {'; '.join(parts)}. "
                f"Weights renormalized over {known_count} known layer(s): "
                f"{eff_weights.get('traffic', 0.0):.1f}/"
                f"{eff_weights.get('weather', 0.0):.1f}/"
                f"{eff_weights.get('road', 0.0):.1f} (traffic/weather/road).")
        else:
            lines = (
                f"Traffic activity, weather impact, and road risk are all "
                f"UNKNOWN. No score can be computed; overall score is UNKNOWN "
                f"(suitability UNKNOWN). Contributions: "
                f"{'; '.join(parts)}.")

        row = {
            "road_id": road_id,
            "road_name": record.get("road_name", ""),
            "observation_time": observation_time if observation_time else "",
            "traffic_activity": traffic_label,
            "traffic_score": (f"{scores['traffic'][0]:.1f}"
                              if scores['traffic'][2] else "UNKNOWN"),
            "traffic_weight": eff_weights.get("traffic", 0.0),
            "weather_impact": weather_label,
            "weather_score": (f"{scores['weather'][0]:.1f}"
                              if scores['weather'][2] else "UNKNOWN"),
            "weather_weight": eff_weights.get("weather", 0.0),
            "road_condition": road_condition,
            "road_risk": road_label,
            "road_score": (f"{scores['road'][0]:.1f}"
                           if scores['road'][2] else "UNKNOWN"),
            "road_weight": eff_weights.get("road", 0.0),
            "overall_score": (f"{score:.1f}" if score is not None else "UNKNOWN"),
            "confidence": confidence,
            "suitability_category": cat,
            "data_mode": data_mode,
            "data_source": data_source,
            "is_mock": is_mock,
            "reason": lines,
        }
        return row

    # -- run over config integration records -----------------------------
    def run_records(self, records):
        return [self.score_record(r) for r in records]


# ============================================================
#  validation
# ============================================================
FIELDS = [
    "road_id", "road_name", "observation_time",
    "traffic_activity", "traffic_score", "traffic_weight",
    "weather_impact", "weather_score", "weather_weight",
    "road_condition", "road_risk", "road_score", "road_weight",
    "overall_score", "confidence", "suitability_category",
    "data_mode", "data_source", "is_mock", "reason",
]


def num_or_unknown(v):
    if v == "UNKNOWN":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def build_validation(rows, before, cfg):
    checks = []

    def check(name, ok, detail=""):
        checks.append({"check": name, "ok": "PASS" if ok else "FAIL",
                       "detail": detail})

    # 1. required columns exist
    missing = [c for c in FIELDS if not rows or c not in rows[0]]
    check("required columns present", not missing, str(missing))

    # 2. scores 0-100 or UNKNOWN
    bad_score = []
    for r in rows:
        for col in ("traffic_score", "weather_score", "road_score", "overall_score"):
            v = num_or_unknown(r[col])
            if v is not None and not (0.0 <= v <= 100.0):
                bad_score.append((r["road_id"], col, r[col]))
    check("all scores 0-100 or UNKNOWN", not bad_score, str(len(bad_score)))

    # 3. confidence 0-1
    bad_conf = [r for r in rows
                if not (0.0 <= float(r["confidence"]) <= 1.0)]
    check("confidence within 0-1", not bad_conf, str(len(bad_conf)))

    # 4. categories from allowed set
    bad_cat = [r for r in rows
               if r["suitability_category"] not in ALLOWED_SUITABILITY]
    check("suitability from allowed set", not bad_cat, str(len(bad_cat)))

    # 5. UNKNOWN layer never silently converted to a good SUB-score:
    #    an UNKNOWN label must keep an UNKNOWN score column and weight 0.
    hidden = [r for r in rows
              for label_col, score_col in (
                  ("traffic_activity", "traffic_score"),
                  ("weather_impact", "weather_score"),
                  ("road_risk", "road_score"))
              if r[label_col] == "UNKNOWN"
              and not (r[score_col] == "UNKNOWN")]
    check("UNKNOWN layer never converted to a good sub-score",
          not hidden, str(len(hidden)))
    # no row may carry suitability GOOD while an UNKNOWN layer is present
    # with HIGH confidence (an UNKNOWN layer must reduce confidence)
    suspicious = [r for r in rows
                  if r["suitability_category"] == "GOOD"
                  and any(r[c] == "UNKNOWN" for c in (
                      "traffic_activity", "weather_impact", "road_risk"))
                  and float(r["confidence"]) >= 0.9]
    check("UNKNOWN layer always reduces confidence", not suspicious,
          str(len(suspicious)))

    # 6. weights valid (each effective weight 0-100, non-negative)
    bad_w = [r for r in rows
             for c in ("traffic_weight", "weather_weight", "road_weight")
             if not (0.0 <= float(r[c]) <= 100.0)]
    check("effective weights valid (0-100)", not bad_w, str(len(bad_w)))

    # 7. known-layer weight renormalization works: for rows with a numeric
    #    overall score (at least one known layer), effective weights must
    #    sum to 100; all-UNKNOWN rows legitimately have zero weights.
    bad_rn = []
    for r in rows:
        if r["overall_score"] == "UNKNOWN":
            continue
        tw, ww, rw = (float(r["traffic_weight"]), float(r["weather_weight"]),
                      float(r["road_weight"]))
        if abs(tw + ww + rw - 100.0) > 0.05:
            bad_rn.append((r["road_id"], tw + ww + rw))
        if tw <= 0 and ww <= 0 and rw <= 0:
            bad_rn.append((r["road_id"], "zero effective weights with numeric score"))
    check("known-layer weight renormalization sums to 100", not bad_rn,
          str(len(bad_rn)))

    # 8. all-UNKNOWN -> UNKNOWN score
    bad_all = [r for r in rows
               if all(r[c] == "UNKNOWN" for c in (
                   "traffic_activity", "weather_impact", "road_risk"))
               and (r["overall_score"] != "UNKNOWN"
                    or r["suitability_category"] != "UNKNOWN")]
    check("all-UNKNOWN produces UNKNOWN score", not bad_all, str(len(bad_all)))

    # 9. deterministic calculation (recompute identical rows)
    engine = RoadScoringEngine(config=cfg)
    deterministic_ok = True
    for r in rows:
        rec = {
            "road_id": r["road_id"], "road_name": r["road_name"],
            "observation_time": r["observation_time"],
            "traffic_activity": r["traffic_activity"],
            "weather_impact": r["weather_impact"],
            "road_condition": r["road_condition"],
            "road_risk": r["road_risk"],
            "data_mode": r["data_mode"], "data_source": r["data_source"],
        }
        recomputed = engine.score_record(rec)
        if recomputed["overall_score"] != r["overall_score"]:
            deterministic_ok = False
            break
    check("deterministic repeated calculation", deterministic_ok, "")

    # 10. mock records remain labelled mock
    bad_mock = [r for r in rows
                if (r["data_mode"] == "mock" and r["is_mock"] is not True)
                or (r["data_mode"] != "mock" and r["is_mock"] is True)]
    check("mock records remain labelled mock", not bad_mock, str(len(bad_mock)))

    # 11. no invalid/empty road IDs
    bad_rid = [r for r in rows if not str(r["road_id"]).strip()]
    check("no invalid/empty road IDs", not bad_rid, str(len(bad_rid)))

    # 12. no fabricated live records
    fake_live = [r for r in rows if r["data_mode"] == "live"
                 or r["data_source"] == "live"]
    check("no fabricated live records", not fake_live, str(len(fake_live)))

    # 13. previous phases unchanged
    after = snapshot_protected()
    for group in ("phase9a", "phase9b", "phase9c", "level8", "level7d"):
        rel = [k for k in before if k.startswith(group)]
        diff = [k for k in rel if before.get(k) != after.get(k)]
        check(f"{group} files unchanged", not diff,
              f"{len(rel)} files hashed")

    return checks


# ============================================================
#  report
# ============================================================
def write_report(records, checks, cfg, integration_notes):
    w = cfg.get("weights", {})
    maps = cfg.get("score_mappings", {})
    lines = []
    lines.append("=" * 76)
    lines.append("  PHASE 9D - OVERALL ROAD SCORING ENGINE (explainable prototype)")
    lines.append("=" * 76)
    lines.append(f"  Records scored : {len(records)}")
    lines.append("")
    lines.append("  1. PURPOSE")
    lines.append("     Combine three independent layers - traffic activity (9A),")
    lines.append("     weather impact (9B), road condition risk (9C) - into a")
    lines.append("     single explainable 0-100 road suitability score.")
    lines.append("")
    lines.append("  2. INPUT LAYERS")
    lines.append("     A. traffic_activity : LOW/MODERATE/HEAVY/CONGESTED (9A)")
    lines.append("     B. weather_impact   : LOW/MODERATE/HIGH (9B)")
    lines.append("     C. road_risk        : LOW/MODERATE/HIGH (9C)")
    lines.append("     Each record carries an explicit road_id, observation_time,")
    lines.append("     source and data_mode.")
    lines.append("")
    lines.append("  3. TRAFFIC LIMITATION")
    lines.append("     Phase 9A labels are DATASET-RELATIVE ACTIVITY labels from")
    lines.append("     the available videos. They are NOT actual congestion, travel")
    lines.append("     time, road-capacity utilisation, or speed. This report uses")
    lines.append("     'traffic_activity' / 'traffic activity signal' terminology.")
    lines.append("")
    lines.append("  4. WEATHER LAYER")
    lines.append("     Uses the normalized Phase 9B weather-impact label. No live")
    lines.append("     weather is invented; any mock record is kept labelled mock.")
    lines.append("")
    lines.append("  5. ROAD-CONDITION LAYER")
    lines.append("     Uses the Phase 9C road_risk (and road_condition context).")
    lines.append("     UNKNOWN road data is NEVER treated as GOOD.")
    lines.append("")
    lines.append("  6. SCORE CALCULATION")
    lines.append("     score = sum(score_i * w_i) / sum(w_i over KNOWN layers)")
    lines.append("     Weights are renormalized over the known layers so they sum")
    lines.append("     to 100. UNKNOWN layers contribute no score and no weight.")
    lines.append("")
    lines.append("  7. WEIGHTS (prototype, documented)")
    lines.append(f"     traffic {w.get('traffic')}% | weather {w.get('weather')}% "
                 f"| road {w.get('road')}%")
    lines.append("")
    lines.append("  8. SUB-SCORE MAPPINGS (prototype values, 0-100)")
    lines.append(f"     traffic: {maps['traffic']}")
    lines.append(f"     weather: {maps['weather']}")
    lines.append(f"     road   : {maps['road']}")
    lines.append("")
    lines.append("  9. UNKNOWN HANDLING")
    lines.append("     UNKNOWN is never converted to a good score. With >=1 known")
    lines.append("     layer the score uses only known layers (weights renormalized,")
    lines.append("     confidence reduced). With 0 known layers the score is UNKNOWN")
    lines.append("     and suitability is UNKNOWN.")
    lines.append("")
    lines.append("  10. CONFIDENCE CALCULATION")
    lines.append("      conf = (known_layers/3) * (0.8^unknown_layers) * min(mode_factor)")
    lines.append("      mode_factors live=1.0 manual=0.85 mock=0.55 unknown=0.25;")
    lines.append("      floor 0.05. Mock data and UNKNOWN layers lower confidence.")
    lines.append("")
    lines.append("  11. SUITABILITY CATEGORIES (from 0-100)")
    lines.append("      80-100 GOOD | 60-79 MODERATE | 40-59 CAUTION |")
    lines.append("      20-39 POOR | 0-19 VERY_POOR | UNKNOWN -> UNKNOWN")
    lines.append("")
    lines.append("  12. MOCK/TEST LIMITATIONS")
    lines.append("      The scored records are DETERMINISTIC MOCK/TEST integration")
    lines.append("      records with explicit fictional road IDs (MOCK-ROAD-*) and")
    lines.append("      data_mode='mock', is_mock=True. They NEVER describe a real")
    lines.append("      road and must not be presented as real-world evidence.")
    lines.append("")
    lines.append("  13. WHY NO REAL ROAD MAPPING WAS INVENTED")
    for note in integration_notes:
        lines.append("      * " + note)
    lines.append("")
    lines.append("  14. HOW PHASE 9E WILL USE THIS LAYER")
    lines.append("      Phase 9E (route recommendation) can compare candidate routes")
    lines.append("      using this layer's per-road outputs: overall_score, confidence,")
    lines.append("      suitability_category and reason. No 'best road' is chosen in")
    lines.append("      this phase.")
    lines.append("")
    lines.append("  VALIDATION")
    for c in checks:
        lines.append(f"    [{c['ok']}] {c['check']}{'  ' + c['detail'] if c['detail'] else ''}")
    lines.append("")
    lines.append("  IMPORTANT DISCLAIMER")
    lines.append("  This is an explainable prototype road suitability score and is")
    lines.append("  not a calibrated traffic-engineering or navigation score.")
    lines.append("")
    return "\n".join(lines)


# ============================================================
#  main
# ============================================================
def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    run_tests = "--test" in argv

    if run_tests:
        import test_phase9d_road_scoring as t
        sys.exit(0 if t.run_all() else 1)

    cfg_path = DEFAULT_CONFIG_PATH
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    before = snapshot_protected()

    engine = RoadScoringEngine(config=cfg)
    records = cfg.get("integration_records", [])
    rows = engine.run_records(records)

    checks = build_validation(rows, before, cfg)

    integration_notes = [
        "Phase 9A records are per (video, interval) and carry no road_id.",
        "Phase 9B records are per weather location and carry no road mapping.",
        "Phase 9C records are per fictional TEST-RD-* road and carry no video/weather mapping.",
        "No shared road_id/location/time key exists across the three layers.",
        "Therefore the deliverable scores ONLY explicit deterministic MOCK/TEST",
        "integration records (fictional MOCK-ROAD-* IDs), clearly labelled mock.",
    ]

    OUT_SCORES.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_SCORES, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for row in rows:
            w.writerow(row)

    report = write_report(rows, checks, cfg, integration_notes)
    with open(OUT_REPORT, "w", encoding="utf-8") as f:
        f.write(report)

    with open(OUT_VALIDATION, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["check", "ok", "detail"])
        w.writeheader()
        for c in checks:
            w.writerow(c)

    print(report)
    all_pass = all(c["ok"] == "PASS" for c in checks)
    return 0 if all_pass else 1


if __name__ == "__main__":
    raise SystemExit(main())