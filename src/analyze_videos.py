"""
Phase 2 - Step: Technical video metadata extractor.
Reads every video in data/raw_videos and records its technical
properties (resolution, FPS, frame count, duration, codec) into
a CSV file. Does NOT run any detection model - OpenCV only.
"""

import cv2
from pathlib import Path
import csv

# --- Configuration (edit these if your folder layout differs) ---
RAW_VIDEOS_DIR = Path("data/raw_videos")
OUTPUT_CSV = Path("data/metadata/video_technical_metadata.csv")

# Common video extensions we accept
VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv"}


def decode_fourcc(fourcc_int):
    """Convert OpenCV's numeric codec code into a readable 4-letter string."""
    return "".join([chr((int(fourcc_int) >> 8 * i) & 0xFF) for i in range(4)])


def analyze_video(video_path: Path) -> dict:
    """
    Open one video and extract its technical properties.
    Returns a dictionary of results, or an error dictionary if the
    video could not be opened or read.
    """
    cap = cv2.VideoCapture(str(video_path))

    if not cap.isOpened():
        return {
            "filename": video_path.name,
            "status": "ERROR - could not open file",
            "width": None, "height": None, "fps": None,
            "frame_count": None, "duration_seconds": None, "codec": None,
        }

    width = cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    height = cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    fourcc = cap.get(cv2.CAP_PROP_FOURCC)

    cap.release()

    # Guard against corrupt files reporting 0 fps (would crash a division)
    if fps and fps > 0:
        duration_seconds = round(frame_count / fps, 2)
    else:
        duration_seconds = None

    return {
        "filename": video_path.name,
        "status": "OK",
        "width": int(width) if width else None,
        "height": int(height) if height else None,
        "fps": round(fps, 2) if fps else None,
        "frame_count": int(frame_count) if frame_count else None,
        "duration_seconds": duration_seconds,
        "codec": decode_fourcc(fourcc) if fourcc else None,
    }


def main():
    if not RAW_VIDEOS_DIR.exists():
        print(f"ERROR: folder not found -> {RAW_VIDEOS_DIR.resolve()}")
        return

    video_files = sorted(
        [f for f in RAW_VIDEOS_DIR.iterdir() if f.suffix.lower() in VIDEO_EXTENSIONS]
    )

    if not video_files:
        print(f"No video files found in {RAW_VIDEOS_DIR.resolve()}")
        return

    print(f"Found {len(video_files)} video(s). Analyzing...\n")

    results = []
    for video_path in video_files:
        print(f"  - Analyzing: {video_path.name}")
        result = analyze_video(video_path)
        results.append(result)
        if result["status"] != "OK":
            print(f"    WARNING: {result['status']}")

    OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=results[0].keys())
        writer.writeheader()
        writer.writerows(results)

    print(f"\nDone. Metadata saved to: {OUTPUT_CSV.resolve()}")


if __name__ == "__main__":
    main()