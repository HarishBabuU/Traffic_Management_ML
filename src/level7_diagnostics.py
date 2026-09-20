"""
Level 7 - Post-Level-6B Track Quality Diagnosis (READ-ONLY)
===========================================================
Diagnoses suspicious / duplicate / class-inconsistent tracks in the VALIDATED
Level 6B corrected dataset. Produces CANDIDATES ONLY - no merges, deletes,
relabels, count changes, or final decisions.

Inputs (read-only, Level 6B):
    data/processed/level6b/level6b_trajectories.csv
    data/processed/level6b/level6b_track_summary.csv

Outputs (NEW, data/processed/level7/):
    level7_track_quality_summary.csv
    level7_short_track_candidates.csv
    level7_spatial_suspicious_candidates.csv
    level7_duplicate_candidates.csv
    level7_class_consistency_candidates.csv
    level7_diagnostic_report.txt

Usage:
    python src/level7_diagnostics.py
"""

import csv
import statistics
from pathlib import Path
from collections import defaultdict

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PROCESSED = PROJECT_ROOT / "data" / "processed"
L6B = PROCESSED / "level6b"
TRAJ_CSV = L6B / "level6b_trajectories.csv"
TRACK_CSV = L6B / "level6b_track_summary.csv"
OUT_DIR = PROCESSED / "level7"

# ──────────────────────────────────────────────────────────────────────
# THRESHOLDS (conservative; documented here and in the report)
# ──────────────────────────────────────────────────────────────────────
# Short tracks
SHORT_TRACK_FRAMES = 4          # flag tracks with frames_tracked or duration <= 4
SHORT_TIER1_FRAMES = 2          # <=2 rows  -> Tier1

# Spatial: net displacement / path / jumps (px, at 1280-1920 px widths)
LITTLE_MOTION_NET_PX = 20       # net displacement below this = "little movement"
LITTLE_MOTION_PATH_PX = 50      # and total path below this
LITTLE_MOTION_MIN_ROWS = 4      # only meaningful for tracks with >= rows
JUMP_TIER2_PX = 150             # single-frame centroid jump >= this AND > 3*median+50
JUMP_TIER1_PX = 300             # single-frame centroid jump >= this (hard overrun)
JUMP_RELATIVE_MULT = 3          # jump > 3 * median jump (discontinuity check)
JUMP_RELATIVE_ADD_PX = 50
ERRATIC_PATH_MIN_PX = 80        # wandering requires this much total path
ERRATIC_RATIO = 3               # path > 3x net displacement = zig-zag / non-linear

# Duplicate identities (same video + same class)
DUP_MIN_OVERLAP_FRAMES = 3
DUP_MEAN_DIST_PX = 50           # flag if mean centroid dist <= this over overlap
DUP_MAX_IOU = 0.45              # flag if max box IoU >= this
DUP_TIER1_MIN_DIST_PX = 10      # min centroid dist <= this  -> Tier1
DUP_TIER1_MAX_IOU = 0.70        # max IoU >= this            -> Tier1
ADJ_GAP_FRAMES = 20             # adjacent-gap continuation candidate window
ADJ_BOUNDARY_DIST_PX = 40       # boundary centroids within this = continuation hint

# Class consistency
CLASS_AGREEMENT_FLAG = 0.90     # raw or stable agreement below this -> candidate


def read_csv(path):
    with open(path, "r", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(rows, name, fieldnames):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUT_DIR / name, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(r)
    return OUT_DIR / name


def fnum(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def inum(v, default=0):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def dist(ax, ay, bx, by):
    return ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5


def box_iou(a, b):
    xa1, ya1, xa2, ya2 = a
    xb1, yb1, xb2, yb2 = b
    ix1, iy1 = max(xa1, xb1), max(ya1, yb1)
    ix2, iy2 = min(xa2, xb2), min(ya2, yb2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, xa2 - xa1) * max(0.0, ya2 - ya1)
    area_b = max(0.0, xb2 - xb1) * max(0.0, yb2 - yb1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def percentiles(values):
    values = sorted(values)
    n = len(values)
    if n == 0:
        return {}
    return {
        "min": values[0],
        "p5": values[max(0, int(0.05 * n) - 1)],
        "p10": values[max(0, int(0.10 * n) - 1)],
        "p25": values[max(0, int(0.25 * n) - 1)],
        "median": values[int(0.50 * n) - 1] if n % 2 == 0
                 else values[n // 2],
        "p75": values[min(n - 1, int(0.75 * n))],
        "p90": values[min(n - 1, int(0.90 * n))],
        "p95": values[min(n - 1, int(0.95 * n))],
        "max": values[-1],
    }


def fmt_pct(p, key):
    return round(p[key], 2) if key in p else 0.0


def main():
    traj_rows = read_csv(TRAJ_CSV)
    track_rows = read_csv(TRACK_CSV)

    # Index trajectories: video -> track_id -> {frame: row}
    traj = defaultdict(lambda: defaultdict(dict))
    for r in traj_rows:
        try:
            fr = int(float(r["frame"]))
        except (TypeError, ValueError):
            continue
        tid = inum(r["track_id"])
        traj[r["video"]][tid][fr] = r

    # ── per-track motion metrics ───────────────────────────────────────────
    quality = []
    for t in track_rows:
        vid = t["video"]
        tid = inum(t["track_id"])
        cls_raw = t["vehicle_class"]
        cls_stab = t["vehicle_class_stable"]
        f0 = inum(t["first_frame"])
        f1 = inum(t["last_frame"])
        duration = f1 - f0 + 1
        rows = traj[vid].get(tid, {})
        frames = sorted(rows.keys())
        n_rows = len(frames)

        net_dist = 0.0
        path = 0.0
        max_jump = 0.0
        jumps = []
        if n_rows >= 2:
            pts = [(fnum(rows[f]["centroid_x"]), fnum(rows[f]["centroid_y"]))
                   for f in frames]
            net_dist = dist(pts[0][0], pts[0][1], pts[-1][0], pts[-1][1])
            for i in range(1, n_rows):
                d = dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])
                path += d
                jumps.append(d)
            max_jump = max(jumps)
        median_jump = statistics.median(jumps) if jumps else 0.0
        mean_jump = statistics.mean(jumps) if jumps else 0.0

        # thresholds
        short_flag = n_rows <= SHORT_TRACK_FRAMES or duration <= SHORT_TRACK_FRAMES
        short_tier = 1 if (n_rows <= SHORT_TIER1_FRAMES
                           or duration <= SHORT_TIER1_FRAMES) else 2

        little_flag = (n_rows >= LITTLE_MOTION_MIN_ROWS
                       and net_dist < LITTLE_MOTION_NET_PX
                       and path < LITTLE_MOTION_PATH_PX)

        jump_rel_ok = max_jump > JUMP_RELATIVE_MULT * median_jump + JUMP_RELATIVE_ADD_PX
        large_jump_tier = (1 if max_jump >= JUMP_TIER1_PX
                           else 2 if (max_jump >= JUMP_TIER2_PX and jump_rel_ok)
                           else 0)
        large_jump_flag = large_jump_tier > 0

        erratic_flag = (n_rows >= 6 and path >= ERRATIC_PATH_MIN_PX
                        and path > ERRATIC_RATIO * max(net_dist, 1.0))

        cls_agree_raw = fnum(t["class_agreement"], 0.0)
        cls_agree_stab = fnum(t["class_agreement_stable"], 0.0)
        hyst = inum(t.get("hysteresis_switches", 0), 0)
        class_inconsistent = (
            cls_raw != cls_stab
            or cls_agree_raw < CLASS_AGREEMENT_FLAG
            or cls_agree_stab < CLASS_AGREEMENT_FLAG
            or hyst > 0
        )
        if class_inconsistent:
            cls_tier = 1 if (cls_agree_raw < 0.80 or cls_raw != cls_stab) else 2
        else:
            cls_tier = 0

        quality.append({
            "video": vid,
            "track_id": tid,
            "vehicle_class": cls_raw,
            "vehicle_class_stable": cls_stab,
            "first_frame": f0,
            "last_frame": f1,
            "duration_frames": duration,
            "frames_tracked": n_rows,
            "net_displacement_px": round(net_dist, 2),
            "path_length_px": round(path, 2),
            "max_jump_px": round(max_jump, 2),
            "mean_jump_px": round(mean_jump, 2),
            "median_jump_px": round(median_jump, 2),
            "class_agreement": cls_agree_raw,
            "class_agreement_stable": cls_agree_stab,
            "hysteresis_switches": hyst,
            "short_flag": short_flag,
            "short_tier": short_tier if short_flag else 0,
            "little_movement_flag": little_flag,
            "large_jump_flag": large_jump_flag,
            "large_jump_tier": large_jump_tier,
            "erratic_flag": erratic_flag,
            "class_inconsistent_flag": class_inconsistent,
            "class_inconsistent_tier": cls_tier,
        })

    # ── short-track candidates ──────────────────────────────────────────────
    short_cands = [q for q in quality if q["short_flag"]]
    short_cands.sort(key=lambda q: (q["video"], q["frames_tracked"], q["track_id"]))
    short_out = []
    for q in short_cands:
        short_out.append({
            "video": q["video"], "track_id": q["track_id"],
            "class": q["vehicle_class"], "class_stable": q["vehicle_class_stable"],
            "first_frame": q["first_frame"], "last_frame": q["last_frame"],
            "frames_tracked": q["frames_tracked"], "duration_frames": q["duration_frames"],
            "net_displacement_px": q["net_displacement_px"],
            "reason": (f"Very short track: {q['frames_tracked']} trajectory rows / "
                       f"{q['duration_frames']} frames duration (<= {SHORT_TRACK_FRAMES}). "
                       "Candidate only - may be a legitimate brief detection."),
            "severity_tier": f"Tier{q['short_tier']}",
        })

    # ── spatial suspicious candidates ───────────────────────────────────────
    spatial_out = []
    for q in quality:
        reasons = []
        tiers = []
        if q["little_movement_flag"]:
            tiers.append(2)
            reasons.append(
                f"Very little movement: net displacement {q['net_displacement_px']}px "
                f"(< {LITTLE_MOTION_NET_PX}px) and path {q['path_length_px']}px "
                f"(< {LITTLE_MOTION_PATH_PX}px) over {q['frames_tracked']} rows.")
        if q["large_jump_flag"]:
            tiers.append(q["large_jump_tier"])
            reasons.append(
                f"Unusual jump: max single-frame centroid jump {q['max_jump_px']}px "
                f"({JUMP_TIER1_PX if q['large_jump_tier'] == 1 else JUMP_TIER2_PX}px "
                f"threshold).")
        if q["erratic_flag"]:
            tiers.append(2)
            reasons.append(
                f"Spatially inconsistent/wandering: path {q['path_length_px']}px is "
                f"> {ERRATIC_RATIO}x net displacement {q['net_displacement_px']}px.")
        if not reasons:
            continue
        spatial_out.append({
            "video": q["video"], "track_id": q["track_id"],
            "class": q["vehicle_class"], "class_stable": q["vehicle_class_stable"],
            "first_frame": q["first_frame"], "last_frame": q["last_frame"],
            "frames_tracked": q["frames_tracked"], "duration_frames": q["duration_frames"],
            "net_displacement_px": q["net_displacement_px"],
            "path_length_px": q["path_length_px"],
            "max_jump_px": q["max_jump_px"], "mean_jump_px": q["mean_jump_px"],
            "reason": " | ".join(reasons),
            "severity_tier": f"Tier{max(tiers)}",
        })

    # ── duplicate-identity candidates (same video + same class) ─────────────
    dup_out = []
    for vid, tid_map in traj.items():
        class_of = {}
        for t in track_rows:
            if t["video"] == vid:
                class_of[inum(t["track_id"])] = t["vehicle_class_stable"]
        tids = sorted(tid_map.keys())
        for i in range(len(tids)):
            for j in range(i + 1, len(tids)):
                a, b = tids[i], tids[j]
                if class_of.get(a) != class_of.get(b):
                    continue
                frames_a = set(tid_map[a].keys())
                frames_b = set(tid_map[b].keys())
                overlap = sorted(frames_a & frames_b)
                # ─ consecutive-overlap duplicate check ─
                if len(overlap) >= DUP_MIN_OVERLAP_FRAMES:
                    dists = []
                    ious = []
                    for fr in overlap:
                        ra, rb = tid_map[a][fr], tid_map[b][fr]
                        d = dist(fnum(ra["centroid_x"]), fnum(ra["centroid_y"]),
                                 fnum(rb["centroid_x"]), fnum(rb["centroid_y"]))
                        dists.append(d)
                        ious.append(box_iou(
                            (fnum(ra["x1"]), fnum(ra["y1"]), fnum(ra["x2"]), fnum(ra["y2"])),
                            (fnum(rb["x1"]), fnum(rb["y1"]), fnum(rb["x2"]), fnum(rb["y2"]))))
                    mean_d = sum(dists) / len(dists)
                    min_d = min(dists)
                    max_iou = max(ious)
                    mean_iou = sum(ious) / len(ious)
                    if mean_d <= DUP_MEAN_DIST_PX or max_iou >= DUP_MAX_IOU:
                        tier = 1 if (min_d <= DUP_TIER1_MIN_DIST_PX
                                     or max_iou >= DUP_TIER1_MAX_IOU) else 2
                        dup_out.append({
                            "video": vid,
                            "track_id_a": a, "track_id_b": b,
                            "class": class_of.get(a),
                            "overlap_frames": len(overlap),
                            "min_centroid_distance_px": round(min_d, 2),
                            "mean_centroid_distance_px": round(mean_d, 2),
                            "max_iou": round(max_iou, 4),
                            "mean_iou": round(mean_iou, 4),
                            "temporal_type": "concurrent_overlap",
                            "reason": (f"Two {class_of.get(a)} tracks share "
                                       f"{len(overlap)} frames with mean centroid distance "
                                       f"{mean_d:.1f}px / max IoU {max_iou:.2f}. "
                                       "Possible duplicated identity - candidate only."),
                            "severity_tier": f"Tier{tier}",
                        })
                # ─ adjacent-gap continuation hint ─
                fa_max, fb_min = max(frames_a), min(frames_b)
                if 1 <= (fb_min - fa_max) <= ADJ_GAP_FRAMES:
                    ra_end = tid_map[a][fa_max]
                    rb_st = tid_map[b][fb_min]
                    bd = dist(fnum(ra_end["centroid_x"]), fnum(ra_end["centroid_y"]),
                              fnum(rb_st["centroid_x"]), fnum(rb_st["centroid_y"]))
                    if bd <= ADJ_BOUNDARY_DIST_PX:
                        dup_out.append({
                            "video": vid,
                            "track_id_a": a, "track_id_b": b,
                            "class": class_of.get(a),
                            "overlap_frames": 0,
                            "min_centroid_distance_px": round(bd, 2),
                            "mean_centroid_distance_px": round(bd, 2),
                            "max_iou": 0.0, "mean_iou": 0.0,
                            "temporal_type": "adjacent_gap",
                            "reason": (f"Track {a} ends at frame {fa_max}; track {b} starts "
                                       f"at frame {fb_min} (gap {fb_min - fa_max}) with boundary "
                                       f"centroids {bd:.1f}px apart. Possible re-issue after "
                                       "occlusion - candidate only."),
                            "severity_tier": "Tier2",
                        })
    # dedupe exact duplicates in dup_out
    seen = set()
    dedup = []
    for d in dup_out:
        key = (d["video"], d["track_id_a"], d["track_id_b"], d["temporal_type"])
        if key not in seen:
            seen.add(key)
            dedup.append(d)
    dedup.sort(key=lambda d: (d["video"], d["severity_tier"], d["track_id_a"]))

    # ── class-consistency candidates ─────────────────────────────────────────
    cls_out = []
    for q in quality:
        if not q["class_inconsistent_flag"]:
            continue
        reasons = []
        if q["vehicle_class"] != q["vehicle_class_stable"]:
            reasons.append(
                f"Raw majority class ({q['vehicle_class']}) != stabilized class "
                f"({q['vehicle_class_stable']}).")
        if q["class_agreement"] < CLASS_AGREEMENT_FLAG:
            reasons.append(f"Raw class agreement {q['class_agreement']:.2%} "
                           f"(< {CLASS_AGREEMENT_FLAG:.0%}).")
        if q["class_agreement_stable"] < CLASS_AGREEMENT_FLAG:
            reasons.append(f"Stabilized class agreement {q['class_agreement_stable']:.2%} "
                           f"(< {CLASS_AGREEMENT_FLAG:.0%}).")
        if q["hysteresis_switches"] > 0:
            reasons.append(f"{q['hysteresis_switches']} accepted class switch(es).")
        cls_out.append({
            "video": q["video"], "track_id": q["track_id"],
            "class": q["vehicle_class"], "class_stable": q["vehicle_class_stable"],
            "first_frame": q["first_frame"], "last_frame": q["last_frame"],
            "frames_tracked": q["frames_tracked"],
            "class_agreement": q["class_agreement"],
            "class_agreement_stable": q["class_agreement_stable"],
            "hysteresis_switches": q["hysteresis_switches"],
            "reason": " | ".join(reasons),
            "severity_tier": f"Tier{q['class_inconsistent_tier']}",
        })
    cls_out.sort(key=lambda q: (q["video"], q["class_agreement"], q["track_id"]))

    # ── duration distribution ───────────────────────────────────────────────
    videos = sorted({q["video"] for q in quality})
    dur_all = [q["duration_frames"] for q in quality]
    rows_all = [q["frames_tracked"] for q in quality]

    reports = []
    reports.append("=" * 72)
    reports.append("  Level 7 - Post-Level-6B Track Quality Diagnosis (READ-ONLY)")
    reports.append("=" * 72)
    reports.append("  Source: validated Level 6B outputs (level6b/).")
    reports.append("  Candidates only - no merges/relabels/count changes.")
    reports.append("")
    reports.append("  THRESHOLDS USED")
    reports.append(f"    Short track          : rows or duration <= {SHORT_TRACK_FRAMES} frames "
                   f"(Tier1 <= {SHORT_TIER1_FRAMES})")
    reports.append(f"    Little movement      : net < {LITTLE_MOTION_NET_PX}px AND path < "
                   f"{LITTLE_MOTION_PATH_PX}px (>= {LITTLE_MOTION_MIN_ROWS} rows)")
    reports.append(f"    Large jump           : single jump >= {JUMP_TIER1_PX}px (Tier1) or "
                   f">= {JUMP_TIER2_PX}px AND >{JUMP_RELATIVE_MULT}x median+"
                   f"{JUMP_RELATIVE_ADD_PX}px (Tier2)")
    reports.append(f"    Erratic/wandering    : path >= {ERRATIC_PATH_MIN_PX}px AND > "
                   f"{ERRATIC_RATIO}x net displacement (>=6 rows)")
    reports.append(f"    Duplicate (overlap)  : >= {DUP_MIN_OVERLAP_FRAMES} shared frames AND "
                   f"(mean cdist <= {DUP_MEAN_DIST_PX}px OR max IoU >= {DUP_MAX_IOU})")
    reports.append(f"    Duplicate (gap)      : gap 1..{ADJ_GAP_FRAMES} frames AND boundary "
                   f"cdist <= {ADJ_BOUNDARY_DIST_PX}px")
    reports.append(f"    Class inconsistency  : raw!=stable OR agreement < "
                   f"{CLASS_AGREEMENT_FLAG:.0%} OR hyst switches > 0")
    reports.append("")
    reports.append("  TRACK-DURATION DISTRIBUTION  (frames)")
    reports.append(f"    {'Scope':<22} {'min':>4} {'p5':>5} {'p10':>5} {'p25':>5} "
                   f"{'median':>7} {'p75':>5} {'p90':>5} {'p95':>5} {'max':>5}")
    for scope, vals in [("ALL videos (duration)", dur_all),
                        ("ALL videos (rows)", rows_all)]:
        p = percentiles(vals)
        reports.append(f"    {scope:<22} {fmt_pct(p,'min'):>4} {fmt_pct(p,'p5'):>5} "
                       f"{fmt_pct(p,'p10'):>5} {fmt_pct(p,'p25'):>5} {fmt_pct(p,'median'):>7} "
                       f"{fmt_pct(p,'p75'):>5} {fmt_pct(p,'p90'):>5} "
                       f"{fmt_pct(p,'p95'):>5} {fmt_pct(p,'max'):>5}")
    for vid in videos:
        dvals = [q["duration_frames"] for q in quality if q["video"] == vid]
        rvals = [q["frames_tracked"] for q in quality if q["video"] == vid]
        p, pr = percentiles(dvals), percentiles(rvals)
        reports.append(f"    {vid} (duration){' ':>2} {fmt_pct(p,'min'):>4} {fmt_pct(p,'p5'):>5} "
                       f"{fmt_pct(p,'p10'):>5} {fmt_pct(p,'p25'):>5} {fmt_pct(p,'median'):>7} "
                       f"{fmt_pct(p,'p75'):>5} {fmt_pct(p,'p90'):>5} "
                       f"{fmt_pct(p,'p95'):>5} {fmt_pct(p,'max'):>5}")
        reports.append(f"    {vid} (rows){' ':>7} {fmt_pct(pr,'min'):>4} {fmt_pct(pr,'p5'):>5} "
                       f"{fmt_pct(pr,'p10'):>5} {fmt_pct(pr,'p25'):>5} "
                       f"{fmt_pct(pr,'median'):>7} {fmt_pct(pr,'p75'):>5} "
                       f"{fmt_pct(pr,'p90'):>5} {fmt_pct(pr,'p95'):>5} {fmt_pct(pr,'max'):>5}")
    reports.append("")
    reports.append("  CANDIDATE COUNTS  (per category / per video)")
    cats = [
        ("Short-track candidates", short_out),
        ("Spatial-suspicious candidates", spatial_out),
        ("Duplicate-identity candidates", dedup),
        ("Class-consistency candidates", cls_out),
    ]
    for name, cands in cats:
        total = len(cands)
        reports.append(f"    {name:<32} TOTAL {total:>3}")
        for vid in videos:
            n = sum(1 for c in cands if c.get("video") == vid)
            reports.append(f"        {vid:<28} {n:>3}")
        t1 = sum(1 for c in cands if c.get("severity_tier") == "Tier1")
        t2 = sum(1 for c in cands if c.get("severity_tier") == "Tier2")
        reports.append(f"        Tier1: {t1}   Tier2: {t2}")
    reports.append("")
    reports.append("  NOTE: identical trajectories across two track IDs are NOT "
                   "concluded to be the same vehicle here.")
    reports.append("  These are candidates for later visual verification only.")

    # ── writes ──────────────────────────────────────────────────────────────
    quality_fields = list(quality[0].keys())
    write_csv(quality, "level7_track_quality_summary.csv", quality_fields)

    short_fields = list(short_out[0].keys()) if short_out else \
        ["video", "track_id", "class", "class_stable", "first_frame", "last_frame",
         "frames_tracked", "duration_frames", "net_displacement_px", "reason",
         "severity_tier"]
    write_csv(short_out, "level7_short_track_candidates.csv", short_fields)

    spatial_fields = list(spatial_out[0].keys()) if spatial_out else \
        ["video", "track_id", "class", "class_stable", "first_frame", "last_frame",
         "frames_tracked", "duration_frames", "net_displacement_px", "path_length_px",
         "max_jump_px", "mean_jump_px", "reason", "severity_tier"]
    write_csv(spatial_out, "level7_spatial_suspicious_candidates.csv", spatial_fields)

    dup_fields = ["video", "track_id_a", "track_id_b", "class", "overlap_frames",
                  "min_centroid_distance_px", "mean_centroid_distance_px", "max_iou",
                  "mean_iou", "temporal_type", "reason", "severity_tier"]
    write_csv(dedup, "level7_duplicate_candidates.csv", dup_fields)

    cls_fields = ["video", "track_id", "class", "class_stable", "first_frame",
                  "last_frame", "frames_tracked", "class_agreement",
                  "class_agreement_stable", "hysteresis_switches", "reason",
                  "severity_tier"]
    write_csv(cls_out, "level7_class_consistency_candidates.csv", cls_fields)

    report_txt = OUT_DIR / "level7_diagnostic_report.txt"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(report_txt, "w", encoding="utf-8") as f:
        f.write("\n".join(reports) + "\n")

    print("\n".join(reports))
    print()
    print("  Output files:")
    for p in sorted(OUT_DIR.glob("*")):
        print(f"    {p.resolve()}")


if __name__ == "__main__":
    main()