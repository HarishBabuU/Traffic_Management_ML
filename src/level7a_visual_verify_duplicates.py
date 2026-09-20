"""
Level 7A - Visual Verification of Level 7 Duplicate Candidates (READ-ONLY)
==========================================================================
Renders annotated MP4 clips for ALL Tier1 duplicate-identity candidates from
Level 7, using ONLY the existing raw videos for visualization.

Clips show:
  * original video frames
  * both candidate track IDs clearly labeled with their bounding boxes/centroids
  * frame number and video name overlay
  * context before, during, and after the overlap window

THIS IS VISUALIZATION ONLY.
No track merging/deleting/relabelling, no count changes, no detection/tracking
reruns. No decision is made here.

Inputs  (read-only):
    data/processed/level7/level7_duplicate_candidates.csv
    data/processed/level6b/level6b_trajectories.csv
    data/raw_videos/*.mp4

Outputs (NEW, data/processed/level7/duplicate_visual_verification/):
    cand_<A>_<B>.mp4            per Tier1 candidate
    verification_candidates.csv (decision column left blank)

Usage:
    python src/level7a_visual_verify_duplicates.py
"""

import csv
from pathlib import Path

import cv2

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RAW = PROJECT_ROOT / "data" / "raw_videos"
L7 = PROJECT_ROOT / "data" / "processed" / "level7"
L6B = PROJECT_ROOT / "data" / "processed" / "level6b"
OUT_DIR = L7 / "duplicate_visual_verification"

PAD_SECONDS = 1.0          # context frames before/after the overlap window

COLOR_A = (0, 165, 255)    # orange  -> track_id_a
COLOR_B = (255, 255, 0)    # cyan    -> track_id_b


def read_csv(path):
    with open(path, "r", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def itn(v, default=0):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def build_frame_index(traj_rows):
    """video -> track_id(int) -> {frame: first_row_for_that_frame}"""
    idx = {}
    for r in traj_rows:
        vid = r["video"]
        tid = itn(r["track_id"])
        fr = itn(r["frame"])
        video_idx = idx.setdefault(vid, {})
        track_idx = video_idx.setdefault(tid, {})
        track_idx.setdefault(fr, r)   # keep first box per frame
    return idx


def draw_box(frame, row, tid, cls, color, label_prefix="TID"):
    x1, y1 = int(num(row["x1"])), int(num(row["y1"]))
    x2, y2 = int(num(row["x2"])), int(num(row["y2"]))
    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
    cx = int(num(row["centroid_x"]))
    cy = int(num(row["centroid_y"]))
    cv2.circle(frame, (cx, cy), 5, color, -1)
    label = f"{label_prefix}#{tid} {cls}"
    (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2)
    ty = y1 - 8 if y1 - 8 > 20 else y2 + th + 4
    cv2.rectangle(frame, (x1, ty - th - 4), (x1 + tw + 4, ty + 2), color, -1)
    cv2.putText(frame, label, (x1 + 2, ty), cv2.FONT_HERSHEY_SIMPLEX,
                0.7, (0, 0, 0), 2)


def main():
    cands = read_csv(L7 / "level7_duplicate_candidates.csv")
    traj_rows = read_csv(L6B / "level6b_trajectories.csv")
    frame_idx = build_frame_index(traj_rows)

    tier1 = [c for c in cands if c["severity_tier"] == "Tier1"]
    tier1.sort(key=lambda c: (c["video"], itn(c["track_id_a"])))

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    verify_rows = []
    for n, c in enumerate(tier1, start=1):
        vid = c["video"]
        a, b = itn(c["track_id_a"]), itn(c["track_id_b"])
        cls = c["class"]
        vpath = RAW / vid
        if not vpath.exists():
            print(f"  SKIP {vid}: raw video not found at {vpath}")
            continue

        cap = cv2.VideoCapture(str(vpath))
        if not cap.isOpened():
            print(f"  SKIP {vid}: cannot open video")
            continue
        fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
        nframes = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        track_a = frame_idx.get(vid, {}).get(a, {})
        track_b = frame_idx.get(vid, {}).get(b, {})
        frames_a = set(track_a.keys())
        frames_b = set(track_b.keys())
        overlap = sorted(frames_a & frames_b)
        all_frames = sorted(frames_a | frames_b)
        if not all_frames:
            cap.release()
            continue

        lo = min(all_frames)
        hi = max(all_frames)
        pad = int(round(PAD_SECONDS * fps))
        start = max(0, (overlap[0] if overlap else lo) - pad)
        end = min(nframes - 1, (overlap[-1] if overlap else hi) + pad)

        clip_name = f"cand_{a:03d}_{b:03d}.mp4"
        clip_path = OUT_DIR / clip_name
        writer = cv2.VideoWriter(str(clip_path), cv2.VideoWriter_fourcc(*"mp4v"),
                                 fps, (w, h))

        print(f"  [{n}] {vid} TIDs {a} & {b} ({cls}) overlap={overlap} "
              f"window={start}-{end} -> {clip_name}")
        for fr in range(start, end + 1):
            ret, frame = cap.read()
            if not ret:
                break
            ra = track_a.get(fr)
            rb = track_b.get(fr)
            if ra is not None:
                draw_box(frame, ra, a, cls, COLOR_A, label_prefix="TID")
            if rb is not None:
                draw_box(frame, rb, b, cls, COLOR_B, label_prefix="TID")
            cv2.rectangle(frame, (0, 0), (w, 44), (0, 0, 0), -1)
            cv2.putText(frame, f"{vid}  |  frame {fr}", (10, 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2)
            cv2.putText(frame, f"TID#{a}", (w - 150, 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, COLOR_A, 2)
            cv2.putText(frame, f"TID#{b}", (w - 70, 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, COLOR_B, 2)
            writer.write(frame)
        writer.release()
        cap.release()

        verify_rows.append({
            "candidate_number": n,
            "video": vid,
            "track_id_a": a,
            "track_id_b": b,
            "class": cls,
            "temporal_type": c["temporal_type"],
            "overlap_frames": itn(c["overlap_frames"]),
            "min_centroid_distance_px": round(num(c["min_centroid_distance_px"]), 2),
            "mean_centroid_distance_px": round(num(c["mean_centroid_distance_px"]), 2),
            "max_iou": round(num(c["max_iou"]), 4),
            "severity_tier": c["severity_tier"],
            "clip_path": str(clip_path.resolve()),
            "decision": "",
        })

    fields = ["candidate_number", "video", "track_id_a", "track_id_b", "class",
              "temporal_type", "overlap_frames", "min_centroid_distance_px",
              "mean_centroid_distance_px", "max_iou", "severity_tier",
              "clip_path", "decision"]
    out_csv = OUT_DIR / "verification_candidates.csv"
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in verify_rows:
            w.writerow(r)

    print()
    print(f"  Tier1 candidates rendered : {len(verify_rows)}")
    print(f"  Output dir                : {OUT_DIR.resolve()}")
    print(f"  Candidate CSV             : {out_csv.resolve()}")


if __name__ == "__main__":
    main()