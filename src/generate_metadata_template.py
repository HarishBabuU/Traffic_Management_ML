"""
Phase 2 - Step: Generate a template for manually-observed video metadata.
Merges the technical metadata (already generated) with empty columns
for subjective properties that require actually watching the video.
"""

import csv
from pathlib import Path

TECHNICAL_CSV = Path("data/metadata/video_technical_metadata.csv")
TEMPLATE_CSV = Path("data/metadata/video_observed_metadata.csv")

# Columns you will fill in yourself, after watching each video.
# Using fixed allowed values (not free text) keeps this usable as ML
# features later - free-text notes go in a separate 'notes' column instead.
OBSERVED_COLUMNS = [
    "traffic_level",        # allowed: none / low / moderate / high
    "weather",               # allowed: clear / cloudy / rain / fog / other
    "lighting",               # allowed: daylight / dusk / night
    "road_condition",         # allowed: dry / wet / poor / unknown
    "visible_car",             # allowed: yes / no
    "visible_motorcycle",
    "visible_bus",
    "visible_truck",
    "visible_autorickshaw",
    "visible_bicycle",
    "visible_van",
    "notes",                   # free text - anything unusual worth remembering
]


def main():
    if not TECHNICAL_CSV.exists():
        print(f"ERROR: run analyze_videos.py first - {TECHNICAL_CSV} not found.")
        return

    with open(TECHNICAL_CSV, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    for row in rows:
        for col in OBSERVED_COLUMNS:
            row[col] = ""  # blank - you fill these in by hand

    fieldnames = list(rows[0].keys())
    with open(TEMPLATE_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"Template created: {TEMPLATE_CSV.resolve()}")
    print("Open it in Excel and fill in the blank columns for each video.")


if __name__ == "__main__":
    main()