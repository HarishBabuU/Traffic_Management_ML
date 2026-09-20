import csv
import json
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

INPUT = PROJECT_ROOT / "data" / "demo_processed_cctv" / "demo_cctv_summary.csv"
OUTPUT_JSON = PROJECT_ROOT / "data" / "demo_processed_cctv" / "demo_cctv_traffic_evidence.json"
OUTPUT_CSV = PROJECT_ROOT / "data" / "demo_processed_cctv" / "demo_cctv_traffic_evidence.csv"


def classify_activity(activity_index):
    if activity_index < 5:
        return "LOW"
    if activity_index < 25:
        return "MODERATE"
    if activity_index < 100:
        return "HIGH"
    return "VERY_HIGH"


rows = []

with INPUT.open("r", newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)

    for row in reader:
        frames = int(row["total_frames"])
        fps = float(row["fps"])
        conservative_tracks = int(row["conservative_tracks"])

        duration_seconds = frames / fps if fps > 0 else 0
        duration_minutes = duration_seconds / 60

        activity_rate = (
            conservative_tracks / duration_minutes
            if duration_minutes > 0
            else 0
        )

        activity_index = (
            conservative_tracks / frames * 1000
            if frames > 0
            else 0
        )

        rows.append({
            "route_id": row["route_id"],
            "cctv_id": row["cctv_id"],
            "source_video": row["source_video"],
            "status": row["status"],
            "total_frames": frames,
            "fps": fps,
            "duration_seconds": round(duration_seconds, 2),
            "duration_minutes": round(duration_minutes, 2),
            "conservative_tracks": conservative_tracks,

            # Original metric retained for reference
            "activity_rate_tracks_per_min": round(activity_rate, 3),

            # New normalized metric
            "activity_index_per_1000_frames": round(activity_index, 3),

            "activity_condition": classify_activity(activity_index),

            "live": False,
            "geographically_mapped": False,
            "source_type": "RECORDED DEMO",
        })


route_groups = {}

for row in rows:
    route_groups.setdefault(row["route_id"], []).append(row)


route_summary = []

for route_id, cameras in sorted(route_groups.items()):

    indexes = [
        camera["activity_index_per_1000_frames"]
        for camera in cameras
    ]

    average_index = sum(indexes) / len(indexes) if indexes else 0

    route_summary.append({
        "route_id": route_id,
        "camera_count": len(cameras),
        "average_activity_index_per_1000_frames": round(
            average_index, 3
        ),
        "activity_condition": classify_activity(average_index),
        "cctv_ids": [
            camera["cctv_id"]
            for camera in cameras
        ],
        "live": False,
        "geographically_mapped": False,
        "source_type": "RECORDED DEMO",
    })


evidence = {
    "kind": "DEMO CCTV TRAFFIC EVIDENCE",
    "source": "YOLOv8n + ByteTrack demo CCTV processing",

    "live": False,
    "geographically_mapped": False,

    "normalized_metric": {
        "name": "activity_index_per_1000_frames",
        "formula": "conservative_tracks / processed_frames * 1000",
        "purpose": "Normalize demo CCTV activity across clips with different durations and frame rates.",
    },

    "camera_evidence": rows,
    "route_summary": route_summary,

    "limitations": [
        "Recorded demo CCTV only.",
        "Not live CCTV.",
        "CCTV footage is not geographically mapped to real road coordinates.",
        "Activity index is a demo vehicle-activity indicator, not a direct measurement of real-world congestion.",
        "The original tracks-per-minute metric is retained for reference only.",
        "Route-level activity is an average across the registered demo cameras."
    ]
}


OUTPUT_JSON.write_text(
    json.dumps(evidence, indent=2),
    encoding="utf-8"
)


with OUTPUT_CSV.open("w", newline="", encoding="utf-8") as f:

    fieldnames = list(rows[0].keys())

    writer = csv.DictWriter(
        f,
        fieldnames=fieldnames
    )

    writer.writeheader()
    writer.writerows(rows)


print("DEMO CCTV EVIDENCE BUILD COMPLETE")
print()
print(f"Camera evidence rows: {len(rows)}")
print(f"Route summaries: {len(route_summary)}")
print()

for route in route_summary:

    print(
        f'{route["route_id"]}: '
        f'{route["average_activity_index_per_1000_frames"]} '
        f'activity index/1000 frames '
        f'-> {route["activity_condition"]}'
    )

print()
print(f"JSON: {OUTPUT_JSON}")
print(f"CSV : {OUTPUT_CSV}")
print()

print("Original data/processed was NOT modified.")
print("YOLO weights were NOT modified.")
print("ByteTrack configuration was NOT modified.")
print("No model training was performed.")
