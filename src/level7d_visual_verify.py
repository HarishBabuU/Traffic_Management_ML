"""
Level 7D - Final Visual Verification of Remaining Duplicate Candidates
======================================================================
Renders annotated MP4 clips for the final two un-adjudicated duplicate
pairs from the Level 7C quality review, using ONLY the raw videos for
visualization and the existing Level 7C trajectories for annotation.

Candidates:
  1. low traffic.mp4  : 15 <-> 18  (concurrent overlap f65-69, maxIoU 0.47)
  2. traffic.mp4      : 154 <-> 157 (14-frame gap, boundary cdist 25px)

Clips show:
  * original video frames
  * both candidate track IDs with bounding boxes/centroids + class labels
  * frame number and video name overlay
  * surrounding context frames (before, during, and after the critical window)

THIS IS VISUALIZATION ONLY.
No merges, no relabelling, no count changes, no detection/tracking reruns.
decision column left blank.

Inputs  (read-only):
    data/processed/level7c/level7c_trajectories.csv
    data/raw_videos/*.mp4

Outputs (NEW, data/processed/level7/level7d_visual_verification/):
    clip_15_18.mp4
    clip_154_157.mp4
    level7d_verification_candidates.csv  (decision column left blank)

Usage:
    python src/level7d_visual_verify.py
"""

import csv
from pathlib import Path

import cv2

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RAW = PROJECT_ROOT / "data" / "raw_videos"
L7 = PROJECT_ROOT / "data" / "processed" / "level7"
L7C = PROJECT_ROOT / "data" / "processed" / "level7c"
OUT_DIR = L7 / "level7d_visual_verification"

# candidate_id, video, [track_id_a, track_id_b], (start, end), reason
SPEC = [
    {
        "id": "15_18",
        "video": "low traffic.mp4",
        "track_ids": [15, 18],
        "frames": (30, 105),
        "reason": ("Car 15 (f37-69) overlaps car 18 (f65-98) for 5 frames with "
                   "max IoU 0.47; the overlap window is f65-69. Judge whether "
                   "these are the same vehicle (duplicated identity) or two "
                   "adjacent vehicles."),
    },
    {
        "id": "154_157",
        "video": "traffic.mp4",
        "track_ids": [154, 157],
        "frames": (40, 100),
        "reason": ("Motorcycle 154 (f53-71) and motorcycle 157 (f85-92) have a "
                   "14-frame gap with boundary centroid distance 25px. Judge "
                   "whether 157 is a re-issue of the same motorcycle after "
                   "occlusion or a different motorcycle."),
    },
]


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
        track_idx.setdefault(fr, r)
    return idx


def draw_box(frame, row, tid, color):
    x1, y1 = int(num(row["x1"])), int(num(row["y1"]))
    x2, y2 = int(num(row["x2"])), int(num(row["y2"]))
    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
    cx = int(num(row["centroid_x"]))
    cy = int(num(row["centroid_y"]))
    cv2.circle(frame, (cx, cy), 6, color, -1)
    cls = row["vehicle_class"]
    cls_st = row["vehicle_class_stable"]
    label = f"TID#{tid} {cls}" if cls == cls_st else f"TID#{tid} {cls}({cls_st})"
    (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2)
    ty = y1 - 8 if y1 - 8 > 20 else y2 + th + 4
    cv2.rectangle(frame, (x1, ty - th - 4), (x1 + tw + 4, ty + 2), color, -1)
    cv2.putText(frame, label, (x1 + 2, ty), cv2.FONT_HERSHEY_SIMPLEX,
                0.7, (0, 0, 0), 2)


def main():
    traj_rows = read_csv(L7C / "level7c_trajectories.csv")
    frame_idx = build_frame_index(traj_rows)

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    verify_rows = []
    for n, c in enumerate(SPEC, start=1):
        vid = c["video"]
        tids = c["track_ids"]
        start, end = c["frames"]
        vpath = RAW / vid
        if not vpath.exists():
            print(f"  SKIP {c['id']}: raw video not found at {vpath}")
            continue

        cap = cv2.VideoCapture(str(vpath))
        if not cap.isOpened():
            print(f"  SKIP {c['id']}: cannot open video")
            continue
        fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
        nframes = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        end = min(end, nframes - 1)

        per_track = {}
        cls_map = {}
        for tid in tids:
            td = frame_idx.get(vid, {}).get(tid, {})
            per_track[tid] = td
            if td:
                counts = {}
                for row in td.values():
                    counts[row["vehicle_class_stable"]] = counts.get(
                        row["vehicle_class_stable"], 0) + 1
                cls_map[tid] = max(counts, key=counts.get)
            else:
                cls_map[tid] = "?"
        classes_str = "+".join(cls_map[t] for t in tids)

        clip_name = f"clip_{c['id']}.mp4"
        clip_path = OUT_DIR / clip_name
        writer = cv2.VideoWriter(str(clip_path), cv2.VideoWriter_fourcc(*"mp4v"),
                                 fps, (w, h))

        colors = {tid: (0, 165, 255) if i == 0 else (255, 255, 0)
                  for i, tid in enumerate(tids)}

        cap.set(cv2.CAP_PROP_POS_FRAMES, start)
        print(f"  [{n}] {c['id']}  {vid}  tids={tids}  window={start}-{end}  -> {clip_name}")
        for fr in range(start, end + 1):
            ret, frame = cap.read()
            if not ret:
                break
            for tid in tids:
                row = per_track[tid].get(fr)
                if row is not None:
                    draw_box(frame, row, tid, colors[tid])
            cv2.rectangle(frame, (0, 0), (w, 44), (0, 0, 0), -1)
            cv2.putText(frame, f"{vid}  |  frame {fr}", (10, 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2)
            cv2.putText(frame, f"D:{c['id']}", (w - 120, 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
            writer.write(frame)
        writer.release()
        cap.release()

        verify_rows.append({
            "candidate_id": c["id"],
            "video": vid,
            "track_ids": "+".join(str(t) for t in tids),
            "frame_window": f"{start}-{end}",
            "classes": classes_str,
            "reason": c["reason"],
            "clip_path": str(clip_path.resolve()),
            "decision": "",
        })

    fields = ["candidate_id", "video", "track_ids", "frame_window",
              "classes", "reason", "clip_path", "decision"]
    out_csv = OUT_DIR / "level7d_verification_candidates.csv"
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in verify_rows:
            w.writerow(r)

    print()
    print(f"  Candidates rendered : {len(verify_rows)}")
    print(f"  Output dir          : {OUT_DIR.resolve()}")
    print(f"  Candidate CSV       : {out_csv.resolve()}")


if __name__ == "__main__":
    main()