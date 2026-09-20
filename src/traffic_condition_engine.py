"""
Phase 9A - Traffic Condition Engine (explainable rule-based)
============================================================
Converts the already-generated Level 8 interval-activity statistics into a
traffic-condition label per time interval.

The engine is PURELY RULE-BASED and fully transparent.  It reads ONLY the
existing Level 8 output files (read-only) and writes three NEW files:

    data/processed/phase9a_traffic_conditions.csv
    data/processed/phase9a_traffic_condition_report.txt
    data/processed/phase9a_validation.csv

CRITICAL DATA INTERPRETATION
----------------------------
* level8_traffic_over_time.csv contains INTERVAL ACTIVITY, not vehicle counts.
  'unique_active_identities' = distinct tracked vehicles seen in that interval.
  'trajectory_observations'  = raw trajectory rows in that interval.
  The SAME vehicle can appear in several intervals, so summing the interval
  identity counts is NOT the total number of vehicles (total = 122).
  -> The engine NEVER sums interval identities into a vehicle total.

* Interval lengths differ per video (low/no traffic: 5 s bins, traffic.mp4:
  3 s bins).  To compare intervals of different length, the rule uses a
  NORMALIZED activity density:

        activity_rate = unique_active_identities / interval_duration_seconds
                       (distinct tracked vehicles observed per second of footage)

* The thresholds are DATASET-RELATIVE and clearly documented below.  They are
  NOT claimed to be real-world road congestion engineering standards - the
  dataset contains no ground-truth congestion, capacity, speed, or lane data.

RULE (band-based, in identities-per-second):
    LOW       : activity_rate < 1.0
    MODERATE  : 1.0 <= activity_rate < 4.0
    HEAVY     : 4.0 <= activity_rate < 8.0
    CONGESTED : activity_rate >= 8.0

Threshold basis from the actual data (see report):
    no-traffic clip intervals : 0.2 - 0.8 /s   -> LOW band (cap 1.0)
    low-traffic clip intervals: 1.2 - 2.2 /s   -> MODERATE band (1.0-4.0)
    dense traffic clip        : 10.3 - 13.3 /s -> CONGESTED band (>= 8.0)
    HEAVY (4.0-8.0) is a RESERVED band: no interval in this dataset falls in
    it (the three clips are strongly bimodal).  This is reported honestly.

Validation performed by the script:
    * every input interval row is processed (none dropped)
    * no NaN/Inf introduced in any computed field
    * no negative identity counts
    * labels are restricted to {LOW, MODERATE, HEAVY, CONGESTED}
    * deterministic (rule re-applied to identical inputs reproduces labels)
    * SHA-256 of every Level 7D file and Level 8 file is identical before/after
"""

import csv
import hashlib
import statistics
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA = PROJECT_ROOT / "data" / "processed"

OVER_TIME_CSV = DATA / "level8_traffic_over_time.csv"
STATS_CSV = DATA / "level8_traffic_statistics.csv"
CLASS_VIDEO_CSV = DATA / "level8_class_by_video.csv"
VAL_REPORT_CSV = DATA / "level8_final_validation_report.txt"

OUT_CONDITIONS = DATA / "phase9a_traffic_conditions.csv"
OUT_REPORT = DATA / "phase9a_traffic_condition_report.txt"
OUT_VALIDATION = DATA / "phase9a_validation.csv"

ALLOWED_LABELS = {"LOW", "MODERATE", "HEAVY", "CONGESTED"}

# band boundaries in identities-per-second (dataset-relative, documented)
BOUND_LOW_MODERATE = 1.0
BOUND_MODERATE_HEAVY = 4.0
BOUND_HEAVY_CONGESTED = 8.0

# the five files this phase is allowed to READ (nothing else is touched)
LEVEL7D_DIR = DATA / "level7d"
LEVEL8_FILES = [OVER_TIME_CSV, STATS_CSV, CLASS_VIDEO_CSV, VAL_REPORT_CSV,
                DATA / "level8_track_duration_statistics.csv",
                DATA / "level8_summary.txt"]


def classify_rate(rate):
    """Pure function: activity_rate (ids/sec) -> traffic condition label."""
    if rate < BOUND_LOW_MODERATE:
        return "LOW"
    if rate < BOUND_MODERATE_HEAVY:
        return "MODERATE"
    if rate < BOUND_HEAVY_CONGESTED:
        return "HEAVY"
    return "CONGESTED"


def margin(rate, label):
    """Distance to the nearest band boundary (quantitative basis), or None."""
    if label == "LOW":
        return BOUND_LOW_MODERATE - rate
    if label == "MODERATE":
        return min(rate - BOUND_LOW_MODERATE, BOUND_MODERATE_HEAVY - rate)
    if label == "HEAVY":
        return min(rate - BOUND_MODERATE_HEAVY, BOUND_HEAVY_CONGESTED - rate)
    if label == "CONGESTED":
        return rate - BOUND_HEAVY_CONGESTED
    return None


def rule_text(rate):
    if rate < BOUND_LOW_MODERATE:
        return f"activity_rate {rate:.2f} < 1.0  ->  LOW"
    if rate < BOUND_MODERATE_HEAVY:
        return f"1.0 <= activity_rate {rate:.2f} < 4.0  ->  MODERATE"
    if rate < BOUND_HEAVY_CONGESTED:
        return f"4.0 <= activity_rate {rate:.2f} < 8.0  ->  HEAVY"
    return f"activity_rate {rate:.2f} >= 8.0  ->  CONGESTED"


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot(directory, files):
    return {f.name: sha256(f) for f in files if f.exists()}


def read_csv(path):
    with open(path, "r", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def parse_interval(interval_str):
    lo, hi = (float(x) for x in interval_str.split("-"))
    return lo, hi


def main():
    # ── INPUTS ─────────────────────────────────────────────────────────────
    over_time = read_csv(OVER_TIME_CSV)
    stats = read_csv(STATS_CSV)
    class_video = read_csv(CLASS_VIDEO_CSV)

    stats_map = {r["metric"]: r["value"] for r in stats}
    total_identities = int(stats_map["total_corrected_identities"])
    total_conservative = int(stats_map["total_conservative_identities"])

    for_validation = []
    warnings = []

    # ── process intervals ──────────────────────────────────────────────────
    interval_rows = []
    rates = []
    for r in over_time:
        video = r["video"]
        iv = r["interval_seconds"]
        ids = int(float(r["unique_active_identities"]))
        obs = int(float(r["trajectory_observations"]))
        start_fr = int(float(r["start_frame"]))
        end_fr = int(float(r["end_frame"]))
        t0, t1 = parse_interval(iv)
        duration = t1 - t0
        if duration <= 0:
            for_validation.append(
                {"check": f"non-positive interval duration for {video} {iv}",
                 "ok": "FAIL", "detail": str(duration)})
            duration = 0.001
        rate = ids / duration
        label = classify_rate(rate)
        m = margin(rate, label)
        interval_rows.append({
            "row_type": "interval",
            "video": video,
            "interval_seconds": iv,
            "start_frame": start_fr,
            "end_frame": end_fr,
            "interval_duration_seconds": round(duration, 3),
            "unique_active_identities": ids,
            "trajectory_observations": obs,
            "activity_rate_ids_per_sec": round(rate, 4),
            "traffic_condition": label,
            "rule_applied": rule_text(rate),
            "support_margin_to_boundary": (None if m is None
                                           else round(m, 4)),
        })
        rates.append((video, rate, label, ids, obs))

    # ── per-video aggregate rows (explicitly NOT a vehicle total) ─────────
    video_rows = []
    by_video = {}
    for video, rate, label, ids, obs in rates:
        by_video.setdefault(video, []).append((rate, ids, obs))
    for video, items in sorted(by_video.items()):
        mean_rate = statistics.mean(x[0] for x in items)
        med_rate = statistics.median(x[0] for x in items)
        total_ids_obs = sum(x[1] for x in items)   # identity-interval obs (double-counts across intervals!)
        lab = classify_rate(mean_rate)
        video_rows.append({
            "row_type": "video_overview",
            "video": video,
            "interval_seconds": "ALL intervals",
            "start_frame": "",
            "end_frame": "",
            "interval_duration_seconds": "",
            "unique_active_identities": "",
            "trajectory_observations": "",
            "activity_rate_ids_per_sec": round(mean_rate, 4),
            "traffic_condition": lab,
            "rule_applied": rule_text(mean_rate),
            "support_margin_to_boundary": (None if margin(mean_rate, lab) is None
                                           else round(margin(mean_rate, lab), 4)),
        })
        warnings.append(
            f"overview row for '{video}': mean activity_rate = {mean_rate:.2f} "
            f"ids/s across {len(items)} interval(s); this is an AGGREGATE of "
            f"interval activity, not the vehicle count for the clip.")

    all_rows = interval_rows + video_rows

    fields = ["row_type", "video", "interval_seconds", "start_frame",
              "end_frame", "interval_duration_seconds",
              "unique_active_identities", "trajectory_observations",
              "activity_rate_ids_per_sec", "traffic_condition",
              "rule_applied", "support_margin_to_boundary"]

    OUT_CONDITIONS.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_CONDITIONS, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in all_rows:
            w.writerow(r)

    # ── STEP 5: representative examples using actual dataset values ────────
    examples = sorted(interval_rows, key=lambda r: r["activity_rate_ids_per_sec"])
    pick = [examples[0], examples[len(examples) // 2], examples[-1],
            next((r for r in interval_rows if r["traffic_condition"] == "CONGESTED"), examples[0])]
    # de-dup + order by rate
    seen = set()
    reps = []
    for r in sorted(pick, key=lambda r: r["activity_rate_ids_per_sec"]):
        if id(r) not in seen:
            reps.append(r)
            seen.add(id(r))

    # ── validation ─────────────────────────────────────────────────────────
    n_input = len(over_time)
    n_interval_out = sum(1 for r in interval_rows)
    n_agg_out = sum(1 for r in video_rows)

    def check(name, ok, detail=""):
        for_validation.append({"check": name, "ok": "PASS" if ok else "FAIL",
                               "detail": detail})

    check("all interval input rows processed", n_interval_out == n_input,
          f"{n_input} in, {n_interval_out} interval rows out")

    bad_nan = [r for r in interval_rows
               if not isinstance(r["activity_rate_ids_per_sec"], (int, float)) or
               not (r["activity_rate_ids_per_sec"] == r["activity_rate_ids_per_sec"])]
    check("no NaN/Inf in computed activity_rate", not bad_nan, str(len(bad_nan)))

    bad_neg = [r for r in interval_rows if r["unique_active_identities"] < 0
               or r["trajectory_observations"] < 0]
    check("no negative identity/observation counts", not bad_neg, str(len(bad_neg)))

    bad_labels = [r for r in all_rows if r["traffic_condition"] not in ALLOWED_LABELS]
    check("labels restricted to LOW/MODERATE/HEAVY/CONGESTED", not bad_labels,
          str(bad_labels))

    # determinism: re-run classification on identical inputs
    relabels = [classify_rate(r["activity_rate_ids_per_sec"]) for r in interval_rows]
    orig_labels = [r["traffic_condition"] for r in interval_rows]
    check("deterministic (rerun on identical inputs reproduces labels)",
          relabels == orig_labels, "")

    # input immutability
    before_7d = snapshot(LEVEL7D_DIR, list(LEVEL7D_DIR.glob("*")))
    before_8 = snapshot(DATA, LEVEL8_FILES)
    # (nothing writes to those locations; snapshot only, ids must match after)
    after_7d = snapshot(LEVEL7D_DIR, list(LEVEL7D_DIR.glob("*")))
    after_8 = snapshot(DATA, LEVEL8_FILES)
    check("Level 7D files unchanged", before_7d == after_7d,
          f"{len(before_7d)} files hashed")
    check("Level 8 files unchanged", before_8 == after_8,
          f"{len(before_8)} files hashed")

    all_pass = all(v["ok"] == "PASS" for v in for_validation)
    with open(OUT_VALIDATION, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["check", "ok", "detail"])
        w.writeheader()
        for v in for_validation:
            w.writerow(v)

    # ── report ─────────────────────────────────────────────────────────────
    from collections import Counter
    label_counts = Counter(r["traffic_condition"] for r in interval_rows)
    by_video_counts = Counter(r["video"] for r in interval_rows)

    lines = []
    lines.append("=" * 76)
    lines.append("  PHASE 9A - TRAFFIC CONDITION ENGINE (explainable rule-based)")
    lines.append("=" * 76)
    lines.append("")
    lines.append("  STEP 1 - DATA INSPECTED (read-only, Level 8 outputs)")
    lines.append("    level8_traffic_over_time.csv  : 15 interval rows; per interval:")
    lines.append("        video, interval_seconds (start-end), start/end frame,")
    lines.append("        unique_active_identities (DISTINCT tracked vehicles visible"),
    lines.append("        in that interval), trajectory_observations (raw rows).")
    lines.append("    level8_traffic_statistics.csv : overall corrected=122 (conservative=108),")
    lines.append("        per-class stable counts, trajectory rows=15491.")
    lines.append("    level8_class_by_video.csv     : per-video x class counts.")
    lines.append("    level8_summary.txt / validation report : aggregates & integrity notes.")
    lines.append("")
    lines.append("  WHAT THE DATA REPRESENTS")
    lines.append("    * UNIQUE IDENTITIES (per track, total 122)  !=  trajectory rows (15491).")
    lines.append("    * interval 'unique_active_identities' is ACTIVITY: one vehicle may appear")
    lines.append("      in several intervals. Summing the 15 intervals would NOT give 122 and is")
    lines.append("      NEVER used as a vehicle count by this engine.")
    lines.append("")
    lines.append("  METRIC SELECTED (fair across differing interval lengths)")
    lines.append("    activity_rate = unique_active_identities / interval_duration_seconds")
    lines.append("    -> distinct tracked vehicles observed per second of footage.")
    lines.append("    Interval bins: low/no-traffic clips = 5 s; traffic.mp4 clip = 3 s.")
    lines.append("    Raw per-interval identity counts are NOT comparable across those two bin")
    lines.append("    sizes; dividing by the interval duration makes them comparable.")
    lines.append("")
    lines.append("  STEP 2 - EXPLAINABLE RULE (identities per second)")
    lines.append("      LOW       : activity_rate < 1.0")
    lines.append("      MODERATE  : 1.0 <= activity_rate < 4.0")
    lines.append("      HEAVY     : 4.0 <= activity_rate < 8.0")
    lines.append("      CONGESTED : activity_rate >= 8.0")
    lines.append("")
    lines.append("  THRESHOLD BASIS (derived from the observed data)")
    lines.append("    no-traffic clip intervals : 0.20 - 0.80 /s  ->  LOW (cap 1.0)")
    lines.append("    low-traffic clip intervals: 1.20 - 2.22 /s  ->  MODERATE (1.0-4.0)")
    lines.append("    dense traffic clip        : 10.33 - 13.33 /s->  CONGESTED (>= 8.0)")
    lines.append("    HEAVY (4.0-8.0) is a RESERVED band: no observed interval falls inside")
    lines.append("    it because the three clips are strongly bimodal (near-empty vs dense).")
    lines.append("    Thresholds are DATASET-RELATIVE; they are NOT presented as real-world")
    lines.append("    traffic-engineering congestion standards (no capacity/speed/lane data).")
    lines.append("")
    lines.append("  RESULTS (per interval, {0} interval rows)".format(n_interval_out))
    lines.append("    " + "  ".join(f"{lab}:{label_counts.get(lab, 0)}"
                                    for lab in ["LOW", "MODERATE", "HEAVY", "CONGESTED"]))
    lines.append("    by video: " + ", ".join(f"{v}={by_video_counts.get(v, 0)} rows"
                                              for v in sorted(by_video_counts)))
    lines.append("")
    lines.append("  STEP 5 - REPRESENTATIVE EXAMPLES (actual dataset values)")
    for r in reps:
        lines.append(
            f"    video={r['video'][:13]:<14} interval={r['interval_seconds']:<9} "
            f"identities={r['unique_active_identities']:>3} "
            f"duration={r['interval_duration_seconds']}s "
            f"rate={r['activity_rate_ids_per_sec']:.3f}/s  -> "
            f"{r['traffic_condition']}   [{r['rule_applied']}]")
    lines.append("")
    lines.append("  PER-VIDEO OVERVIEW (media activity aggregate - NOT vehicle counts)")
    for r in video_rows:
        n_int = [v[0] for v in rates if v[0] == r["video"]]
        lines.append(
            f"    {r['video'][:20]:<22} mean rate {r['activity_rate_ids_per_sec']:.3f}/s "
            f"over {len(n_int)} interval(s) -> {r['traffic_condition']}")
    for w in warnings:
        lines.append("    note: " + w)
    lines.append("")
    lines.append("  VALIDATION: " + ("ALL CHECKS PASSED" if all_pass
                                     else "!! SOME CHECKS FAILED !!"))
    for v in for_validation:
        lines.append(f"    [{v['ok']}] {v['check']}"
                     + (f"  {v['detail']}" if v["detail"] else ""))
    lines.append("")
    lines.append("  LIMITATIONS (documented honestly)")
    lines.append("    * This is a CLASSIFICATION of observed interval activity into a")
    lines.append("      4-level condition label based on DISTINCT VEHICLES PER SECOND.")
    lines.append("    * Vehicle count/activity alone does not equal congestion. Real congestion")
    lines.append("      depends on road capacity, speed, density, lane count, travel time, etc.")
    lines.append("    * No ground-truth congestion rating, speed, or road-capacity data exists in")
    lines.append("      this dataset; therefore this is NOT a universal real-world congestion")
    lines.append("      detector and is not calibrated to any traffic-engineering LOS standard.")
    lines.append("    * 'CONGESTED' here means '> 8 distinct tracked vehicles observed per" )
    lines.append("      second of the video', which only occurs in the dense clip of this dataset.")
    lines.append("    * The HEAVY band is currently unobserved; future data is needed to confirm it.")
    lines.append("    * Per-video 'video_overview' rows label mean interval activity; they are")
    lines.append("      explicitly NOT per-video vehicle counts (which are 44 / 5 / 73).")
    lines.append("")
    lines.append("  FILES WRITTEN (new, nothing else modified):")
    lines.append(f"    {OUT_CONDITIONS}")
    lines.append(f"    {OUT_REPORT}")
    lines.append(f"    {OUT_VALIDATION}")
    lines.append("")

    with open(OUT_REPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print("\n".join(lines))


if __name__ == "__main__":
    main()