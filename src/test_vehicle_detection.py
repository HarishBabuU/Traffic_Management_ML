"""
Phase 3 - YOLO Detection Validation (sanity check)
====================================================
Runs YOLOv8n on sampled frames of each traffic video.
Records every detection (class, confidence, bounding box),
saves annotated sample images, and writes raw results to CSV.

THIS IS NOT A COUNTING SCRIPT.  It only validates that YOLO
can find vehicles before we add ByteTrack.

Usage
-----
    python src/test_vehicle_detection.py
    python src/test_vehicle_detection.py --conf 0.3 --interval 40
"""

import csv
import sys
import argparse
from pathlib import Path
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ultralytics import YOLO
import cv2

# ============================================================
#  CONFIGURABLE PARAMETERS  (edit here or override via CLI)
# ============================================================

CONFIDENCE_THRESHOLD  = 0.25
FRAME_SAMPLING_INTERVAL = 50          # process every Nth frame

INPUT_VIDEO_DIR       = Path(__file__).resolve().parents[1] / "data" / "raw_videos"
OUTPUT_SCREENSHOT_DIR = Path(__file__).resolve().parents[1] / "outputs" / "screenshots" / "validation"
OUTPUT_CSV_PATH       = Path(__file__).resolve().parents[1] / "data" / "processed" / "detection_samples.csv"

# Where to look for the YOLO weights (checked in order; first hit wins)
_MODEL_CANDIDATES = [
    Path(__file__).resolve().parents[1] / "models" / "detection" / "yolov8n.pt",
    Path(__file__).resolve().parents[1] / "yolov8n.pt",
]

# COCO classes YOLOv8n *actually supports* for vehicle detection.
# These IDs are hardcoded to COCO weights — not renamed or faked.
#   auto-rickshaw: NOT a COCO class → excluded
#   van:           NOT a COCO class → excluded
#   bicycle (1):   IS a COCO class but excluded from this validation
#                  scope per project requirements (if needed later,
#                  add 1: "bicycle" here and to VEHICLE_CLASS_IDS).
VEHICLE_CLASSES = {
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
}
VEHICLE_CLASS_IDS = list(VEHICLE_CLASSES.keys())

VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv"}

# ============================================================


def _resolve_model() -> str:
    """Return the first model path that exists on disk, else fallback."""
    for p in _MODEL_CANDIDATES:
        if p.exists():
            return str(p)
    # Ultralytics will download yolov8n.pt automatically
    return "yolov8n.pt"


def process_video(model, video_path: Path, writer) -> dict:
    """Run detection on sampled frames, write rows to CSV, save images."""

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        print(f"  ERROR: Cannot open {video_path.name}")
        return None

    fps       = cap.get(cv2.CAP_PROP_FPS)
    total     = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width     = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height    = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()

    # where to save this video's annotated frames
    out_dir = OUTPUT_SCREENSHOT_DIR / video_path.stem.replace(" ", "_")
    out_dir.mkdir(parents=True, exist_ok=True)

    sampled         = 0
    total_dets      = 0
    class_counts    = defaultdict(int)
    class_conf_sum  = defaultdict(float)
    no_det_frames   = 0

    cap = cv2.VideoCapture(str(video_path))

    for idx in range(0, total, FRAME_SAMPLING_INTERVAL):
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok:
            continue

        sampled += 1
        timestamp = round(idx / fps, 3) if fps > 0 else 0.0

        results = model.predict(
            source=frame,
            conf=CONFIDENCE_THRESHOLD,
            classes=VEHICLE_CLASS_IDS,
            verbose=False,
        )
        result  = results[0]
        boxes   = result.boxes
        frame_det_count = 0

        if boxes is not None and len(boxes) > 0:
            for box in boxes:
                cls_id   = int(box.cls[0])
                conf     = float(box.conf[0])
                name     = VEHICLE_CLASSES.get(cls_id, f"unknown_{cls_id}")
                x1, y1, x2, y2 = box.xyxy[0].tolist()

                writer.writerow([
                    video_path.name,          # video
                    idx,                       # frame_number
                    timestamp,                 # timestamp_s
                    cls_id,                    # class_id
                    name,                      # class_name
                    round(conf, 4),            # confidence
                    int(x1), int(y1),          # bbox x1, y1
                    int(x2), int(y2),          # bbox x2, y2
                    int(x2 - x1),              # bbox_width
                    int(y2 - y1),              # bbox_height
                ])

                frame_det_count += 1
                class_counts[name]   += 1
                class_conf_sum[name] += conf

        total_dets += frame_det_count
        if frame_det_count == 0:
            no_det_frames += 1

        # --- save annotated image (including zero-detection frames) ---
        annotated = result.plot()
        label = (f"{video_path.name}  frame {idx}  t={timestamp:.2f}s"
                 f"  detections={frame_det_count}")
        cv2.putText(annotated, label, (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
        cv2.imwrite(str(out_dir / f"frame_{idx:06d}.jpg"), annotated)

    cap.release()

    class_avg_conf = {
        c: round(class_conf_sum[c] / class_counts[c], 4) if class_counts[c] else 0.0
        for c in sorted(class_counts)
    }

    return {
        "video":          video_path.name,
        "resolution":     f"{width}x{height}",
        "fps":            round(fps, 2),
        "total_frames":   total,
        "sampled":        sampled,
        "no_det_frames":  no_det_frames,
        "total_dets":     total_dets,
        "class_counts":   dict(class_counts),
        "class_avg_conf": class_avg_conf,
    }


def main():
    parser = argparse.ArgumentParser(description="YOLO detection validation")
    parser.add_argument("--conf",     type=float, default=CONFIDENCE_THRESHOLD,
                        help=f"Confidence threshold (default {CONFIDENCE_THRESHOLD})")
    parser.add_argument("--interval", type=int,   default=FRAME_SAMPLING_INTERVAL,
                        help=f"Frame sampling interval (default {FRAME_SAMPLING_INTERVAL})")
    args = parser.parse_args()

    # CLI overrides (used by all functions via module-level globals)
    _g = globals()
    _g["CONFIDENCE_THRESHOLD"]   = args.conf
    _g["FRAME_SAMPLING_INTERVAL"] = args.interval

    model_path = _resolve_model()
    print("=" * 62)
    print("  YOLO Detection Validation  (sanity check — NO counting)")
    print("=" * 62)
    print(f"  Model           : {model_path}")
    print(f"  Confidence      : {CONFIDENCE_THRESHOLD}")
    print(f"  Frame interval  : every {FRAME_SAMPLING_INTERVAL} frames")
    print(f"  Classes         : {list(VEHICLE_CLASSES.values())}  (COCO IDs {VEHICLE_CLASS_IDS})")
    print(f"  Video source    : {INPUT_VIDEO_DIR.resolve()}")
    print(f"  Screenshot dest : {OUTPUT_SCREENSHOT_DIR.resolve()}")
    print(f"  CSV output      : {OUTPUT_CSV_PATH.resolve()}")
    print()

    model = YOLO(model_path)

    video_files = sorted(
        f for f in INPUT_VIDEO_DIR.iterdir()
        if f.suffix.lower() in VIDEO_EXTENSIONS
    )
    if not video_files:
        print("No videos found.")
        return

    OUTPUT_CSV_PATH.parent.mkdir(parents=True, exist_ok=True)

    csv_rows = []
    with open(OUTPUT_CSV_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "video", "frame_number", "timestamp_s",
            "class_id", "class_name", "confidence",
            "bbox_x1", "bbox_y1", "bbox_x2", "bbox_y2",
            "bbox_width", "bbox_height",
        ])

        for vf in video_files:
            print(f"--- {vf.name} ---")
            stats = process_video(model, vf, writer)
            if stats is None:
                continue
            csv_rows.append(stats)

            nc = stats["no_det_frames"]
            print(f"  sampled : {stats['sampled']} frames"
                  f"  ({stats['sampled'] - nc} with detections, {nc} empty)")
            print(f"  dets    : {stats['total_dets']}")
            for cname in sorted(stats["class_counts"]):
                cnt  = stats["class_counts"][cname]
                avgc = stats["class_avg_conf"][cname]
                print(f"    {cname:<12}  count={cnt:<5}  avg_conf={avgc:.4f}")
            print()

    # ---- summary table ----
    print("=" * 62)
    print("  SUMMARY  —  detection counts across all sampled frames")
    print("=" * 62)

    header = f"  {'Video':<28} {'Sampled':>8} {'Detected':>9} {'Empty':>6}"
    print(header)
    print("  " + "-" * (len(header) - 2))
    for s in csv_rows:
        print(f"  {s['video']:<28} {s['sampled']:>8} "
              f"{s['sampled'] - s['no_det_frames']:>9} {s['no_det_frames']:>6}")

    # aggregate class counts
    agg_counts = defaultdict(int)
    agg_conf   = defaultdict(list)
    for s in csv_rows:
        for c, cnt in s["class_counts"].items():
            agg_counts[c] += cnt
        for c, ac in s["class_avg_conf"].items():
            agg_conf[c].append(ac)

    print(f"\n  Per-class totals:")
    for cname in sorted(VEHICLE_CLASSES.values()):
        cnt = agg_counts.get(cname, 0)
        conf_list = agg_conf.get(cname, [])
        overall_avg = round(sum(conf_list) / len(conf_list), 4) if conf_list else 0.0
        flag = ""
        if cnt == 0:
            flag = "  ** NOT detected in ANY sampled frame **"
        elif overall_avg < 0.4:
            flag = "  ** low confidence — review frames **"
        print(f"    {cname:<12} total={cnt:<6} avg_conf={overall_avg:.4f}{flag}")

    print(f"\nCSV saved to : {OUTPUT_CSV_PATH.resolve()}")
    print(f"Images saved : {OUTPUT_SCREENSHOT_DIR.resolve()}")


if __name__ == "__main__":
    main()
