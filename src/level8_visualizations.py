"""
Level 8C - FINAL VISUALIZATION (matplotlib)
============================================
Reads ONLY the existing Level 8 CSV/TXT results and produces professional
high-res PNG charts.  No detection, no tracking, no training, no merging,
no raw-video access, no writes outside data/processed/level8_visualizations/.

Inputs (read-only):
    data/processed/level8_traffic_statistics.csv
    data/processed/level8_class_by_video.csv
    data/processed/level8_track_duration_statistics.csv
    data/processed/level8_traffic_over_time.csv
    data/processed/level8_summary.txt                    (optional read)

Outputs (new):
    data/processed/level8_visualizations/
        vehicle_count_by_class.png
        vehicle_count_by_video.png
        class_distribution.png
        conservative_vs_corrected.png
        traffic_activity_over_time.png
        track_duration_distribution.png
        class_by_video.png
        level8_visual_summary.png

Data rule: the traffic-over-time chart reports "unique active tracked
identities per time interval".  Interval values are NEVER summed into a
vehicle total (the same vehicle can appear in many intervals).
"""

import csv
import math
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA = PROJECT_ROOT / "data" / "processed"
OUT_DIR = DATA / "level8_visualizations"

STAT_CSV = DATA / "level8_traffic_statistics.csv"
CLASS_VIDEO_CSV = DATA / "level8_class_by_video.csv"
DURATION_CSV = DATA / "level8_track_duration_statistics.csv"
OVER_TIME_CSV = DATA / "level8_traffic_over_time.csv"
SUMMARY_TXT = DATA / "level8_summary.txt"

CLASSES = ["car", "motorcycle", "bus", "truck", "bicycle"]
CLASS_LABELS = {"car": "Car", "motorcycle": "Motorcycle", "bus": "Bus",
                "truck": "Truck", "bicycle": "Bicycle"}
CLASS_COLORS = {"car": "#4C72B0", "motorcycle": "#DD8452", "bus": "#55A868",
                "truck": "#C44E52", "bicycle": "#8172B3"}

VIDEO_DISPLAY = {"low traffic.mp4": "low traffic",
                 "no traffic video.mp4": "no traffic",
                 "traffic.mp4": "traffic"}
VIDEO_COLORS = {"low traffic.mp4": "#4C72B0",
                "no traffic video.mp4": "#55A868",
                "traffic.mp4": "#C44E52"}

EXPECTED_TOTAL = 122
EXPECTED_CONSERVATIVE = 108

FIG_W, FIG_H, DPI = 16, 9, 100  # 1600x900 px

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 15,
    "axes.titlesize": 20,
    "axes.titleweight": "bold",
    "axes.labelsize": 16,
    "axes.edgecolor": "#555555",
    "axes.linewidth": 1.0,
    "figure.facecolor": "white",
    "axes.facecolor": "#FAFAFA",
    "grid.color": "#DDDDDD",
    "grid.linestyle": "-",
    "grid.alpha": 0.8,
    "legend.frameon": True,
    "legend.facecolor": "white",
    "legend.edgecolor": "#BBBBBB",
})


# ── tiny validation helpers ────────────────────────────────────────────────
def fail(msg):
    print(f"VALIDATION STOP: {msg}")
    sys.exit(1)


def load_csv(path, required_cols):
    if not path.exists():
        fail(f"input file missing: {path}")
    with open(path, "r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        cols = reader.fieldnames or []
        for c in required_cols:
            if c not in cols:
                fail(f"{path.name}: missing required column '{c}' "
                     f"(have {cols})")
        rows = list(reader)
    if not rows:
        fail(f"{path.name}: no data rows")
    return rows


def to_number(value, path, row, col):
    try:
        f = float(value)
    except (TypeError, ValueError, OverflowError):
        fail(f"{path.name}: non-numeric value for '{col}' in row {row}: {value!r}")
    if math.isnan(f) or math.isinf(f):
        fail(f"{path.name}: NaN/inf value for '{col}' in row {row}: {value!r}")
    return f


def numeric_rows(path, required_cols, numeric_cols):
    rows = load_csv(path, required_cols)
    for i, r in enumerate(rows, start=2):
        for c in numeric_cols:
            to_number(r[c], path, i, c)
    return rows


def finish(fig, name, title=None):
    fig.suptitle(title, fontsize=22, fontweight="bold", y=0.985) if title else None
    fig.tight_layout(rect=(0, 0, 1, 0.97) if title else None)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / name
    fig.savefig(out, dpi=DPI, facecolor="white")
    plt.close(fig)
    return out


def bar_labels(ax, bars, formatter=str, dy=0.02, fs=15):
    for bar in bars:
        h = bar.get_height()
        ax.annotate(formatter(h), (bar.get_x() + bar.get_width() / 2, h),
                    ha="center", va="bottom", fontsize=fs, fontweight="bold",
                    xytext=(0, 6), textcoords="offset points")


def main():
    # ── load + validate inputs ─────────────────────────────────────────────
    stat_rows = load_csv(STAT_CSV, ["metric", "value", "note"])
    stats = {}
    for i, r in enumerate(stat_rows, start=2):
        v = r["value"]
        try:
            stats[r["metric"]] = float(v)
        except (TypeError, ValueError):
            stats[r["metric"]] = v
    total = stats.get("total_corrected_identities")
    conservative = stats.get("total_conservative_identities")
    if total is None or conservative is None:
        fail("level8_traffic_statistics.csv: missing mandatory metric rows")
    total = int(total)
    conservative = int(conservative)
    if total != EXPECTED_TOTAL:
        fail(f"corrected total {total} != expected {EXPECTED_TOTAL}")
    if conservative != EXPECTED_CONSERVATIVE:
        fail(f"conservative total {conservative} != expected {EXPECTED_CONSERVATIVE}")

    class_counts = {}
    for c in CLASSES:
        key = f"class_{c}_stable_count"
        if key not in stats:
            fail(f"level8_traffic_statistics.csv: missing metric '{key}'")
        class_counts[c] = int(stats[key])
    if sum(class_counts.values()) != total:
        fail(f"class counts {sum(class_counts.values())} != total {total}")

    class_video_rows = numeric_rows(CLASS_VIDEO_CSV,
                                    ["video"], ["total"] + CLASSES)
    videos = [r["video"] for r in class_video_rows]
    video_totals = [int(round(float(r["total"]))) for r in class_video_rows]
    for row in class_video_rows:
        v = row["video"]
        n = int(round(float(row["total"])))
        row_sum = int(round(sum(float(row[c]) for c in CLASSES)))
        if row_sum != n:
            fail(f"level8_class_by_video.csv: {v} class rows ({row_sum}) "
                 f"!= total column ({n})")
    if sum(video_totals) != total:
        fail(f"video totals {sum(video_totals)} != total {total}")

    dur_rows = numeric_rows(DURATION_CSV,
                            ["video", "track_id", "vehicle_class_stable",
                             "first_frame", "last_frame"],
                            ["tracked_rows", "duration_frames", "duration_seconds"])
    if len(dur_rows) != total:
        fail(f"duration file has {len(dur_rows)} tracks != {total} identities")
        fail(f"duration file has {len(dur_rows)} tracks != {total} identities")

    time_rows = numeric_rows(OVER_TIME_CSV,
                             ["video", "interval_seconds"],
                             ["start_frame", "end_frame",
                              "unique_active_identities", "trajectory_observations"])

    # optional read of summary text (not parsed / not required)
    if SUMMARY_TXT.exists():
        summary_text = SUMMARY_TXT.read_text(encoding="utf-8")
    else:
        summary_text = ""

    # ── 1. vehicle_count_by_class.png ──────────────────────────────────────
    fig, ax = plt.subplots(figsize=(FIG_W, FIG_H))
    xs = range(len(CLASSES))
    bars = ax.bar(xs, [class_counts[c] for c in CLASSES],
                  color=[CLASS_COLORS[c] for c in CLASSES], width=0.62,
                  edgecolor="#333333", linewidth=1.0)
    ax.set_xticks(list(xs))
    ax.set_xticklabels([CLASS_LABELS[c] for c in CLASSES])
    ax.set_ylabel("Number of vehicles")
    ax.set_ylim(0, max(class_counts.values()) * 1.18)
    bar_labels(ax, bars)
    ax.grid(axis="y")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    finish(fig, "vehicle_count_by_class.png",
           title="Final Vehicle Count by Class")

    # ── 2. vehicle_count_by_video.png ─────────────────────────────────────
    fig, ax = plt.subplots(figsize=(FIG_W, FIG_H))
    xs = range(len(videos))
    bars = ax.bar(xs, video_totals,
                  color=[VIDEO_COLORS[v] for v in videos], width=0.5,
                  edgecolor="#333333", linewidth=1.0)
    ax.set_xticks(list(xs))
    ax.set_xticklabels([VIDEO_DISPLAY[v] for v in videos])
    ax.set_ylabel("Number of vehicles")
    ax.set_ylim(0, max(video_totals) * 1.18)
    bar_labels(ax, bars)
    ax.grid(axis="y")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    finish(fig, "vehicle_count_by_video.png",
           title="Final Vehicle Count by Video")

    # ── 3. class_distribution.png ─────────────────────────────────────────
    fig, ax = plt.subplots(figsize=(FIG_W, FIG_H))
    counts = [class_counts[c] for c in CLASSES]
    labels = [f"{CLASS_LABELS[c]} ({class_counts[c]})" for c in CLASSES]
    wedges, _, autotexts = ax.pie(
        counts, labels=labels, autopct=lambda p: f"{p:.1f}%",
        colors=[CLASS_COLORS[c] for c in CLASSES],
        startangle=140, counterclock=False,
        wedgeprops={"edgecolor": "white", "linewidth": 2},
        pctdistance=0.75, labeldistance=1.06, textprops={"fontsize": 15})
    for at in autotexts:
        at.set_fontsize(13)
        at.set_fontweight("bold")
        at.set_color("white")
    ax.set_title("Vehicle Class Distribution\n"
                 f"Total corrected vehicles = {total}",
                 fontsize=20, fontweight="bold", pad=18)
    finish(fig, "class_distribution.png", title=None)

    # ── 4. conservative_vs_corrected.png ──────────────────────────────────
    fig, ax = plt.subplots(figsize=(FIG_W, FIG_H))
    cats = ["Corrected", "Conservative"]
    vals = [total, conservative]
    bar_colors = ["#2E5FA3", "#88AACC"]
    bars = ax.bar(cats, vals, color=bar_colors, width=0.5,
                  edgecolor="#333333", linewidth=1.0)
    ax.set_ylabel("Number of vehicles")
    ax.set_ylim(0, max(vals) * 1.18)
    bar_labels(ax, bars)
    ax.grid(axis="y")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.annotate("Conservative: tracks with ≥ 3 frames and mean confidence ≥ 0.30",
                xy=(0.5, -0.06), xycoords="axes fraction", ha="center",
                fontsize=13, color="#444444")
    finish(fig, "conservative_vs_corrected.png",
           title="Corrected vs Conservative Vehicle Count")

    # ── 5. traffic_activity_over_time.png ─────────────────────────────────
    fig, ax = plt.subplots(figsize=(FIG_W, FIG_H))
    for vid in videos:
        rows = [r for r in time_rows if r["video"] == vid]
        rows.sort(key=lambda r: r["interval_seconds"])
        mids, vals = [], []
        for r in rows:
            lo, hi = (float(x) for x in r["interval_seconds"].split("-"))
            mids.append((lo + hi) / 2.0)
            vals.append(int(round(float(r["unique_active_identities"]))))
        ax.plot(mids, vals, marker="o", linewidth=2.5, markersize=8,
                color=VIDEO_COLORS[vid], label=VIDEO_DISPLAY[vid])
        for x, y in zip(mids, vals):
            ax.annotate(str(y), (x, y), textcoords="offset points",
                        xytext=(0, 9), ha="center", fontsize=12, color="#333333")
    ax.set_xlabel("Elapsed time (seconds)")
    ax.set_ylabel("Unique active tracked identities in interval")
    ax.grid(axis="both")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.legend(title="Video", loc="upper right", fontsize=13, title_fontsize=14)
    ax.text(0.01, 0.015,
            "Interval bins differ per video (low / no traffic: 5 s, traffic: 3 s).\n"
            "Y axis is NOT a running total — the same vehicle can appear in multiple intervals.",
            transform=ax.transAxes, fontsize=12, color="#444444", va="bottom")
    finish(fig, "traffic_activity_over_time.png",
           title="Traffic Activity Over Time")

    # ── 6. track_duration_distribution.png ────────────────────────────────
    frames = [float(r["duration_frames"]) for r in dur_rows]
    seconds = [float(r["duration_seconds"]) for r in dur_rows]
    import statistics as st
    mean_f, med_f = st.mean(frames), st.median(frames)
    mean_s, med_s = st.mean(seconds), st.median(seconds)

    fig, axes = plt.subplots(1, 2, figsize=(FIG_W, FIG_H))
    bins_f = list(range(0, int(max(frames)) + 20, 25))
    axes[0].hist(frames, bins=bins_f, color="#4C72B0", edgecolor="white",
                 linewidth=1.2)
    for val, col, lab in [(mean_f, "#C44E52", f"mean {mean_f:.1f}"),
                          (med_f, "#2E5FA3", f"median {med_f:.0f}")]:
        axes[0].axvline(val, color=col, linewidth=2.2, linestyle="--",
                        label=lab)
    axes[0].set_xlabel("Track duration (frames)")
    axes[0].set_ylabel("Number of vehicles")
    axes[0].set_title("Duration in frames\n"
                      "(inclusive span = last frame − first frame + 1)",
                      fontsize=16)
    axes[0].legend(fontsize=12)
    axes[0].grid(axis="y")

    bins_s = list([round(x, 2) for x in
                   [i * 0.5 for i in range(0, int(max(seconds) * 2) + 2)]])
    axes[1].hist(seconds, bins=bins_s, color="#55A868", edgecolor="white",
                 linewidth=1.2)
    for val, col, lab in [(mean_s, "#C44E52", f"mean {mean_s:.2f} s"),
                          (med_s, "#2E5FA3", f"median {med_s:.2f} s")]:
        axes[1].axvline(val, color=col, linewidth=2.2, linestyle="--",
                        label=lab)
    axes[1].set_xlabel("Track duration (seconds)")
    axes[1].set_ylabel("Number of vehicles")
    axes[1].set_title("Duration in seconds\n(per-video container FPS: "
                      "23.98 / 59.94 / 50.0)", fontsize=16)
    axes[1].legend(fontsize=12)
    axes[1].grid(axis="y")

    finish(fig, "track_duration_distribution.png",
           title="Vehicle Track Duration Statistics")

    # ── 7. class_by_video.png ─────────────────────────────────────────────
    fig, ax = plt.subplots(figsize=(FIG_W, FIG_H))
    n_v = len(videos)
    width = 0.78 / len(CLASSES)
    xs = range(n_v)
    import numpy as np
    for ci, c in enumerate(CLASSES):
        vals = [int(round(float(r[c]))) for r in class_video_rows]
        offs = [x + (ci - (len(CLASSES) - 1) / 2) * width for x in xs]
        bars = ax.bar(offs, vals, width=width * 0.92, label=CLASS_LABELS[c],
                      color=CLASS_COLORS[c], edgecolor="#333333", linewidth=0.8)
        for bar, v in zip(bars, vals):
            if v:
                ax.annotate(str(v), (bar.get_x() + bar.get_width() / 2,
                                     bar.get_height()),
                            ha="center", va="bottom", fontsize=11,
                            fontweight="bold", xytext=(0, 2),
                            textcoords="offset points")
    ax.set_xticks(list(xs))
    ax.set_xticklabels([VIDEO_DISPLAY[v] for v in videos])
    ax.set_ylabel("Number of vehicles")
    ax.set_ylim(0, 48)
    ax.grid(axis="y")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.legend(fontsize=13, ncol=len(CLASSES), loc="upper right")
    finish(fig, "class_by_video.png", title="Vehicle Classes by Video")

    # ── 8. level8_visual_summary.png (dashboard, optional extra) ──────────
    fig = plt.figure(figsize=(FIG_W, FIG_H))
    gs = fig.add_gridspec(2, 2, hspace=0.42, wspace=0.20, top=0.86, bottom=0.10,
                          left=0.09, right=0.94)
    # top banner with headline numbers
    fig.text(0.5, 0.93,
             f"Level 8 Final Summary — Corrected vehicles = {total}   |   "
             f"Conservative vehicles = {conservative}",
             ha="center", fontsize=22, fontweight="bold")

    # (a) class bar
    ax = fig.add_subplot(gs[0, 0])
    bars = ax.bar([CLASS_LABELS[c] for c in CLASSES],
                  [class_counts[c] for c in CLASSES],
                  color=[CLASS_COLORS[c] for c in CLASSES],
                  edgecolor="#333333", linewidth=0.8)
    bar_labels(ax, bars, fs=12)
    ax.set_title("Vehicle Count by Class", fontsize=15, fontweight="bold")
    ax.set_ylabel("Vehicles", fontsize=12)
    ax.tick_params(axis="x", labelsize=10, rotation=20)
    ax.grid(axis="y")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)

    # (b) video bar
    ax = fig.add_subplot(gs[0, 1])
    bars = ax.bar([VIDEO_DISPLAY[v] for v in videos], video_totals,
                  color=[VIDEO_COLORS[v] for v in videos],
                  edgecolor="#333333", linewidth=0.8)
    bar_labels(ax, bars, fs=12)
    ax.set_title("Vehicle Count by Video", fontsize=15, fontweight="bold")
    ax.set_ylabel("Vehicles", fontsize=12)
    ax.grid(axis="y")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)

    # (c) corrected vs conservative
    ax = fig.add_subplot(gs[1, 0])
    bars = ax.bar(["Corrected", "Conservative"], [total, conservative],
                  color=["#2E5FA3", "#88AACC"], width=0.5,
                  edgecolor="#333333", linewidth=0.8)
    bar_labels(ax, bars, fs=13)
    ax.set_title("Corrected vs Conservative", fontsize=15, fontweight="bold")
    ax.set_ylabel("Vehicles", fontsize=12)
    ax.set_ylim(0, total * 1.25)
    ax.grid(axis="y")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)

    # (d) class pie
    ax = fig.add_subplot(gs[1, 1])
    ax.pie([class_counts[c] for c in CLASSES],
           labels=[CLASS_LABELS[c] for c in CLASSES],
           autopct=lambda p: f"{p:.1f}%",
           colors=[CLASS_COLORS[c] for c in CLASSES],
           startangle=140, counterclock=False,
           wedgeprops={"edgecolor": "white", "linewidth": 1.5},
           pctdistance=0.7, labeldistance=1.08, textprops={"fontsize": 10})
    ax.set_title("Class Distribution", fontsize=15, fontweight="bold")

    finish(fig, "level8_visual_summary.png", title=None)

    # ── report ─────────────────────────────────────────────────────────────
    print("=" * 70)
    print("  LEVEL 8C VISUALIZATION COMPLETE")
    print("=" * 70)
    print(f"  Corrected total   : {total}  (expected {EXPECTED_TOTAL})  -> OK")
    print(f"  Conservative total: {conservative}  (expected {EXPECTED_CONSERVATIVE})  -> OK")
    print(f"  Inputs validated  : {len(stat_rows)} stat rows, {len(class_video_rows)} video-class rows, "
          f"{len(dur_rows)} duration tracks, {len(time_rows)} time intervals")
    print("  Output images:")
    for p in sorted(OUT_DIR.glob("*.png")):
        print(f"    {p.name}")
    print("=" * 70)


if __name__ == "__main__":
    main()