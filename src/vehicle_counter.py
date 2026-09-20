"""
Phase 3 - Step 2: Unique Vehicle Counter (YOLO + ByteTrack)
Processes each traffic video with YOLOv8 detection and ByteTrack
to count UNIQUE vehicles by persistent track ID.

Usage:
    python src/vehicle_counter.py
    python src/vehicle_counter.py --conf 0.35
    python src/vehicle_counter.py --save-annotated 5   # save 5 annotated frames per video
"""

import sys
import csv
import argparse
from pathlib import Path
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import (
    RAW_VIDEOS_DIR, METADATA_DIR, SCREENSHOTS_DIR, VIDEO_EXTENSIONS,
    VEHICLE_CLASSES, VEHICLE_CLASS_IDS,
    DEFAULT_CONFIDENCE, DEFAULT_IOU_THRESHOLD,
    DEFAULT_MODEL, TRACKER_CONFIG,
)
from ultralytics import YOLO
import cv2


def track_video(video_path: Path, model, conf: float, iou: float,
                save_n_annotated: int = 0) -> dict:
    """
    Run YOLO + ByteTrack on a video.
    Returns dict with unique vehicle counts keyed by track ID.
    """
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return {"filename": video_path.name, "status": "ERROR: cannot open"}

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    duration = round(total_frames / fps, 2) if fps > 0 else 0
    cap.release()

    # track_id -> COCO class_id (persistent across entire video)
    unique_vehicles: dict[int, int] = {}
    # per-frame stats
    per_frame_dets: list[int] = []

    results = model.track(
        source=str(video_path),
        conf=conf,
        iou=iou,
        classes=VEHICLE_CLASS_IDS,
        tracker=TRACKER_CONFIG,
        persist=True,
        stream=True,
        verbose=False,
    )

    # figure out which frames to save as annotated samples
    save_interval = 1
    if save_n_annotated > 0:
        save_interval = max(1, total_frames // save_n_annotated)
    annotated_saved = 0

    frame_num = 0
    for result in results:
        frame_has_dets = 0

        if result.boxes is not None and result.boxes.id is not None:
            track_ids = result.boxes.id.cpu().numpy().astype(int)
            class_ids = result.boxes.cls.cpu().numpy().astype(int)
            confs = result.boxes.conf.cpu().numpy()

            for tid, cid in zip(track_ids, class_ids):
                unique_vehicles[int(tid)] = int(cid)

            frame_has_dets = len(track_ids)

        per_frame_dets.append(frame_has_dets)

        # save sample annotated frames
        if (save_n_annotated > 0
                and annotated_saved < save_n_annotated
                and frame_num % save_interval == 0):
            annotated = result.plot()
            out_dir = SCREENSHOTS_DIR / "counting"
            out_dir.mkdir(parents=True, exist_ok=True)
            fname = f"{video_path.stem.replace(' ', '_')}_frame_{frame_num:06d}.jpg"
            cv2.imwrite(str(out_dir / fname), annotated)
            annotated_saved += 1

        frame_num += 1

    # aggregate
    by_class: dict[str, int] = defaultdict(int)
    for cid in unique_vehicles.values():
        name = VEHICLE_CLASSES.get(cid, f"class_{cid}")
        by_class[name] += 1

    avg_per_frame = (sum(per_frame_dets) / len(per_frame_dets)) if per_frame_dets else 0

    return {
        "filename": video_path.name,
        "status": "OK",
        "width": width,
        "height": height,
        "fps": round(fps, 2),
        "total_frames": total_frames,
        "duration_seconds": duration,
        "frames_processed": frame_num,
        "unique_vehicle_count": len(unique_vehicles),
        "unique_by_class": dict(by_class),
        "avg_detections_per_frame": round(avg_per_frame, 2),
    }


def main():
    parser = argparse.ArgumentParser(description="Unique Vehicle Counter")
    parser.add_argument("--conf", type=float, default=DEFAULT_CONFIDENCE)
    parser.add_argument("--iou", type=float, default=DEFAULT_IOU_THRESHOLD)
    parser.add_argument("--save-annotated", type=int, default=3,
                        help="Number of annotated frames to save per video (0 = none)")
    args = parser.parse_args()

    print("=" * 60)
    print("  Unique Vehicle Counter (YOLO + ByteTrack)")
    print("=" * 60)
    print(f"\nModel    : {DEFAULT_MODEL}")
    print(f"Conf     : {args.conf}")
    print(f"IoU      : {args.iou}")
    print(f"Tracker  : {TRACKER_CONFIG}")
    print(f"Classes  : {list(VEHICLE_CLASSES.values())}")

    model = YOLO(DEFAULT_MODEL)

    video_files = sorted(
        f for f in RAW_VIDEOS_DIR.iterdir()
        if f.suffix.lower() in VIDEO_EXTENSIONS
    )
    if not video_files:
        print(f"\nNo videos found in {RAW_VIDEOS_DIR}")
        return

    print(f"\nProcessing {len(video_files)} video(s)...\n")

    all_results = []
    for vf in video_files:
        print(f"--- {vf.name} ---")
        res = track_video(vf, model, args.conf, args.iou, args.save_annotated)
        all_results.append(res)

        if res["status"] == "OK":
            print(f"  frames       : {res['frames_processed']}")
            print(f"  unique cars  : {res['unique_vehicle_count']}")
            print(f"  by class     : {res['unique_by_class']}")
            print(f"  avg det/frame: {res['avg_detections_per_frame']}")
        else:
            print(f"  {res['status']}")
        print()

    # save CSV
    METADATA_DIR.mkdir(parents=True, exist_ok=True)
    csv_path = METADATA_DIR / "vehicle_counts.csv"

    fields = [
        "filename", "status", "width", "height", "fps",
        "total_frames", "duration_seconds", "frames_processed",
        "unique_vehicle_count", "unique_by_class", "avg_detections_per_frame",
    ]

    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in all_results:
            row = r.copy()
            row["unique_by_class"] = str(row.get("unique_by_class", {}))
            w.writerow(row)

    # summary table
    print("=" * 60)
    print("  SUMMARY")
    print("=" * 60)
    print(f"  {'Video':<30} {'Unique':>8} {'Avg/F':>8} {'Duration':>9}")
    print(f"  {'-'*30} {'-'*8} {'-'*8} {'-'*9}")
    for r in all_results:
        if r["status"] == "OK":
            print(f"  {r['filename']:<30} {r['unique_vehicle_count']:>8} "
                  f"{r['avg_detections_per_frame']:>8} {r['duration_seconds']:>8}s")
        else:
            print(f"  {r['filename']:<30} {r['status']}")

    print(f"\nCSV saved to  : {csv_path.resolve()}")
    if args.save_annotated > 0:
        print(f"Annotated frames: {(SCREENSHOTS_DIR / 'counting').resolve()}")


if __name__ == "__main__":
    main()
