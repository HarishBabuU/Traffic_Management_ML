"""
Phase 3 - Step 1: YOLO Detection Test
Samples evenly-spaced frames from each traffic video, runs YOLOv8
vehicle detection, and saves annotated images for visual inspection.

Usage:
    python src/detection_test.py              # defaults: 8 samples, conf 0.25
    python src/detection_test.py --conf 0.3   # custom confidence
    python src/detection_test.py --samples 12 # more sample frames
"""

import sys
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import (
    RAW_VIDEOS_DIR, SCREENSHOTS_DIR, VIDEO_EXTENSIONS,
    VEHICLE_CLASSES, VEHICLE_CLASS_IDS,
    DEFAULT_CONFIDENCE, DEFAULT_MODEL,
)
from ultralytics import YOLO
import cv2


def get_sample_indices(total_frames: int, num_samples: int) -> list[int]:
    """Return evenly spaced frame indices, clipped to valid range."""
    if total_frames <= 0:
        return []
    step = max(1, total_frames // (num_samples + 1))
    indices = [step * (i + 1) for i in range(num_samples)]
    return [i for i in indices if i < total_frames]


def process_video(model, video_path: Path, output_dir: Path,
                  num_samples: int, conf: float) -> dict:
    """Run detection on sampled frames, save annotated images, return stats."""
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        print(f"  ERROR: Cannot open {video_path.name}")
        return {"filename": video_path.name, "status": "ERROR"}

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()

    frame_indices = get_sample_indices(total_frames, num_samples)
    video_out = output_dir / video_path.stem.replace(" ", "_")
    video_out.mkdir(parents=True, exist_ok=True)

    print(f"  {total_frames} frames, sampling {len(frame_indices)}: {frame_indices}")

    per_frame_stats = []

    cap = cv2.VideoCapture(str(video_path))
    for idx in frame_indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok:
            print(f"    SKIP frame {idx}")
            continue

        results = model.predict(source=frame, conf=conf,
                                classes=VEHICLE_CLASS_IDS, verbose=False)
        r = results[0]
        boxes = r.boxes

        det_by_class = {}
        if boxes is not None and len(boxes) > 0:
            for cls_id in boxes.cls.cpu().numpy():
                name = VEHICLE_CLASSES.get(int(cls_id), f"class_{int(cls_id)}")
                det_by_class[name] = det_by_class.get(name, 0) + 1

        total_det = sum(det_by_class.values())
        time_s = round(idx / fps, 2) if fps > 0 else 0
        print(f"    frame {idx:>6}  t={time_s:>6.2f}s  detections={total_det}  {det_by_class}")

        per_frame_stats.append({
            "frame": idx, "time_s": time_s,
            "total": total_det, **det_by_class,
        })

        annotated = r.plot()
        out_path = video_out / f"frame_{idx:06d}.jpg"
        cv2.imwrite(str(out_path), annotated)

    cap.release()

    return {
        "filename": video_path.name,
        "status": "OK",
        "resolution": f"{width}x{height}",
        "fps": round(fps, 2),
        "total_frames": total_frames,
        "samples_saved": len(frame_indices),
        "per_frame": per_frame_stats,
    }


def main():
    parser = argparse.ArgumentParser(description="YOLO Detection Test")
    parser.add_argument("--conf", type=float, default=DEFAULT_CONFIDENCE)
    parser.add_argument("--samples", type=int, default=8)
    args = parser.parse_args()

    print("=" * 60)
    print("  YOLO Detection Test — Traffic Videos")
    print("=" * 60)

    print(f"\nModel  : {DEFAULT_MODEL}")
    print(f"Conf   : {args.conf}")
    print(f"Classes: {list(VEHICLE_CLASSES.values())}")
    print(f"Samples: {args.samples} per video")

    model = YOLO(DEFAULT_MODEL)

    video_files = sorted(
        f for f in RAW_VIDEOS_DIR.iterdir()
        if f.suffix.lower() in VIDEO_EXTENSIONS
    )
    if not video_files:
        print(f"\nNo videos found in {RAW_VIDEOS_DIR}")
        return

    print(f"\nFound {len(video_files)} video(s)\n")
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)

    all_stats = []
    for vf in video_files:
        print(f"\n--- {vf.name} ---")
        stats = process_video(model, vf, SCREENSHOTS_DIR,
                              num_samples=args.samples, conf=args.conf)
        all_stats.append(stats)

    print("\n" + "=" * 60)
    print("  SUMMARY")
    print("=" * 60)
    for s in all_stats:
        if s["status"] == "OK":
            total_all = sum(f["total"] for f in s["per_frame"])
            avg = round(total_all / len(s["per_frame"]), 1) if s["per_frame"] else 0
            print(f"  {s['filename']:<28}  res={s['resolution']}  "
                  f"avg_det/frame={avg}  saved={s['samples_saved']}")
        else:
            print(f"  {s['filename']:<28}  {s['status']}")

    print(f"\nAnnotated images saved to: {SCREENSHOTS_DIR.resolve()}")
    print("Review the images, then adjust --conf if needed.")


if __name__ == "__main__":
    main()
