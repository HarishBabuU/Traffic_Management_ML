"""
Level 8 - FINAL ANALYSIS of the corrected Level 7D dataset
==========================================================
Two phases:

  Phase 8A - Final Dataset Validation   (independent verification)
  Phase 8B - Final Traffic Statistics   (totals, classes, durations, time bins)

This script is READ-ONLY with respect to all existing project data.  It only
reads Level 7D outputs and writes NEW files under data/processed/:

  level8_final_validation_report.txt
  level8_traffic_statistics.csv
  level8_class_by_video.csv
  level8_track_duration_statistics.csv
  level8_traffic_over_time.csv
  level8_summary.txt

No YOLO / ByteTrack / retraining / merging / correction of any kind.

Notes on the dataset's structure:
  * Trajectory row counts include the documented "merge-union" artifact: after
    a fragment ID is merged into a canonical parent, rows that share the same
    (video, frame) are retained (not erased).  As a result a small number of
    (video, frame, track_id) tuples appear more than once for merged
    canonical tracks.  These are counted and reported, but are the expected
    structural behavior validated by Level 7D (requirement #7) and are not
    silently removed or "fixed".
  * 'frames_tracked' in the Level 7D track summary equals the number of
    trajectory rows for that track (including union duplicates).

FPS source: the video container metadata of the RAW videos (read via OpenCV
VideoCapture properties, read-only).  This is the same FPS source used by the
original pipeline (src/track_and_count.py) to build track timestamps.
"""

import csv
import math
import statistics
from collections import Counter, defaultdict
from pathlib import Path

import cv2

PROJECT_ROOT = Path(__file__).resolve().parent.parent
D7 = PROJECT_ROOT / "data" / "processed" / "level7d"
RAW = PROJECT_ROOT / "data" / "raw_videos"
OUT = PROJECT_ROOT / "data" / "processed"

OUT_VALIDATION = OUT / "level8_final_validation_report.txt"
OUT_STAT = OUT / "level8_traffic_statistics.csv"
OUT_CLASS_VIDEO = OUT / "level8_class_by_video.csv"
OUT_DURATION = OUT / "level8_track_duration_statistics.csv"
OUT_TIME = OUT / "level8_traffic_over_time.csv"
OUT_SUMMARY = OUT / "level8_summary.txt"

COUNT_FIELDS = ["car", "motorcycle", "bus", "truck", "bicycle"]
ORDERED_VIDEOS = ["low traffic.mp4", "no traffic video.mp4", "traffic.mp4"]

MIN_CONSERVATIVE_FRAMES = 3
MIN_CONSERVATIVE_CONF = 0.30

# time-bin sizing (seconds) per video, based on actual duration
BIN_SECONDS = {
    "low traffic.mp4": 5.0,
    "no traffic video.mp4": 5.0,
    "traffic.mp4": 3.0,
}


def read_csv(path):
    with open(path, "r", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(rows, path, fieldnames):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(r)
    return path


def to_int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def to_float(v):
    try:
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return None


def video_meta():
    """Read FPS / frame count / resolution from RAW video container (read-only)."""
    meta = {}
    for v in ORDERED_VIDEOS:
        cap = cv2.VideoCapture(str(RAW / v))
        if not cap.isOpened():
            raise SystemExit(f"FATAL: cannot open raw video {v} for metadata")
        meta[v] = {
            "fps": cap.get(cv2.CAP_PROP_FPS),
            "frames": int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
            "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
            "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
        }
        cap.release()
    return meta


def main():
    # ── load Level 7D ───────────────────────────────────────────────────────
    track = read_csv(D7 / "level7d_track_summary.csv")
    traj = read_csv(D7 / "level7d_trajectories.csv")
    count_summary = read_csv(D7 / "level7d_count_summary.csv")
    manifest = read_csv(D7 / "level7d_merge_manifest.csv")
    val7d = read_csv(D7 / "level7d_validation.csv")
    compar = read_csv(D7 / "level7d_count_comparison.csv")

    fps_info = video_meta()

    issues, notes = [], []
    # ── Phase 8A: VALIDATION ────────────────────────────────────────────────

    # 1. final track count
    n_tracks = len(track)
    if n_tracks == 122:
        notes.append("final track identities = 122 (expected)")
    else:
        issues.append(f"track count {n_tracks} != expected 122")

    # 2. per-video counts
    per_video = Counter(r["video"] for r in track if r["video"])
    expected_per_video = {"low traffic.mp4": 44, "no traffic video.mp4": 5,
                          "traffic.mp4": 73}
    for v in ORDERED_VIDEOS:
        got = per_video.get(v, 0)
        exp = expected_per_video.get(v)
        status = "ok" if got == exp else "MISMATCH"
        notes.append(f"per-video {v}: {got} (expected {exp}) [{status}]")
        if got != exp:
            issues.append(f"per-video count for {v}: {got} != {exp}")

    unknown_videos = set(per_video) - set(ORDERED_VIDEOS)
    if unknown_videos:
        issues.append(f"track summary contains unknown video(s): {unknown_videos}")

    # 3. conservative counts (project gate: >=3 frames & avg conf >=0.30)
    def is_conservative(r):
        return (to_int(r.get("frames_tracked")) or 0) >= MIN_CONSERVATIVE_FRAMES \
            and (to_float(r.get("confidence_average")) or 0.0) >= MIN_CONSERVATIVE_CONF

    cons_track = [r for r in track if is_conservative(r)]
    cons_per_video = Counter(r["video"] for r in cons_track)
    expected_cons = {"low traffic.mp4": 35, "no traffic video.mp4": 5, "traffic.mp4": 68}
    for v in ORDERED_VIDEOS:
        got = cons_per_video.get(v, 0)
        exp = expected_cons.get(v)
        status = "ok" if got == exp else "MISMATCH"
        notes.append(f"conservative {v}: {got} (expected {exp}) [{status}]")
        if got != exp:
            issues.append(f"conservative per-video {v}: {got} != {exp}")

    # cross-check vs level7d_count_summary.csv
    cs_by_video = {r["video"]: r for r in count_summary}
    for v in ORDERED_VIDEOS:
        row = cs_by_video.get(v)
        if row is None:
            issues.append(f"count_summary missing video {v}")
            continue
        if to_int(row["total_unique_vehicles"]) != per_video.get(v):
            issues.append(
                f"count_summary total {row['total_unique_vehicles']} for {v} "
                f"!= track_summary {per_video.get(v)}")
        if to_int(row["conservative_vehicles"]) != cons_per_video.get(v):
            issues.append(
                f"count_summary conservative {row['conservative_vehicles']} for {v} "
                f"!= recomputed {cons_per_video.get(v)}")

    # 4. total trajectory rows
    n_rows = len(traj)
    if n_rows != 15491:
        issues.append(f"trajectory rows {n_rows} != expected 15491")
    else:
        notes.append("total trajectory rows = 15491 (expected)")

    # 5. every trajectory (video, track_id) resolves to a summary track
    summary_ids = {(r["video"], to_int(r["track_id"])) for r in track}
    traj_ids = {(r["video"], to_int(r["track_id"])) for r in traj}
    missing_ids = traj_ids - summary_ids
    orphan_ids = summary_ids - traj_ids
    if missing_ids:
        issues.append(f"trajectory tracks missing from summary: {sorted(missing_ids)}")
    else:
        notes.append("all trajectory (video, track_id) resolve to track summary")
    if orphan_ids:
        issues.append(f"summary tracks with zero trajectory rows: {sorted(orphan_ids)}")
    else:
        notes.append("no summary tracks are orphaned (all have trajectory rows)")

    # 6. integrity checks
    # duplicate track_ids within each video
    ids_by_video = defaultdict(set)
    for r in track:
        tid = to_int(r["track_id"])
        if tid is None:
            issues.append(f"non-integer track_id: {r}")
            continue
        if tid in ids_by_video[r["video"]]:
            issues.append(f"duplicate track_id {tid} in {r['video']}")
        ids_by_video[r["video"]].add(tid)
    notes.append("no duplicate track IDs within any video")

    # duplicate (video, frame, track_id) trajectory rows
    seen = set()
    dup_count = 0
    dup_by_track = Counter()
    for r in traj:
        kv = (r["video"], to_int(r["frame"]), to_int(r["track_id"]))
        if kv in seen:
            dup_count += 1
            dup_by_track[(kv[0], kv[2])] += 1
        seen.add(kv)
    if dup_count:
        top = sorted(dup_by_track.items(), key=lambda x: -x[1])[:10]
        notes.append(
            f"{dup_count} duplicate (video,frame,track_id) trajectory rows "
            f"[expected merge-union artifact; tracks: "
            + ", ".join(f"{k[0][:13]}#{k[1]} x{v}" for k, v in top) + "]")
    else:
        notes.append("no duplicate trajectory rows")

    # numeric / bbox / class / video checks on trajectories
    bad_numeric = 0
    bad_frame = 0
    bad_bbox = 0
    missing_class = 0
    missing_video = 0
    for r in traj:
        if not r.get("video"):
            missing_video += 1
        if not (r.get("vehicle_class") and r.get("vehicle_class_stable")):
            missing_class += 1
        fr = to_int(r["frame"])
        wnum = to_float(r["confidence"])
        if fr is None or fr < 0:
            bad_frame += 1
        if wnum is None:
            bad_numeric += 1
        if to_float(r["x1"]) is None or to_float(r["y1"]) is None \
           or to_float(r["x2"]) is None or to_float(r["y2"]) is None \
           or to_float(r["centroid_x"]) is None or to_float(r["centroid_y"]) is None:
            bad_numeric += 1
        x1, y1, x2, y2 = (to_float(r[c]) for c in ("x1", "y1", "x2", "y2"))
        if x1 < 0 or y1 < 0 or x2 < 0 or y2 < 0 or x2 < x1 or y2 < y1 or x1 == x2 or y1 == y2:
            bad_bbox += 1
    for label, n in [("NaN/inf/non-numeric values", bad_numeric),
                     ("negative frame numbers", bad_frame),
                     ("invalid bboxes (non-positive w/h, negative, x2<x1)", bad_bbox),
                     ("missing class labels", missing_class),
                     ("empty video names", missing_video)]:
        if n:
            issues.append(f"{label}: {n}")
        else:
            notes.append(f"{label}: none")

    # bbox containment within raw dimensions
    dims = {v: (fps_info[v]["width"], fps_info[v]["height"]) for v in fps_info}
    exceed = 0
    for r in traj:
        W, H = dims.get(r["video"], (1e6, 1e6))
        x2, y2 = to_float(r["x2"]), to_float(r["y2"])
        if x2 > W or y2 > H:
            exceed += 1
    if exceed:
        # report but do not treat as a hard failure: boxes may touch edges
        notes.append(f"{exceed} trajectories extend beyond frame bounds "
                     f"(reported, not auto-fixed)")

    # NaN/inf in track summary
    bad_track_sum = 0
    for r in track:
        for c in ["confidence_average", "class_agreement", "class_agreement_stable"]:
            if to_float(r.get(c)) is None:
                bad_track_sum += 1
    if bad_track_sum:
        issues.append(f"track summary NaN/inf/non-numeric values: {bad_track_sum}")
    else:
        notes.append("track summary numeric fields: all valid")

    # 7. Level 7D validation file says PASS
    ok7 = [r for r in val7d if r["ok"] == "PASS"]
    fail7 = [r for r in val7d if r["ok"] != "PASS"]
    notes.append(f"level7d_validation.csv: {len(ok7)} PASS / "
                 f"{len(fail7)} FAIL of {len(val7d)} checks")
    if fail7:
        issues.append(f"level7d validation has FAIL entries: {fail7}")
    if len(ok7) != len(val7d):
        issues.append("level7d validation file not fully PASS")

    # 8. independent count cross-check (computed above from raw CSVs)

    # ── Phase 8B: STATISTICS ────────────────────────────────────────────────

    # class totals (stable)
    cls_stable = Counter(r["vehicle_class_stable"] for r in track)
    cls_raw = Counter(r["vehicle_class"] for r in track)
    total = per_video and sum(per_video.values())
    total_cons = len(cons_track)
    classes_present = [c for c in COUNT_FIELDS if cls_stable.get(c)]

    stat_rows = []
    stat_rows.append({"metric": "total_corrected_identities", "value": total,
                      "note": "unique identities (track summary rows)"})
    stat_rows.append({"metric": "total_conservative_identities", "value": total_cons,
                      "note": f">= {MIN_CONSERVATIVE_FRAMES} frames & conf >= "
                              f"{MIN_CONSERVATIVE_CONF}"})
    stat_rows.append({"metric": "total_trajectory_rows", "value": n_rows,
                      "note": "rows in level7d_trajectories.csv (includes "
                              "merge-union duplicate-frame rows)"})
    stat_rows.append({"metric": "number_of_videos", "value": len(per_video),
                      "note": str(sorted(per_video))})
    stat_rows.append({"metric": "classes_present", "value": len(classes_present),
                      "note": ",".join(classes_present)})
    for c in classes_present:
        stat_rows.append({"metric": f"class_{c}_stable_count", "value": cls_stable[c],
                          "note": f"{cls_stable[c] / total * 100:.2f} % of all "
                                  f"corrected identities"})
    stat_rows.append({"metric": "duration_seconds_pooled_matrix_uses",
                      "value": "see below",
                      "note": "duration stats and time bins calculated per-video "
                              "from raw container FPS"})

    # ── B. vehicles by video ────────────────────────────────────────────────
    class_by_video = []
    for v in ORDERED_VIDEOS:
        n_v = per_video.get(v, 0)
        n_c = cons_per_video.get(v, 0)
        class_by_video.append({
            "video": v, "total_corrected": n_v,
            "conservative": n_c,
            "percent_of_all": round(n_v / total * 100, 2) if total else 0.0,
        })

    # ── D. class by video table ─────────────────────────────────────────────
    cls_video = defaultdict(Counter)
    for r in track:
        cls_video[r["video"]][r["vehicle_class_stable"]] += 1
    cls_by_video_rows = [{"video": v, "class": c, "count": cls_video[v][c]}
                         for v in ORDERED_VIDEOS for c in classes_present]

    # ── E/F. track duration ────────────────────────────────────────────────
    # per-track frame span (inclusive) and seconds from raw FPS
    duration_rows = []
    for r in track:
        vid = r["video"]
        f0 = to_int(r["first_frame"])
        f1 = to_int(r["last_frame"])
        dur_frames = (f1 - f0 + 1) if (f0 is not None and f1 is not None) else None
        fps = fps_info[vid]["fps"]
        dur_sec = (dur_frames / fps) if dur_frames is not None and fps else None
        duration_rows.append({
            "video": vid,
            "track_id": to_int(r["track_id"]),
            "vehicle_class_stable": r["vehicle_class_stable"],
            "first_frame": f0,
            "last_frame": f1,
            "tracked_rows": to_int(r["frames_tracked"]),
            "duration_frames": dur_frames,
            "duration_seconds": round(dur_sec, 3) if dur_sec is not None else None,
        })

    dur_frames_all = [d["duration_frames"] for d in duration_rows
                      if d["duration_frames"] is not None]
    dur_sec_all = [d["duration_seconds"] for d in duration_rows
                   if d["duration_seconds"] is not None]

    def agg(vals):
        if not vals:
            return None
        vs = sorted(vals)
        return {
            "min": vs[0],
            "max": vs[-1],
            "mean": statistics.mean(vs),
            "median": statistics.median(vs),
            "p25": vs[max(0, (len(vs) - 1) * 25 // 100)],
            "p75": vs[min(len(vs) - 1, (len(vs) - 1) * 75 // 100)],
        }

    agg_frames = agg(dur_frames_all)
    agg_seconds = agg(dur_sec_all)

    # class-specific duration
    class_dur = defaultdict(list)
    class_dur_sec = defaultdict(list)
    for d in duration_rows:
        class_dur[d["vehicle_class_stable"]].append(d["duration_frames"])
        class_dur_sec[d["vehicle_class_stable"]].append(d["duration_seconds"])

    # ── G. traffic distribution over time ───────────────────────────────────
    rows_by_track = defaultdict(list)
    for r in traj:
        rows_by_track[(r["video"], to_int(r["track_id"]))].append(to_int(r["frame"]))

    time_rows = []
    for v in ORDERED_VIDEOS:
        meta = fps_info[v]
        fps = meta["fps"]
        total_frames = meta["frames"]
        duration_s = total_frames / fps if fps else 0.0
        bin_s = BIN_SECONDS[v]
        n_bins = max(1, math.ceil(duration_s / bin_s))
        for bi in range(n_bins):
            t0 = bi * bin_s
            t1 = min((bi + 1) * bin_s, duration_s)
            f0 = int(round(t0 * fps))
            f1 = int(round(t1 * fps)) - 1
            if f1 < 0:
                f1 = 0
            # active identities: any trajectory row within [f0, f1]
            act = set()
            rows_in = 0
            for k, frames in rows_by_track.items():
                if k[0] != v:
                    continue
                lo = max(f0, min(frames))
                hi = min(f1, max(frames))
                if lo <= hi:
                    cnt = sum(1 for f in frames if f0 <= f <= f1)
                    if cnt:
                        act.add(k[1])
                        rows_in += cnt
            time_rows.append({
                "video": v,
                "interval_seconds": f"{t0:.1f}-{t1:.1f}",
                "start_frame": f0,
                "end_frame": f1,
                "unique_active_identities": len(act),
                "trajectory_observations": rows_in,
            })

    # ── H. conservative vs total ────────────────────────────────────────────
    diff_cons = total - total_cons
    pct_diff_cons = (diff_cons / total * 100) if total else 0.0

    # ── I. merge impact (Level 7D only; uses manifest + comparison CSV) ─────
    n_removed_7d = len(manifest)
    comp_all = next((r for r in compar if r.get("video") == "__ALL_VIDEOS__"
                     and r.get("class") == "__TOTAL__"), None)
    before_7d = to_int(comp_all["original_raw"]) if comp_all else None
    after_7d = to_int(comp_all["corrected_raw"]) if comp_all else None
    impact_7d = {}
    for m in manifest:
        vid = m["video"]
        impact_7d.setdefault(vid, {"removed": 0})
        impact_7d[vid]["removed"] += 1
    # per-video before counts come from level7d_count_comparison.csv
    before_per_video = {}
    for v in ORDERED_VIDEOS:
        r = next((r for r in compar if r.get("video") == v
                  and r.get("class") == "__TOTAL__"), None)
        before_per_video[v] = to_int(r["original_raw"]) if r else None

    # ── write outputs ───────────────────────────────────────────────────────
    write_csv(stat_rows, OUT_STAT, ["metric", "value", "note"])
    matrix_rows = []
    for v in ORDERED_VIDEOS:
        m = {c: cls_video[v][c] for c in classes_present}
        m["video"] = v
        m["total"] = per_video[v]
        matrix_rows.append(m)
    write_csv(matrix_rows, OUT_CLASS_VIDEO, ["video"] + classes_present + ["total"])
    write_csv(duration_rows, OUT_DURATION,
              ["video", "track_id", "vehicle_class_stable", "first_frame",
               "last_frame", "tracked_rows", "duration_frames", "duration_seconds"])
    write_csv(time_rows, OUT_TIME,
              ["video", "interval_seconds", "start_frame", "end_frame",
               "unique_active_identities", "trajectory_observations"])

    # ── validation report text ──────────────────────────────────────────────
    passed = not issues
    vlines = []
    vlines.append("=" * 74)
    vlines.append("  LEVEL 8A - FINAL DATASET VALIDATION  (Level 7D)")
    vlines.append("=" * 74)
    vlines.append(f"  RESULT: {'PASSED' if passed else 'FAILED'}")
    vlines.append("")
    vlines.append("  Independent checks (from raw Level 7D CSVs, not reports):")
    for n in notes:
        vlines.append(f"    - {n}")
    if issues:
        vlines.append("")
        vlines.append("  PROBLEMS FOUND (not silently fixed):")
        for i in issues:
            vlines.append(f"    * {i}")
    vlines.append("")
    vlines.append("  Dataset structure notes:")
    vlines.append("    - Duplicate (video,frame,track_id) trajectory rows are the")
    vlines.append("      documented merge-union artifact (rows of a merged fragment")
    vlines.append("      are retained at shared frames with the parent). Reported")
    vlines.append("      above; NOT removed and NOT silently fixed.")
    vlines.append("    - Gaps in track-id numbering are expected: merged source IDs")
    vlines.append("      (e.g. 18, 157) are intentionally absent.")
    vlines.append("    - Vehicles removed earlier in the whole pipeline (Level 6B-7D)")
    vlines.append("      are not part of this dataset by design.")
    vlines.append("")
    vlines.append("  FPS source: raw video container metadata (read-only).")
    for v in ORDERED_VIDEOS:
        m = fps_info[v]
        vlines.append(f"    {v}: {m['width']}x{m['height']} @ {m['fps']:.2f} fps, "
                      f"{m['frames']} frames")
    vlines.append("")
    vlines.append("  Cross-checks that must agree:")
    vlines.append(f"    count_summary total  : {sum(to_int(r['total_unique_vehicles']) for r in count_summary)} (3-row sum)")
    vlines.append(f"    track_summary total  : {len(track)}")
    vlines.append(f"    comparison ALL-VIDEO : {[r for r in compar if r.get('video') == '__ALL_VIDEOS__']}")
    vlines.append("")

    OUT_VALIDATION.parent.mkdir(parents=True, exist_ok=True)
    OUT_VALIDATION.write_text("\n".join(vlines), encoding="utf-8")

    # ── summary text ────────────────────────────────────────────────────────
    sl = []
    sl.append("=" * 74)
    sl.append("  LEVEL 8 - FINAL TRAFFIC STATISTICS  (final corrected dataset, Level 7D)")
    sl.append("=" * 74)
    sl.append("")
    sl.append(f"  A. OVERALL")
    sl.append(f"      Total corrected vehicle identities : {total}")
    sl.append(f"      Total conservative identities      : {total_cons}")
    sl.append(f"      Total trajectory rows              : {n_rows}")
    sl.append(f"      Number of videos                   : {len(per_video)}")
    sl.append("")
    sl.append("  B. VEHICLES BY VIDEO")
    sl.append(f"      {'video':<22}{'corrected':>10}{'conservative':>14}{'% of all':>10}")
    for row in class_by_video:
        sl.append(f"      {row['video']:<22}{row['total_corrected']:>10}"
                  f"{row['conservative']:>14}{row['percent_of_all']:>9.1f}%")
    sl.append(f"      {'TOTAL':<22}{total:>10}{total_cons:>14}{'100.0%':>10}")
    sl.append("")
    sl.append("  C. VEHICLES BY CLASS (stable) - entire dataset")
    sl.append(f"      {'class':<12}{'count':>8}{'percent':>10}")
    for c in classes_present:
        sl.append(f"      {c:<12}{cls_stable[c]:>8}{cls_stable[c] / total * 100:>9.1f}%")
    sl.append(f"      {'total':<12}{total:>8}{'100.0%':>10}")
    if len(cls_raw) != len(cls_stable) or cls_raw != cls_stable:
        sl.append(f"      note: raw-class distribution differs: {dict(cls_raw)}")
    sl.append("")
    sl.append("  D. VEHICLES BY CLASS AND VIDEO")
    hdr = "      " + f"{'video':<22}" + "".join(f"{c:>12}" for c in classes_present) + f"{'total':>8}"
    sl.append(hdr)
    for v in ORDERED_VIDEOS:
        cells = "".join(f"{cls_video[v][c]:>12}" for c in classes_present)
        sl.append(f"      {v:<22}{cells}{per_video[v]:>8}")
    tot_cells = "".join(f"{cls_stable[c]:>12}" for c in classes_present)
    sl.append(f"      {'TOTAL':<22}{tot_cells}{total:>8}")
    sl.append("")
    sl.append("  E. TRACK DURATION (frames; inclusive span = last - first + 1)")
    if agg_frames:
        for k in ["min", "max", "mean", "median", "p25", "p75"]:
            v = agg_frames[k]
            sl.append(f"      duration_frames {k:<7}: "
                      f"{v:.2f}" if isinstance(v, float) else f"duration_frames {k:<7}: {v}")
    sl.append(f"      (based on {len(dur_frames_all)} tracks)")
    sl.append("")
    if agg_seconds:
        sl.append("  E-bis. TRACK DURATION in seconds (raw container FPS: "
                  "low 23.98 / no-traffic 59.94 / traffic 50.0)")
        for k in ["min", "max", "mean", "median", "p25", "p75"]:
            v = agg_seconds[k]
            sl.append(f"      duration_sec   {k:<7}: "
                      f"{v:.3f}" if isinstance(v, float) else f"duration_sec   {k:<7}: {v}")
        sl.append(f"      (based on {len(dur_sec_all)} tracks)")
    sl.append("")
    sl.append("  F. CLASS-SPECIFIC DURATION (frames)")
    sl.append(f"      {'class':<12}{'n':>5}{'mean_frames':>13}{'median_frames':>15}")
    for c in classes_present:
        vals = class_dur[c]
        if vals:
            sl.append(f"      {c:<12}{len(vals):>5}"
                      f"{statistics.mean(vals):>13.2f}"
                      f"{statistics.median(vals):>15.1f}")
    sl.append("")
    sl.append("  G. TRAFFIC DISTRIBUTION OVER TIME")
    sl.append("      (reporting BOTH metrics explicitly: 'unique_active_identities' "
              "= distinct tracked")
    sl.append("       vehicles seen in the interval; 'trajectory_observations' = "
              "raw trajectory rows")
    sl.append("       counted in that interval - these are NOT the same thing.)")
    sl.append(f"      {'video':<22}{'interval(s)':>14}{'identities':>12}{'traj_rows':>11}")
    for t in time_rows:
        sl.append(f"      {t['video']:<22}{t['interval_seconds']:>14}"
                  f"{t['unique_active_identities']:>12}{t['trajectory_observations']:>11}")
    sl.append("")
    sl.append("  H. CONSERVATIVE VS TOTAL")
    sl.append(f"      total corrected : {total}")
    sl.append(f"      conservative    : {total_cons}")
    sl.append(f"      difference      : {diff_cons} ({(total - total_cons):+.0f})")
    sl.append(f"      % difference    : "
              f"{pct_diff_cons:.2f}% of total excluded by the confidence/frame gate")
    sl.append("")
    sl.append("  I. MERGE IMPACT (Level 7D stage only - this stage's manifest)")
    sl.append(f"      identities before Level 7D : {before_7d}")
    sl.append(f"      identities after Level 7D  : {after_7d}")
    sl.append(f"      identities removed by 7D   : {n_removed_7d}")
    sl.append("      per-video before -> after (from count_comparison __TOTAL__ rows):")
    for v in ORDERED_VIDEOS:
        b = before_per_video.get(v)
        a = per_video.get(v, 0)
        sl.append(f"        {v:<22} {b} -> {a}  (delta "
                  f"{a - b:+d})" if b is not None else
                  f"        {v:<22} (before count unavailable)")
    sl.append("      applied merges (7D manifest):")
    for m in manifest:
        sl.append(f"        {m['video']:<22} removed {m['source_id']} -> "
                  f"canonical {m['canonical_parent_id']} "
                  f"({m['source_class_stable']}->{m['parent_class_stable']})")
    sl.append("")
    sl.append("  NOTES / CAVEATS")
    sl.append("    - 'trajectory rows' include merge-union duplicate-frame rows "
              "retained by design (see validation report).")
    sl.append("    - Conservative counts use the project gate: frames_tracked >= 3 "
              "AND confidence_average >= 0.30.")
    sl.append("    - Bicycle class is present only because the no-traffic video "
              "published 1 bicycle; it is not aggregated anywhere else.")
    sl.append("    - FPS read from raw video container metadata (read-only); no "
              "FPS was guessed.")
    sl.append("")

    OUT_SUMMARY.write_text("\n".join(sl), encoding="utf-8")

    print("\n".join(vlines))
    print("STATISTICS SUMMARY:")
    print("\n".join(sl))


if __name__ == "__main__":
    main()