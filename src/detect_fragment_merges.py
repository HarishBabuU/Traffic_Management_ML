"""
Level 6A - Post-Hoc Track Fragment Detection (DIAGNOSTIC ONLY)
==============================================================
Analyzes vehicle_trajectories.csv and identifies likely cases where
two ByteTrack track IDs represent the same physical vehicle.

A fragment (2-15 tracked frames) is compared with an established
parent (>20 tracked frames) in the same video. Candidate tests:

  * same stabilized vehicle class
  * frame gap  <= Tier1:15 / Tier2:20  (negative = temporal overlap)
  * centroid distance   <= Tier1:50 / Tier2:100 px
  * boundary IoU        >= Tier1:0.40 / Tier2:0.30
  * boundary box-width  diff ratio <= SIZE_TOLERANCE (0.45)

The width gate rejects box-jump artifacts where a tracking box
momentarily jumps onto a different vehicle (observed 53-77% width
disparity vs 1-39% for genuine duplicate-IDs in this dataset).

This is a diagnostic tool. It does NOT modify any counting behavior,
track IDs, or existing files. It only reads trajectory data and
writes a new diagnostic CSV.

Usage:
    python src/detect_fragment_merges.py
"""

import csv
import sys
import math
from pathlib import Path
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import PROCESSED_DIR

# ============================================================
#  THRESHOLDS  (derived from empirical trajectory analysis)
# ============================================================

FRAGMENT_MIN_FRAMES = 2
FRAGMENT_MAX_FRAMES = 15
PARENT_MIN_FRAMES   = 21

TIER1_MIN_IOU   = 0.40
TIER1_MAX_GAP   = 15
TIER1_MAX_DIST  = 50.0

TIER2_MIN_IOU   = 0.30
TIER2_MAX_GAP   = 20
TIER2_MAX_DIST  = 100.0

CROSS_CLASS_MIN_IOU = 0.40
CROSS_CLASS_MAX_GAP = 20
CROSS_CLASS_MAX_DIST = 100.0

# Same physical vehicle must produce similar box sizes at the boundary.
# Genuine duplicate-IDs in this dataset differ by 1-39% in width;
# artifacts (box-jumps onto a different vehicle) differ by 53-77%.
SIZE_TOLERANCE = 0.45

INPUT_CSV  = PROCESSED_DIR / "vehicle_trajectories.csv"
OUTPUT_CSV = PROCESSED_DIR / "vehicle_merge_candidates.csv"


# ============================================================
#  GEOMETRY HELPERS
# ============================================================

def iou(box_a, box_b):
    x1 = max(box_a[0], box_b[0])
    y1 = max(box_a[1], box_b[1])
    x2 = min(box_a[2], box_b[2])
    y2 = min(box_a[3], box_b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    area_a = (box_a[2] - box_a[0]) * (box_a[3] - box_a[1])
    area_b = (box_b[2] - box_b[0]) * (box_b[3] - box_b[1])
    return inter / (area_a + area_b - inter + 1e-9)


def centroid(row):
    return (float(row["centroid_x"]), float(row["centroid_y"]))


def bbox(row):
    return (float(row["x1"]), float(row["y1"]),
            float(row["x2"]), float(row["y2"]))


def distance(c1, c2):
    return math.hypot(c1[0] - c2[0], c1[1] - c2[1])


# ============================================================
#  TRACK LOADING
# ============================================================

def load_tracks(csv_path):
    rows = list(csv.DictReader(open(csv_path, encoding="utf-8")))
    by_vid = defaultdict(lambda: defaultdict(list))
    for r in rows:
        by_vid[r["video"]][int(r["track_id"])].append(r)
    tracks = {}
    for vid, tid_map in by_vid.items():
        for tid, trk_rows in tid_map.items():
            trk_rows.sort(key=lambda r: int(r["frame"]))
            f0 = int(trk_rows[0]["frame"])
            f1 = int(trk_rows[-1]["frame"])
            n  = len(trk_rows)
            conf_avg = sum(float(r["confidence"]) for r in trk_rows) / n
            raw_class = trk_rows[0]["vehicle_class"]
            stable_class = trk_rows[0]["vehicle_class_stable"]
            tracks[(vid, tid)] = {
                "video":          vid,
                "track_id":       tid,
                "n":              n,
                "f0":             f0,
                "f1":             f1,
                "cls_raw":        raw_class,
                "cls_stable":     stable_class,
                "conf_avg":       round(conf_avg, 4),
                "cx0":            float(trk_rows[0]["centroid_x"]),
                "cy0":            float(trk_rows[0]["centroid_y"]),
                "cx1":            float(trk_rows[-1]["centroid_x"]),
                "cy1":            float(trk_rows[-1]["centroid_y"]),
                "rows":           trk_rows,
                "frame_set":      set(int(r["frame"]) for r in trk_rows),
            }
    return rows, tracks


# ============================================================
#  BOUNDARY COMPUTATION
# ============================================================

def boundary_pair(t_frag, t_par):
    """Return (gap, dist, iou, direction, fr_row, pr_row) for the
    best boundary pair.  fr_row/pr_row are the two trajectory rows
    that bound the junction, used for box-width consistency checks."""
    frag_rows = t_frag["rows"]
    par_rows  = t_par["rows"]
    f0_f, f1_f = t_frag["f0"], t_frag["f1"]
    f0_p, f1_p = t_par["f0"], t_par["f1"]

    overlap = max(0, min(f1_f, f1_p) - max(f0_f, f0_p) + 1)
    if overlap > 0:
        direction = "overlap"
        best_dist = 1e9
        best_iou  = 0.0
        best_gap  = 0
        best_fr = best_pr = None
        par_map = {}
        for r in par_rows:
            par_map.setdefault(int(r["frame"]), []).append(r)
        for fr in frag_rows:
            fnum = int(fr["frame"])
            if fnum in par_map:
                for pr in par_map[fnum]:
                    d = distance(centroid(fr), centroid(pr))
                    i = iou(bbox(fr), bbox(pr))
                    if (i > best_iou) or (i == best_iou and d < best_dist):
                        best_dist = d
                        best_iou  = i
                        best_gap  = 0
                        best_fr, best_pr = fr, pr
        if best_iou == 0.0:
            best_dist = 1e9
            for fr in frag_rows:
                fnum = int(fr["frame"])
                if fnum not in par_map:
                    continue
                for pr in par_map[fnum]:
                    d = distance(centroid(fr), centroid(pr))
                    if d < best_dist:
                        best_dist = d
                        best_fr, best_pr = fr, pr
            if best_fr is not None:
                best_iou = iou(bbox(best_fr), bbox(best_pr))
        return -overlap, best_dist, best_iou, direction, best_fr, best_pr

    if f1_f < f0_p:
        direction = "fragment_before_parent"
        gap    = f0_p - f1_f
        fr_row = frag_rows[-1]
        pr_row = par_rows[0]
        return (gap, distance(centroid(fr_row), centroid(pr_row)),
                iou(bbox(fr_row), bbox(pr_row)), direction, fr_row, pr_row)

    if f1_p < f0_f:
        direction = "parent_before_fragment"
        gap    = f0_f - f1_p
        fr_row = frag_rows[0]
        pr_row = par_rows[-1]
        return (gap, distance(centroid(fr_row), centroid(pr_row)),
                iou(bbox(fr_row), bbox(pr_row)), direction, fr_row, pr_row)

    return 0, 0, 0.0, "unknown", None, None


def width_diff_ratio(fr_row, pr_row):
    """Relative difference in bounding-box width at the boundary."""
    if fr_row is None or pr_row is None:
        return 1.0
    w_f = float(fr_row["x2"]) - float(fr_row["x1"])
    w_p = float(pr_row["x2"]) - float(pr_row["x1"])
    return abs(w_f - w_p) / max(w_f, w_p)


# ============================================================
#  CANDIDATE DETECTION
# ============================================================

def detect(tracks):
    by_vid = defaultdict(list)
    for key, t in tracks.items():
        by_vid[t["video"]].append(t)

    candidates     = []
    cross_excluded = []

    for vid, tlist in by_vid.items():
        frags = [t for t in tlist if FRAGMENT_MIN_FRAMES <= t["n"] <= FRAGMENT_MAX_FRAMES]
        pars  = [t for t in tlist if t["n"] >= PARENT_MIN_FRAMES]
        for f in frags:
            for p in pars:
                if f["track_id"] == p["track_id"]:
                    continue
                gap, dist, bd_iou, direction, fr_row, pr_row = boundary_pair(f, p)
                abs_gap = -gap if direction == "overlap" else gap
                w_ratio = width_diff_ratio(fr_row, pr_row)
                stable_match = (f["cls_stable"] == p["cls_stable"])
                size_ok = (w_ratio <= SIZE_TOLERANCE)

                if stable_match and size_ok and abs_gap <= TIER1_MAX_GAP \
                        and dist <= TIER1_MAX_DIST and bd_iou >= TIER1_MIN_IOU:
                    reason = ("same stable class (%s vs %s); gap=%s (%s); "
                              "dist=%.1fpx; IoU=%.3f; widthRatio=%.2f") % (
                        f["cls_stable"], p["cls_stable"], gap, direction,
                        dist, bd_iou, w_ratio)
                    candidates.append({
                        **base_row(f, p, gap, dist, bd_iou),
                        "fragment_confidence_avg": f["conf_avg"],
                        "parent_confidence_avg":   p["conf_avg"],
                        "tier":     "Tier1",
                        "decision": "AUTO_CANDIDATE",
                        "direction": direction,
                        "width_ratio": round(w_ratio, 3),
                        "reason":   reason,
                    })
                    continue

                if stable_match and size_ok and abs_gap <= TIER2_MAX_GAP \
                        and dist <= TIER2_MAX_DIST and bd_iou >= TIER2_MIN_IOU:
                    reason = ("same stable class (%s vs %s); gap=%s (%s); "
                              "dist=%.1fpx; IoU=%.3f; widthRatio=%.2f") % (
                        f["cls_stable"], p["cls_stable"], gap, direction,
                        dist, bd_iou, w_ratio)
                    candidates.append({
                        **base_row(f, p, gap, dist, bd_iou),
                        "fragment_confidence_avg": f["conf_avg"],
                        "parent_confidence_avg":   p["conf_avg"],
                        "tier":     "Tier2",
                        "decision": "REVIEW",
                        "direction": direction,
                        "width_ratio": round(w_ratio, 3),
                        "reason":   reason,
                    })
                    continue

                if (not stable_match and abs_gap <= CROSS_CLASS_MAX_GAP
                        and dist <= CROSS_CLASS_MAX_DIST
                        and bd_iou >= CROSS_CLASS_MIN_IOU):
                    reason = ("CROSS-CLASS EXCLUDED: %s vs %s; gap=%s (%s); "
                              "dist=%.1fpx; IoU=%.3f; widthRatio=%.2f") % (
                        f["cls_stable"], p["cls_stable"], gap, direction,
                        dist, bd_iou, w_ratio)
                    cross_excluded.append({
                        **base_row(f, p, gap, dist, bd_iou),
                        "direction": direction,
                        "width_ratio": round(w_ratio, 3),
                        "reason":   reason,
                    })

    candidates.sort(key=lambda c: (
        c["video"],
        0 if c["tier"] == "Tier1" else 1,
        -c["boundary_iou"],
        c["centroid_distance_px"],
    ))
    return candidates, cross_excluded


def base_row(f, p, gap, dist, bd_iou):
    return {
        "video":  f["video"],
        "fragment_id": f["track_id"],
        "parent_id":   p["track_id"],
        "fragment_class": f["cls_stable"],
        "parent_class":   p["cls_stable"],
        "fragment_class_raw": f["cls_raw"],
        "parent_class_raw":   p["cls_raw"],
        "fragment_frames": f["n"],
        "parent_frames":   p["n"],
        "fragment_first_frame": f["f0"],
        "fragment_last_frame":  f["f1"],
        "parent_first_frame":   p["f0"],
        "parent_last_frame":    p["f1"],
        "frame_gap": gap,
        "centroid_distance_px": round(dist, 1),
        "boundary_iou": round(bd_iou, 4),
    }


# ============================================================
#  CSV OUTPUT
# ============================================================

COLUMNS = [
    "video", "fragment_id", "parent_id",
    "fragment_class", "parent_class",
    "fragment_class_raw", "parent_class_raw",
    "fragment_frames", "parent_frames",
    "fragment_first_frame", "fragment_last_frame",
    "parent_first_frame", "parent_last_frame",
    "frame_gap", "centroid_distance_px", "boundary_iou",
    "width_ratio",
    "fragment_confidence_avg", "parent_confidence_avg",
    "tier", "decision", "direction", "reason",
]


def write_csv(path, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)


# ============================================================
#  REPORT
# ============================================================

def print_candidates(candidates):
    hdr = ("%-16s %5s %5s  %-10s %-10s  %5s %5s  %-15s  %6s  %-8s  %-6s  %-8s  %s"
           % ("VIDEO", "FRAG", "PAR", "FRAG_CLS", "PAR_CLS",
              "FRAG_N", "PAR_N", "FRAME_GAP", "DIST", "IoU", "WRATIO", "TIER", "DIR"))
    print()
    print(hdr)
    print("-" * len(hdr))
    for c in candidates:
        print("%-16s %5d %5d  %-10s %-10s  %5d %5d  %-15s  %6.1f  %.4f  %-6.2f  %-8s  %s"
              % (c["video"],
                 c["fragment_id"], c["parent_id"],
                 c["fragment_class"], c["parent_class"],
                 c["fragment_frames"], c["parent_frames"],
                 "%s(%s)" % (c["frame_gap"], c["direction"]),
                 c["centroid_distance_px"],
                 c["boundary_iou"],
                 c["width_ratio"],
                 c["tier"],
                 c["decision"]))
    print()


def print_cross_excluded(cross_excluded):
    if not cross_excluded:
        print("  No cross-class excluded candidates found.")
        return
    print()
    print("  %-16s %5s %5s  %-10s %-10s  %5s %5s  %-15s  %6s  %-8s  %-6s  %s"
          % ("VIDEO", "FRAG", "PAR", "FRAG_CLS", "PAR_CLS",
             "FRAG_N", "PAR_N", "FRAME_GAP", "DIST", "IoU", "WRATIO", "DIR"))
    print("  " + "-" * 88)
    for c in cross_excluded:
        print("  %-16s %5d %5d  %-10s %-10s  %5d %5d  %-15s  %6.1f  %.4f  %-6.2f  %s"
              % (c["video"],
                 c["fragment_id"], c["parent_id"],
                 c["fragment_class"], c["parent_class"],
                 c["fragment_frames"], c["parent_frames"],
                 "%s(%s)" % (c["frame_gap"], c["direction"]),
                 c["centroid_distance_px"],
                 c["boundary_iou"],
                 c.get("width_ratio", 0.0),
                 c["direction"]))
    print()


# ============================================================
#  MAIN
# ============================================================

def main():
    print("=" * 70)
    print("  Level 6A  --  Post-Hoc Track Fragment Detection")
    print("  DIAGNOSTIC ONLY  --  no counts or track IDs modified")
    print("=" * 70)
    print()
    print("Input:  %s" % INPUT_CSV)
    print("Output: %s" % OUTPUT_CSV)
    print()

    all_rows, tracks = load_tracks(INPUT_CSV)

    total_tracks = len(tracks)
    frag_count   = sum(1 for t in tracks.values()
                       if FRAGMENT_MIN_FRAMES <= t["n"] <= FRAGMENT_MAX_FRAMES)
    single_count = sum(1 for t in tracks.values() if t["n"] == 1)
    established  = sum(1 for t in tracks.values() if t["n"] >= PARENT_MIN_FRAMES)
    total_rows   = len(all_rows)

    by_vid = defaultdict(list)
    for t in tracks.values():
        by_vid[t["video"]].append(t)
    for vid in sorted(by_vid):
        vtracks = by_vid[vid]
        vfrags  = [t for t in vtracks
                   if FRAGMENT_MIN_FRAMES <= t["n"] <= FRAGMENT_MAX_FRAMES]
        vests   = [t for t in vtracks if t["n"] >= PARENT_MIN_FRAMES]
        print("  %-22s  %3d tracks  (%d single-frame, %d fragments 2-15f, "
              "%d established >20f)"
              % (vid, len(vtracks), len([t for t in vtracks if t["n"] == 1]),
                 len(vfrags), len(vests)))
    print()
    print("  TOTAL: %d tracks  (%d single-frame, %d fragments 2-15f, "
          "%d established >20f)" % (total_tracks, single_count,
                                     frag_count, established))
    print("  TOTAL: %d trajectory rows across %d videos"
          % (total_rows, len(by_vid)))
    print()

    candidates, cross_excluded = detect(tracks)

    tier1 = [c for c in candidates if c["tier"] == "Tier1"]
    tier2 = [c for c in candidates if c["tier"] == "Tier2"]

    print("-" * 70)
    print("  RESULTS")
    print("-" * 70)
    print("  Tier 1 candidates (AUTO_CANDIDATE): %d" % len(tier1))
    print("  Tier 2 candidates (REVIEW):         %d" % len(tier2))
    print("  Cross-class excluded:               %d" % len(cross_excluded))
    print()

    print_candidates(candidates)

    if cross_excluded:
        print("-" * 70)
        print("  CROSS-CLASS EXCLUDED CANDIDATES (high overlap, different class)")
        print("-" * 70)
        print_cross_excluded(cross_excluded)

    print("-" * 70)
    print("  WRITING CSV  -->  %s" % OUTPUT_CSV)
    print("-" * 70)
    write_csv(OUTPUT_CSV, candidates)
    print("  Done. %d rows written." % len(candidates))
    print()
    print("=" * 70)
    print("  STOP -- Level 6A diagnostic complete.")
    print("  No pipeline files modified. No counts changed.")
    print("  Wait for approval before proceeding to Level 6B.")
    print("=" * 70)


if __name__ == "__main__":
    main()
