"""
Level 6A companion - Visual Verification of Fragment-Merge Candidates
====================================================================
Renders annotated frames (and, when possible, a short MP4 clip) for
each Level 6A Tier 1 candidate so a human can judge whether the
fragment ByteTrack ID and the parent ByteTrack ID represent the SAME
physical vehicle.

This script:
  * reads only  data/processed/vehicle_trajectories.csv
  * reads only  data/processed/vehicle_merge_candidates.csv
  * reads       data/raw_videos/*.mp4  (original footage, read-only)
  * writes ONLY into data/processed/fragment_visual_verification/
  * performs NO detection, NO tracking, NO merging, NO counting

It does not modify the tracking/counting pipeline or any existing file.

Annotated frame content:
  * video name + frame number (top-left)
  * candidate header (fragment ID, parent ID, classes, gap, IoU, dist)
  * ORANGE box + label = fragment ID ; GREEN box + label = parent ID
  * centroid dot for each shown box
  * grey "gap" note on frames where neither ID is tracked

Usage:
    python src/visualize_fragment_candidates.py
"""

import csv
import sys
from pathlib import Path
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import RAW_VIDEOS_DIR, PROCESSED_DIR

import cv2

# ============================================================
#  PATHS & FILTERS
# ============================================================

TRAJECTORY_CSV = PROCESSED_DIR / "vehicle_trajectories.csv"
CANDIDATES_CSV = PROCESSED_DIR / "vehicle_merge_candidates.csv"
OUT_DIR        = PROCESSED_DIR / "fragment_visual_verification"
TIER_FILTER    = "Tier1"          # visualise only Tier 1 auto-candidates

FRAMES_PER_SIDE = 5               # frames shown before/after the junction
JPEG_QUALITY    = 70

# colours (BGR)
C_FRAGMENT = (0, 165, 255)        # orange
C_PARENT   = (0, 200, 0)          # green
C_HEADER   = (255, 255, 255)
C_CAND     = (200, 255, 200)
C_GAP      = (200, 200, 200)


# ============================================================
#  DATA LOADING
# ============================================================

def load_trajectories():
    """video -> track_id -> frame -> row"""
    tr = defaultdict(lambda: defaultdict(dict))
    with open(TRAJECTORY_CSV, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            tr[r["video"]][int(r["track_id"])][int(r["frame"])] = r
    return tr


def load_candidates():
    with open(CANDIDATES_CSV, encoding="utf-8") as f:
        return [r for r in csv.DictReader(f) if r["tier"] == TIER_FILTER]


# ============================================================
#  FRAME WINDOW
# ============================================================

def compute_window(row, total_frames):
    """Frame indices shown for the candidate junction region."""
    f0f, f1f = int(row["fragment_first_frame"]), int(row["fragment_last_frame"])
    f0p, f1p = int(row["parent_first_frame"]),   int(row["parent_last_frame"])
    d = row["direction"]
    p = FRAMES_PER_SIDE
    if d == "overlap":
        start, end = max(f0f, f0p) - p, min(f1f, f1p) + p
    elif d == "fragment_before_parent":
        start, end = max(f0f, f1f - p), f0p + p
    elif d == "parent_before_fragment":
        start, end = max(f0p, f1p - p), f0f + p
    else:  # defensive fallback
        start, end = f0f - p, f1p + p
    start = max(0, start)
    end = min(total_frames - 1, end)
    return list(range(start, end + 1))


# ============================================================
#  DRAWING
# ============================================================

def draw_box(img, row, tid, label, color):
    x1, y1, x2, y2 = (int(float(row[k])) for k in ("x1", "y1", "x2", "y2"))
    cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
    lw = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)[0][0]
    lh = 16
    y0 = y1 - lh - 3
    if y0 < 0:
        y0 = y2 + 3
    cv2.rectangle(img, (x1, y0), (x1 + lw, y0 + lh), color, -1)
    cv2.putText(img, label, (x1, y0 + lh - 4),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)
    # centroid
    cx = int(float(row["centroid_x"]))
    cy = int(float(row["centroid_y"]))
    cv2.circle(img, (cx, cy), 4, color, -1)
    cv2.circle(img, (cx, cy), 7, (0, 0, 0), 1)


def annotate_frame(img, row, frame_idx, best):
    """best = {"fragment": row, "parent": row} (only present tracks)."""
    h, _ = img.shape[:2]
    cv2.putText(img, "Video: %s   Frame: %d" % (row["video"], frame_idx),
                (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.7, C_HEADER, 2)
    cand = ("Candidate: frag #%s (%s)  ->  parent #%s (%s)"
            "    gap=%s (%s)  IoU=%s  dist=%spx  WR=%.2f") % (
        row["fragment_id"], row["fragment_class"],
        row["parent_id"],   row["parent_class"],
        row["frame_gap"], row["direction"],
        row["boundary_iou"], row["centroid_distance_px"],
        float(row["width_ratio"]))
    cv2.putText(img, cand, (10, 48), cv2.FONT_HERSHEY_SIMPLEX, 0.55, C_CAND, 1)

    for kind, r in best.items():
        label = "FRAG #%s %s" % (row["fragment_id"], row["fragment_class"]) \
                if kind == "fragment" else \
                "PAR  #%s %s" % (row["parent_id"], row["parent_class"])
        color = C_FRAGMENT if kind == "fragment" else C_PARENT
        draw_box(img, r, None, label, color)

    if not best:
        cv2.putText(img, "gap frame - neither ID tracked here",
                    (10, h - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, C_GAP, 1)


# ============================================================
#  VIDEO / SAVE
# ============================================================

def frame_at(video_path, idx):
    cap = cv2.VideoCapture(str(video_path))
    cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
    ok, frame = cap.read()
    cap.release()
    return frame if ok else None


def total_frames(video_path):
    cap = cv2.VideoCapture(str(video_path))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    return n


# ============================================================
#  MAIN
# ============================================================

def main():
    print("=" * 74)
    print("  Level 6A  --  Visual Verification of Fragment Candidates")
    print("  No detection / tracking / merging / counting changes")
    print("=" * 74)
    print()
    print("Output dir: %s" % OUT_DIR)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print()

    traj   = load_trajectories()
    cands  = load_candidates()

    if not cands:
        print("No %s candidates found in %s" % (TIER_FILTER, CANDIDATES_CSV))
        sys.exit(0)

    report_rows = []
    failures    = []

    for idx, row in enumerate(cands, 1):
        video    = row["video"]
        frag_id  = int(row["fragment_id"])
        par_id   = int(row["parent_id"])
        vpath    = RAW_VIDEOS_DIR / video
        subdir   = OUT_DIR / ("cand_f%d_p%d" % (frag_id, par_id))
        subdir.mkdir(exist_ok=True)

        n_total  = total_frames(vpath)
        frames   = compute_window(row, n_total)

        fps = 25.0
        cap = cv2.VideoCapture(str(vpath))
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0

        mp4_path = subdir / ("cand_f%d_p%d.mp4" % (frag_id, par_id))
        writer = None
        annotated = []
        try:
            first_read = None
            for k in frames:
                cap.set(cv2.CAP_PROP_POS_FRAMES, k)
                ok, frame = cap.read()
                if not ok:
                    continue
                present = {}
                fr = traj.get(video, {}).get(frag_id, {}).get(k)
                pa = traj.get(video, {}).get(par_id, {}).get(k)
                if fr:
                    present["fragment"] = fr
                if pa:
                    present["parent"] = pa
                annotate_frame(frame, row, k, present)
                if first_read is None:
                    first_read = frame
                annotated.append((k, frame))
            if first_read is not None:
                h, w = first_read.shape[:2]
                writer = cv2.VideoWriter(
                    str(mp4_path),
                    cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
        except Exception as exc:  # keep going even if mp4 fails
            failures.append((video, frag_id, par_id,
                             "mp4 init error: %s" % exc))
            writer = None

        if writer is not None:
            for k, frame in annotated:
                fn = subdir / ("cand_f%d_p%d_frame_%06d.jpg"
                               % (frag_id, par_id, k))
                cv2.imwrite(str(fn), frame,
                            [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
                writer.write(frame)
            writer.release()
            clip_note = "frames-> JPG + MP4"
        else:
            for k, frame in annotated:
                fn = subdir / ("cand_f%d_p%d_frame_%06d.jpg"
                               % (frag_id, par_id, k))
                cv2.imwrite(str(fn), frame,
                            [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            clip_note = "frames-> JPG only (mp4 unavailable)"

        cap.release()

        n_frames = len(annotated)
        frange = "%d-%d" % (frames[0], frames[-1]) if frames else "n/a"
        print("  %2d. %-18s frag#%d -> par#%d  %s  (frames %s, %d annotated)"
              % (idx, video, frag_id, par_id, row["direction"], frange,
                 n_frames))

        notes = ("direction=%s; gap=%s; dist=%spx; IoU=%s; WR=%s; "
                 "frames_saved=%s; %s" % (
                     row["direction"], row["frame_gap"],
                     row["centroid_distance_px"], row["boundary_iou"],
                     row["width_ratio"], frange, clip_note))
        report_rows.append({
            "video":          video,
            "fragment_id":    row["fragment_id"],
            "parent_id":      row["parent_id"],
            "fragment_class": row["fragment_class"],
            "parent_class":   row["parent_class"],
            "visual_status":  "NEEDS_MANUAL_REVIEW",
            "confidence":     row["boundary_iou"],
            "notes":          notes,
        })

    report_path = OUT_DIR / "verification_report.csv"
    cols = ["video", "fragment_id", "parent_id", "fragment_class",
            "parent_class", "visual_status", "confidence", "notes"]
    with open(report_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(report_rows)

    print()
    print("Report written: %s" % report_path)
    print()
    if failures:
        print("FAILURES / WARNINGS:")
        for v, f, p, msg in failures:
            print("   video=%s frag=%d par=%d: %s" % (v, f, p, msg))
    else:
        print("No failures.")
    print()
    print("=" * 74)
    print("  STOP  --  visual evidence generated, NO merging performed.")
    print("  Review the frames, then decide SAME_VEHICLE / DIFFERENT_VEHICLE.")
    print("=" * 74)


if __name__ == "__main__":
    main()