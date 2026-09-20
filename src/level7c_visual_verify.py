"""
Level 7C - Visual Verification of High-Priority Candidates (READ-ONLY)
======================================================================
Renders annotated MP4 clips for the Level 7 review's high-priority
unresolved candidates, using ONLY the raw videos for visualization and
the existing Level 7B trajectories for annotation.

Clips show:
  * original video frames
  * involved track IDs labeled with bounding boxes/centroids
  * frame number and video name overlay
  * context before/after the candidate window

THIS IS VISUALIZATION ONLY.
No track merging/relabelling, no count changes, no detection/tracking
reruns, no training. No decision is made here (decision left blank).

Inputs  (read-only):
    data/processed/level7b/level7b_trajectories.csv
    data/raw_videos/*.mp4

Outputs (NEW, data/processed/level7/level7c_visual_verification/):
    clip_<candidate_id>.mp4
    level7c_verification_candidates.csv  (decision column left blank)

Usage:
    python src/level7c_visual_verify.py
"""

import csv
from pathlib import Path

import cv2

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RAW = PROJECT_ROOT / "data" / "raw_videos"
L7 = PROJECT_ROOT / "data" / "processed" / "level7"
L7B = PROJECT_ROOT / "data" / "processed" / "level7b"
OUT_DIR = L7 / "level7c_visual_verification"

# BGR palette assigned per track in each clip's track list order
PALETTE = [
    (0, 165, 255),    # orange
    (255, 255, 0),    # cyan
    (0, 255, 0),      # green
    (255, 0, 255),    # magenta
    (0, 255, 255),    # yellow
    (0, 0, 255),      # red
    (255, 0, 0),      # blue
]

# candidate_id, priority, video, [track_id,...], window_start, window_end, reason
SPEC = [
    {
        "id": "P1_truckchain",
        "priority": "Priority1",
        "video": "traffic.mp4",
        "track_ids": [138, 224, 228, 229, 234, 236],
        "frames": (530, 599),
        "reason": ("Sequential truck/bus fragments (224,228,229,234,236) within bus "
                   "138's end-of-video coverage (556-599); likely one fragmented identity "
                   "overlapping canonical 138"),
    },
    {
        "id": "P2_low_101_vs_90",
        "priority": "Priority2",
        "video": "low traffic.mp4",
        "track_ids": [90, 101],
        "frames": (690, 712),
        "reason": ("1-frame truck fragment 101 (f700) sits on long truck 90 (f652-740) "
                   "at centroid distance ~3.5px; likely same vehicle"),
    },
    {
        "id": "P2_no_118_vs_114",
        "priority": "Priority2",
        "video": "no traffic video.mp4",
        "track_ids": [114, 118],
        "frames": (600, 620),
        "reason": ("1-frame bicycle fragment 118 (f609) sits on long bicycle 114 "
                   "(f416-658) at centroid distance ~2.2px; likely same vehicle"),
    },
    {
        "id": "P2_167_vs_126",
        "priority": "Priority2",
        "video": "traffic.mp4",
        "track_ids": [126, 167],
        "frames": (165, 185),
        "reason": ("1-frame truck fragment 167 (f174) sits on long truck 126 (f1-303) "
                   "at centroid distance ~1.6px; likely same vehicle"),
    },
    {
        "id": "P2_160_vs_131",
        "priority": "Priority2",
        "video": "traffic.mp4",
        "track_ids": [131, 160],
        "frames": (85, 104),
        "reason": ("2-frame car->truck fragment 160 (f93-94) sits on long car 131 "
                   "(f1-222) at centroid distance ~2.0px; likely same vehicle"),
    },
    {
        "id": "P3_low_45_vs_46",
        "priority": "Priority3",
        "video": "low traffic.mp4",
        "track_ids": [45, 46],
        "frames": (340, 368),
        "reason": ("1-frame car 45 (f348) immediately precedes car 46 (f351-501), "
                   "boundary centroid distance ~34px; possible re-issue after occlusion"),
    },
    {
        "id": "P3_low_65_vs_79",
        "priority": "Priority3",
        "video": "low traffic.mp4",
        "track_ids": [65, 79],
        "frames": (585, 612),
        "reason": ("Car 65 (f501-599) overlaps car 79 (f592-660) for 7 frames with "
                   "max IoU 0.55, mean centroid distance ~52px; possible duplicated identity"),
    },
    {
        "id": "P3_131_vs_176",
        "priority": "Priority3",
        "video": "traffic.mp4",
        "track_ids": [131, 176],
        "frames": (214, 246),
        "reason": ("Car 131 ends f222; car 176 runs f239-274 (gap 17), boundary "
                   "centroid distance ~15px; possible re-issue after occlusion"),
    },
    {
        "id": "P3_146_vs_153",
        "priority": "Priority3",
        "video": "traffic.mp4",
        "track_ids": [146, 153],
        "frames": (40, 64),
        "reason": ("Motorcycle 146 ends f48; motorcycle 153 runs f52-55 (gap 4), "
                   "boundary centroid distance ~6.4px; possible re-issue after occlusion"),
    },
    {
        "id": "P3_150_vs_163",
        "priority": "Priority3",
        "video": "traffic.mp4",
        "track_ids": [150, 163],
        "frames": (102, 128),
        "reason": ("Car 150 ends f108; car 163 runs f120-599 (gap 12), boundary "
                   "centroid distance ~16.8px; possible re-issue after occlusion"),
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
    traj_rows = read_csv(L7B / "level7b_trajectories.csv")
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
                cls_counts = {}
                for row in td.values():
                    cls_counts[row["vehicle_class_stable"]] = cls_counts.get(
                        row["vehicle_class_stable"], 0) + 1
                cls_map[tid] = max(cls_counts, key=cls_counts.get)
            else:
                cls_map[tid] = "?"
        classes_str = "+".join(cls_map[t] for t in tids)

        clip_name = f"clip_{c['id']}.mp4"
        clip_path = OUT_DIR / clip_name
        writer = cv2.VideoWriter(str(clip_path), cv2.VideoWriter_fourcc(*"mp4v"),
                                 fps, (w, h))

        colors = {tid: PALETTE[i % len(PALETTE)] for i, tid in enumerate(tids)}

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
            tag = c["priority"][:1] + ":" + c["id"].split("_", 1)[-1]
            cv2.putText(frame, tag, (w - 260, 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
            writer.write(frame)
        writer.release()
        cap.release()

        verify_rows.append({
            "candidate_id": c["id"],
            "priority": c["priority"],
            "video": vid,
            "track_ids": "+".join(str(t) for t in tids),
            "frame_window_start": start,
            "frame_window_end": end,
            "classes": classes_str,
            "reason": c["reason"],
            "clip_path": str(clip_path.resolve()),
            "decision": "",
        })

    fields = ["candidate_id", "priority", "video", "track_ids",
              "frame_window_start", "frame_window_end", "classes",
              "reason", "clip_path", "decision"]
    out_csv = OUT_DIR / "level7c_verification_candidates.csv"
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