"""
Traffic ML API
==============

FastAPI backend exposing the existing ML/CV pipeline with minimal changes.

This API reuses existing modules from src/ without modifying their core logic:
- config (paths, model, vehicle classes, tracker config)
- track_and_count (process_video, TrackInfo)

All thresholds and behavior are preserved. Traffic classification uses
activity-rate bands from traffic_condition_engine (dataset-relative).

Project title: Intelligent Traffic Monitoring and Prediction System Using Machine Learning and Computer Vision
"""
import asyncio
import logging
import os
import tempfile
import uuid
from pathlib import Path
from typing import Dict, Any, Optional

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# Project paths
PROJECT_ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = PROJECT_ROOT / "src"
YOLO_MODEL_PATH = PROJECT_ROOT / "yolov8n.pt"
TRACKER_CONFIG_PATH = SRC_DIR / "bytetrack_traffic.yaml"

# Import existing modules
import sys

sys.path.insert(0, str(SRC_DIR))

from config import (
    VEHICLE_CLASSES,
    TRACKER_CONFIG,
    CUSTOM_TRACKER,
)
from track_and_count import (
    process_video as _process_video,
    TrackInfo,
    _tracker_config,
    USE_CUSTOM_TRACKER,
)

logger = logging.getLogger("api.main")

app = FastAPI(
    title="Traffic ML API",
    description="Intelligent Traffic Monitoring and Prediction System - ML/CV API",
    version="1.0.0",
)

# CORS configuration
# Local development frontends. 127.0.0.1 is included because Vite reports the
# origin it is actually served from, and a browser treats the two as distinct.
# This is deliberately NOT a wildcard: allow_origins=["*"] with
# allow_credentials=True is rejected by the browser anyway, and an explicit list
# keeps the deployed API from being callable from any site.
allowed_origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

# The deployed frontend origin. Supplied at deploy time via the FRONTEND_ORIGIN
# environment variable (see render.yaml, which leaves it unset and prompts for
# it). No production URL is hardcoded, because the Cloudflare Pages domain does
# not exist yet.
#
# FRONTEND_ORIGIN accepts a comma-separated list so preview deployments can be
# allowed alongside the primary origin without a code change. Each entry must be
# a full scheme+host+port origin, with no trailing slash and no path.
extra_origins = os.getenv("FRONTEND_ORIGIN", "")
for candidate in extra_origins.split(","):
    origin = candidate.strip().rstrip("/")
    if origin and origin not in allowed_origins:
        allowed_origins.append(origin)

if extra_origins.strip():
    logger.info("CORS: %d configured origin(s) from FRONTEND_ORIGIN", len(extra_origins.split(",")))

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Upload constraints
# The upload is read fully into memory (`await file.read()`) before the video is
# written to a temp file, so the ceiling must stay well under the instance RAM.
# 50 MB keeps the buffer well inside the 2 GB Standard instance and well below
# the ~515 MB peak RSS of inference itself.
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "50"))
ALLOWED_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv"}

# Concurrency safeguard
# A single YOLOv8n + ByteTrack analysis peaks at roughly 515 MB RSS. Two
# simultaneous analyses would double that (plus each request's own upload
# buffer), so only one analysis is allowed to run at a time. A second request
# is rejected with HTTP 429 instead of competing for memory.
# 0 waits; 1 permits a single holder (the lock itself).
ANALYSIS_SLOTS = asyncio.Semaphore(1)


def classify_activity_rate(rate: float) -> str:
    """
    Activity-rate classification (dataset-relative thresholds from existing system).
    Preserves exact thresholds as specified:
    LOW: rate < 1.0
    MODERATE: 1.0 <= rate < 4.0
    HEAVY: 4.0 <= rate < 8.0
    CONGESTED: rate >= 8.0
    """
    if rate < 1.0:
        return "LOW"
    if rate < 4.0:
        return "MODERATE"
    if rate < 8.0:
        return "HEAVY"
    return "CONGESTED"


def compute_activity_rate(unique_active_identities: int, duration_seconds: float) -> Optional[float]:
    if duration_seconds <= 0:
        return None
    return unique_active_identities / duration_seconds if unique_active_identities >= 0 else 0.0


@app.get("/health")
async def health():
    ml_available = YOLO_MODEL_PATH.exists()
    return {
        "status": "ok",
        "service": "traffic-ml-api",
        "ml_available": ml_available,
    }


@app.get("/api/info")
async def info():
    ml_available = YOLO_MODEL_PATH.exists()
    return {
        "project_title": "Intelligent Traffic Monitoring and Prediction System Using Machine Learning and Computer Vision",
        "model": "YOLOv8n",
        # Filenames only. The previous response returned str(YOLO_MODEL_PATH),
        # which on a local machine disclosed an absolute Windows path containing
        # the username (e.g. C:\Users\<name>\...). Only the basename is safe to
        # publish.
        "model_file": YOLO_MODEL_PATH.name,
        "ml_available": ml_available,
        "tracker": "ByteTrack",
        # Basename only, for the same reason as model_file above. TRACKER_CONFIG
        # is already a bare filename while CUSTOM_TRACKER is an absolute path,
        # so Path(...).name handles both without leaking the directory.
        "tracker_config_file": Path(CUSTOM_TRACKER if USE_CUSTOM_TRACKER else TRACKER_CONFIG).name,
        "custom_tracker": bool(USE_CUSTOM_TRACKER),
        "inference_mode": "CPU",
        "on_demand_inference_available": ml_available,
        # Only public capability facts are published. The pipeline tuning
        # thresholds (hysteresis_frames, min_track_frames, confidence/IoU
        # defaults, ...) are internal configuration and are deliberately not
        # exposed; the frontend consumes none of them.
        "vehicle_classes": VEHICLE_CLASSES,
        "supported_video_formats": list(ALLOWED_EXTENSIONS),
        "max_upload_mb": MAX_UPLOAD_MB,
        "traffic_classification": {
            "description": "activity-rate classification (dataset-relative, not ground-truth congestion)",
            "bands": {
                "LOW": "rate < 1.0",
                "MODERATE": "1.0 <= rate < 4.0",
                "HEAVY": "4.0 <= rate < 8.0",
                "CONGESTED": "rate >= 8.0",
            },
        },
        "notes": "No unsupported accuracy metrics are claimed.",
        "concurrency": {
            "max_concurrent_analyses": 1,
            "busy_status_code": 429,
            "note": "One analysis at a time; a simultaneous request is rejected rather than queued.",
        },
    }


@app.post("/api/analyze-video")
async def analyze_video(file: UploadFile = File(...)):
    # Validate file exists
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    # Validate extension
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported video extension '{ext}'. Supported: {sorted(ALLOWED_EXTENSIONS)}",
        )

    # Check model exists. The absolute path is never returned — it would expose
    # the server's filesystem layout to an unauthenticated caller.
    if not YOLO_MODEL_PATH.exists():
        raise HTTPException(
            status_code=503,
            detail=(
                f"ML model '{YOLO_MODEL_PATH.name}' is not available on this server, "
                "so inference cannot run."
            ),
        )

    # Concurrency safeguard: one analysis at a time.
    # `locked()` and `acquire()` are separated by no await, so on a single event
    # loop no other request can take the slot in between.
    if ANALYSIS_SLOTS.locked():
        raise HTTPException(
            status_code=429,
            detail=(
                "Another video analysis is already running. "
                "Only one analysis is processed at a time because each one "
                "uses significant memory. Please wait for it to finish and retry."
            ),
        )
    await ANALYSIS_SLOTS.acquire()

    # Declared before the try so the cleanup in `finally` can always see it,
    # including when the request fails before the temp file is created.
    temp_path = None

    try:
        # Read file to check size. The underlying exception is not echoed back:
        # client/transport errors can embed the temp directory or absolute paths.
        try:
            content = await file.read()
        except Exception:
            raise HTTPException(
                status_code=400,
                detail="Could not read the uploaded file. The upload may have been interrupted.",
            )

        # Check size
        size_mb = len(content) / (1024 * 1024)
        if size_mb > MAX_UPLOAD_MB:
            raise HTTPException(
                status_code=413,
                detail=f"File too large ({size_mb:.1f}MB). Max allowed: {MAX_UPLOAD_MB}MB",
            )

        # Create safe temp file
        fd, temp_path_str = tempfile.mkstemp(suffix=ext, prefix=f"upload_{uuid.uuid4().hex}_")
        os.close(fd)
        temp_path = Path(temp_path_str)
        temp_path.write_bytes(content)

        # Import YOLO and run existing pipeline
        from ultralytics import YOLO

        model = YOLO(str(YOLO_MODEL_PATH))

        # Run existing process_video (preserves all logic)
        result = _process_video(model, temp_path)

        if result.get("status") != "OK":
            # result["status"] can contain a temp path or a decoder message with
            # filesystem detail, so only a generic, client-useful reason is sent.
            raise HTTPException(
                status_code=422,
                detail=(
                    "The video could not be decoded or processed. It may be corrupt, "
                    "truncated, or not a readable video file despite its extension."
                ),
            )

        # Build response with only calculable values
        unique_tracks = result.get("unique_tracks", 0)
        track_records = result.get("track_records", [])

        # Compute vehicle counts by class (from stable class as in pipeline)
        vehicle_counts = {
            "car": 0,
            "motorcycle": 0,
            "bus": 0,
            "truck": 0,
            "bicycle": 0,
        }
        for r in track_records:
            cls = r.get("vehicle_class_stable") or r.get("vehicle_class")
            if cls in vehicle_counts:
                vehicle_counts[cls] += 1

        # Compute conservative counts if available
        conservative_records = result.get("conservative", [])
        conservative_counts = {
            "car": 0,
            "motorcycle": 0,
            "bus": 0,
            "truck": 0,
            "bicycle": 0,
        }
        for r in conservative_records:
            cls = r.get("vehicle_class_stable") or r.get("vehicle_class")
            if cls in conservative_counts:
                conservative_counts[cls] += 1

        # Compute activity rate if we can
        total_frames = result.get("total_frames", 0)
        fps = result.get("fps", 0) or 0
        duration_seconds = total_frames / fps if fps > 0 else 0.0

        activity_rate = compute_activity_rate(unique_tracks, duration_seconds)
        traffic_condition = classify_activity_rate(activity_rate) if activity_rate is not None else None

        response: Dict[str, Any] = {
            "success": True,
            "model": "YOLOv8n",
            "tracker": "ByteTrack",
            "video_name": result.get("video"),
            "resolution": result.get("resolution"),
            "fps": result.get("fps"),
            "total_frames": result.get("total_frames"),
            "frames_processed": result.get("frames_processed"),
            "elapsed_s": result.get("elapsed_s"),
            "unique_tracks": unique_tracks,
            "conservative_tracks": result.get("conservative_tracks", 0),
            "new_track_gated": result.get("new_track_gated", 0),
            "vehicle_counts": vehicle_counts,
            "conservative_counts": conservative_counts,
            "stable_counts": result.get("stable_counts", {}),
            "counts": result.get("counts", {}),
            "duration_seconds": round(duration_seconds, 3) if duration_seconds > 0 else None,
            "activity_rate_ids_per_sec": round(activity_rate, 4) if activity_rate is not None else None,
            "traffic_condition": traffic_condition,
            "traffic_classification": {
                "description": "activity-rate classification (dataset-relative, not ground-truth congestion)",
                "bands": {
                    "LOW": "rate < 1.0",
                    "MODERATE": "1.0 <= rate < 4.0",
                    "HEAVY": "4.0 <= rate < 8.0",
                    "CONGESTED": "rate >= 8.0",
                },
                "applied": traffic_condition is not None,
            },
            "short_lived_count": len(result.get("short_lived", [])),
            "suspicious_count": len(result.get("suspicious", [])),
            "switches_count": len(result.get("switches", [])),
        }

        return JSONResponse(content=response)

    except HTTPException:
        raise
    except Exception:
        # Deliberately does not include str(e): an OpenCV/ultralytics exception
        # routinely embeds the temp file path, the model path or a traceback
        # frame, all of which disclose server internals. The exception type is
        # safe and helps triage without leaking anything.
        logger.exception("Unhandled error while analysing an uploaded video")
        raise HTTPException(
            status_code=500,
            detail="Internal error while processing the video. See server logs for details.",
        )
    finally:
        # Cleanup temp file
        if temp_path and temp_path.exists():
            try:
                temp_path.unlink()
            except Exception:
                pass  # Best effort cleanup

        # Release the single analysis slot, whether the request succeeded,
        # failed, or was rejected. Without this a raised exception would leave
        # the service permanently unable to analyse anything.
        ANALYSIS_SLOTS.release()


@app.get("/")
async def root():
    return {
        "message": "Traffic ML API - Use /health, /api/info, or POST /api/analyze-video",
        "endpoints": {
            "health": "/health",
            "info": "/api/info",
            "analyze": "/api/analyze-video (POST multipart/form-data)",
        },
    }
