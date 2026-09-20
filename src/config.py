"""
Shared configuration for the traffic analysis pipeline.
All paths, class mappings, and default thresholds live here.
"""

from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
RAW_VIDEOS_DIR = PROJECT_ROOT / "data" / "raw_videos"
PROCESSED_DIR = PROJECT_ROOT / "data" / "processed"
METADATA_DIR = PROJECT_ROOT / "data" / "metadata"
OUTPUTS_DIR = PROJECT_ROOT / "outputs"
SCREENSHOTS_DIR = OUTPUTS_DIR / "screenshots"
GRAPHS_DIR = OUTPUTS_DIR / "graphs"
MODELS_DIR = PROJECT_ROOT / "models"

# ── Video discovery ────────────────────────────────────────────
VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv"}

# ── Vehicle-relevant COCO class IDs ───────────────────────────
# COCO: 0=person 1=bicycle 2=car 3=motorcycle 4=airplane 5=bus 6=train 7=truck
# NOTE: "auto-rickshaw" and "van" are NOT separate COCO classes.
#       Auto-rickshaw will be missed; vans may appear as car or truck.
VEHICLE_CLASSES = {
    1: "bicycle",
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
}
VEHICLE_CLASS_IDS = list(VEHICLE_CLASSES.keys())

# ── Detection defaults ─────────────────────────────────────────
DEFAULT_CONFIDENCE = 0.25
DEFAULT_IOU_THRESHOLD = 0.45

# ── Level 5: temporal class stabilization ──────────────────────
# Consecutive frames a candidate class must persist before a class
# switch is accepted (hysteresis). Displayed/derived labels only;
# never affects ByteTrack IDs or counts.
HYSTERESIS_FRAMES = 5

# ── Model ──────────────────────────────────────────────────────
DEFAULT_MODEL = "yolov8n.pt"

# ── ByteTrack config (inside ultralytics package) ─────────────
TRACKER_CONFIG = "bytetrack.yaml"
# Tuned ByteTrack config for this project (see src/bytetrack_traffic.yaml).
# Uses new_track_thresh=0.35 + track_low_thresh=0.20, rest unchanged.
CUSTOM_TRACKER = str(Path(__file__).resolve().parent / "bytetrack_traffic.yaml")
