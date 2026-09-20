"""
Safe demo CCTV processor.

Processes ONLY:
    data/demo_cctv/route_a
    data/demo_cctv/route_b
    data/demo_cctv/route_c

Reuses the existing YOLO + ByteTrack implementation from
src/track_and_count.py.

Does NOT modify:
    data/processed
    data/raw_videos
    outputs/screenshots
    yolov8n.pt
    src/bytetrack_traffic.yaml
"""

import argparse
import csv
import sys
from pathlib import Path
from collections import defaultdict

PROJECT_ROOT = Path(__file__).resolve().parent.parent

DEMO_CCTV_DIR = PROJECT_ROOT / "data" / "demo_cctv"
DEMO_PROCESSED_DIR = PROJECT_ROOT / "data" / "demo_processed_cctv"
DEMO_OUTPUT_DIR = PROJECT_ROOT / "outputs" / "demo_cctv"

sys.path.insert(0, str(PROJECT_ROOT / "src"))

import track_and_count as tracker
from ultralytics import YOLO


ROUTE_CCTV_IDS = {
    "route_a": ["CCTV-A01", "CCTV-A02", "CCTV-A03"],
    "route_b": ["CCTV-B01", "CCTV-B02", "CCTV-B03"],
    "route_c": ["CCTV-C01", "CCTV-C02", "CCTV-C03"],
}


def discover_videos():
    discovered = []

    for route_id, cctv_ids in ROUTE_CCTV_IDS.items():
        route_dir = DEMO_CCTV_DIR / route_id

        if not route_dir.exists():
            print(f"WARNING: missing directory: {route_dir}")
            continue

        videos = sorted(
            p for p in route_dir.iterdir()
            if p.is_file()
            and p.suffix.lower() in tracker.VIDEO_EXTENSIONS
        )

        for index, video_path in enumerate(videos):
            if index >= len(cctv_ids):
                print(
                    f"WARNING: more than 3 videos in {route_id}; "
                    f"ignoring: {video_path.name}"
                )
                continue

            discovered.append({
                "route_id": route_id,
                "cctv_id": cctv_ids[index],
                "video_path": video_path,
            })

    return discovered


def dry_run(videos):
    print("=" * 72)
    print("DEMO CCTV DRY RUN")
    print("=" * 72)

    print(f"Demo input : {DEMO_CCTV_DIR}")
    print(f"Data output: {DEMO_PROCESSED_DIR}")
    print(f"Image output: {DEMO_OUTPUT_DIR}")
    print()

    print(f"Videos discovered: {len(videos)}")
    print()

    for item in videos:
        print(
            f"{item['route_id']:<10} "
            f"{item['cctv_id']:<10} "
            f"{item['video_path'].name}"
        )
        print(f"           input : {item['video_path']}")

    print()
    print("NO YOLO PROCESSING")
    print("NO FILES WRITTEN")
    print("Existing data/processed is untouched.")
    print("Existing outputs/screenshots are untouched.")
    print("=" * 72)


def process_all(videos):
    DEMO_PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    DEMO_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Redirect ONLY the imported tracker's annotated-frame output.
    # The original tracker source code is not modified.
    tracker.SCREENSHOTS_DIR = DEMO_OUTPUT_DIR

    # Keep the exact existing tracking defaults.
    tracker.CONFIDENCE = tracker.DEFAULT_CONFIDENCE
    tracker.IOU = tracker.DEFAULT_IOU_THRESHOLD
    tracker.FRAME_STEP = 1
    tracker.ANNOTATED_PER_VIDEO = 6

    print("=" * 72)
    print("YOLOv8n + ByteTrack DEMO CCTV PROCESSING")
    print("=" * 72)
    print(f"Model   : {tracker.DEFAULT_MODEL}")
    print(f"Tracker : {tracker._tracker_config()}")
    print(f"Conf    : {tracker.CONFIDENCE}")
    print(f"IoU     : {tracker.IOU}")
    print(f"Device  : CPU")
    print(f"Step    : every {tracker.FRAME_STEP} frame")
    print()

    model = YOLO(tracker.DEFAULT_MODEL)

    all_tracks = []
    all_trajectories = []
    summary_rows = []

    for number, item in enumerate(videos, start=1):
        print("-" * 72)
        print(
            f"[{number}/{len(videos)}] "
            f"{item['route_id']} / {item['cctv_id']}"
        )
        print(f"Video: {item['video_path'].name}")

        result = tracker.process_video(model, item["video_path"])

        if result["status"] != "OK":
            print(f"ERROR: {result['status']}")
            summary_rows.append({
                "route_id": item["route_id"],
                "cctv_id": item["cctv_id"],
                "source_video": item["video_path"].name,
                "status": result["status"],
            })
            continue

        for record in result["track_records"]:
            row = dict(record)
            row["route_id"] = item["route_id"]
            row["cctv_id"] = item["cctv_id"]
            all_tracks.append(row)

        for row in result["trajectory_rows"]:
            row = dict(row)
            row["route_id"] = item["route_id"]
            row["cctv_id"] = item["cctv_id"]
            all_trajectories.append(row)

        summary_rows.append({
            "route_id": item["route_id"],
            "cctv_id": item["cctv_id"],
            "source_video": item["video_path"].name,
            "status": "OK",
            "resolution": result["resolution"],
            "fps": result["fps"],
            "total_frames": result["total_frames"],
            "frames_processed": result["frames_processed"],
            "unique_tracks": result["unique_tracks"],
            "conservative_tracks": result["conservative_tracks"],
            "cars": result["counts"].get("car", 0),
            "motorcycles": result["counts"].get("motorcycle", 0),
            "buses": result["counts"].get("bus", 0),
            "trucks": result["counts"].get("truck", 0),
            "bicycles": result["counts"].get("bicycle", 0),
            "elapsed_s": result["elapsed_s"],
        })

        print(f"Resolution      : {result['resolution']}")
        print(f"FPS             : {result['fps']}")
        print(f"Frames processed: {result['frames_processed']}")
        print(f"Unique tracks   : {result['unique_tracks']}")
        print(f"Conservative    : {result['conservative_tracks']}")
        print(f"Elapsed         : {result['elapsed_s']}s")

    # Per-track output
    track_csv = DEMO_PROCESSED_DIR / "demo_vehicle_tracking_results.csv"

    track_fields = [
        "route_id",
        "cctv_id",
        "video",
        "track_id",
        "vehicle_class",
        "coco_class_id",
        "first_frame",
        "last_frame",
        "first_timestamp",
        "last_timestamp",
        "frames_tracked",
        "class_agreement",
        "confidence_average",
        "vehicle_class_stable",
        "coco_class_id_stable",
        "class_agreement_stable",
        "hysteresis_switches",
    ]

    with open(track_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=track_fields)
        writer.writeheader()

        for row in all_tracks:
            writer.writerow({
                field: row.get(field, "")
                for field in track_fields
            })

    # Per-frame trajectory output
    trajectory_csv = DEMO_PROCESSED_DIR / "demo_vehicle_trajectories.csv"

    trajectory_fields = [
        "route_id",
        "cctv_id",
        "video",
        "frame",
        "track_id",
        "vehicle_class",
        "vehicle_class_stable",
        "confidence",
        "x1",
        "y1",
        "x2",
        "y2",
        "centroid_x",
        "centroid_y",
    ]

    all_trajectories.sort(
        key=lambda row: (
            row["route_id"],
            row["cctv_id"],
            row["track_id"],
            row["frame"],
        )
    )

    with open(trajectory_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=trajectory_fields
        )
        writer.writeheader()

        for row in all_trajectories:
            writer.writerow({
                field: row.get(field, "")
                for field in trajectory_fields
            })

    # Per-video summary
    summary_csv = DEMO_PROCESSED_DIR / "demo_cctv_summary.csv"

    summary_fields = [
        "route_id",
        "cctv_id",
        "source_video",
        "status",
        "resolution",
        "fps",
        "total_frames",
        "frames_processed",
        "unique_tracks",
        "conservative_tracks",
        "cars",
        "motorcycles",
        "buses",
        "trucks",
        "bicycles",
        "elapsed_s",
    ]

    with open(summary_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=summary_fields
        )
        writer.writeheader()

        for row in summary_rows:
            writer.writerow({
                field: row.get(field, "")
                for field in summary_fields
            })

    print()
    print("=" * 72)
    print("DEMO CCTV PROCESSING COMPLETE")
    print("=" * 72)
    print(f"Track results : {track_csv}")
    print(f"Trajectories  : {trajectory_csv}")
    print(f"Summary       : {summary_csv}")
    print(f"Annotated     : {DEMO_OUTPUT_DIR}")
    print()
    print("Original data/processed was NOT used as an output.")
    print("Original outputs/screenshots was NOT used as an output.")
    print("YOLO weights were NOT modified.")
    print("ByteTrack configuration was NOT modified.")
    print("NO TRAINING WAS PERFORMED.")
    print("=" * 72)


def main():
    parser = argparse.ArgumentParser(
        description="Safe YOLO + ByteTrack processor for demo CCTV."
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List demo videos without loading YOLO or writing files.",
    )

    args = parser.parse_args()

    videos = discover_videos()

    if len(videos) != 9:
        print(
            f"ERROR: expected exactly 9 demo videos, "
            f"but discovered {len(videos)}."
        )

        for item in videos:
            print(
                f"  {item['route_id']} "
                f"{item['cctv_id']} "
                f"{item['video_path'].name}"
            )

        sys.exit(1)

    if args.dry_run:
        dry_run(videos)
        return

    process_all(videos)


if __name__ == "__main__":
    main()
