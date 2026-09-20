"""
Phase 4 - YOLO + ByteTrack Unique Vehicle Tracker & Counter
============================================================
Processes each video frame-by-frame with YOLOv8n + ByteTrack and
counts UNIQUE vehicles by persistent track ID.

Prevents the "one bus = hundreds" bug:
  * counts are derived from the set of distinct ByteTrack track IDs
  * NOT from summing per-frame detections
  * a track is registered once, then only updated on later frames
  * the reported class per track is the most-frequent class observed
    over the track's whole life (vote), so car/bus/truck flicker is
    stabilised instead of re-labelling the vehicle every frame
  * class confidence is averaged per track, not summed

Usage:
    python src/track_and_count.py
    python src/track_and_count.py --conf 0.25 --step 1
    python src/track_and_count.py --annotated 6      # annotated frames per video
"""

import sys
import csv
import time
import argparse
from pathlib import Path
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import (
    RAW_VIDEOS_DIR, PROCESSED_DIR, SCREENSHOTS_DIR, VIDEO_EXTENSIONS,
    VEHICLE_CLASSES, VEHICLE_CLASS_IDS,
    DEFAULT_CONFIDENCE, DEFAULT_IOU_THRESHOLD,
    DEFAULT_MODEL, TRACKER_CONFIG, CUSTOM_TRACKER, HYSTERESIS_FRAMES,
)
from ultralytics import YOLO
import cv2

# ============================================================
#  CONFIGURABLE PARAMETERS  (edit here or via CLI)
# ============================================================

CONFIDENCE    = DEFAULT_CONFIDENCE        # 0.25
IOU           = DEFAULT_IOU_THRESHOLD     # 0.45
FRAME_STEP    = 1                         # 1 = every frame (tracking quality)
IMGSZ         = 640                       # inference size (CPU friendly)
MIN_TRACK_FRAMES = 5                      # tracks shorter than this = "short-lived"
MIN_FIRST_CONF = 0.30                     # min confidence to START a new track
MIN_CONSERVATIVE_FRAMES = 3               # conservative count requires this
MIN_CONSERVATIVE_CONF = 0.30              #   ... and this avg confidence
ANNOTATED_PER_VIDEO = 6                   # annotated frames to save per video
USE_CUSTOM_TRACKER = True                 # use src/bytetrack_traffic.yaml

# ============================================================

# colour (BGR) per class id for the annotated frames
CLASS_COLORS = {
    1: (255, 200, 0),    # bicycle - orange
    2: (0, 200, 0),      # car     - green
    3: (0, 0, 255),      # motorcycle - red
    5: (0, 165, 255),    # bus     - orange
    7: (128, 0, 128),    # truck   - purple
}


def draw_box(frame, x1, y1, x2, y2, label, color, thickness=2):
    """Draw one bounding box + label onto a BGR frame."""
    cv2.rectangle(frame, (x1, y1), (x2, y2), color, thickness)
    lw = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 1)[0][0]
    lh = 18
    y0 = y1 - lh - 4
    if y0 < 0:
        y0 = y2 + 4
    cv2.rectangle(frame, (x1, y0), (x1 + lw, y0 + lh), color, -1)
    cv2.putText(frame, label, (x1, y0 + lh - 5),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 1)


class TrackInfo:
    """Accumulates everything we know about one ByteTrack track ID."""

    def __init__(self, track_id, cls_id, conf, frame_idx, fps):
        self.track_id = track_id
        self.first_frame = frame_idx
        self.last_frame = frame_idx
        self.frames_tracked = 1
        self.class_votes = defaultdict(int)
        self.class_conf_sum = defaultdict(float)
        self.class_votes[cls_id] += 1
        self.class_conf_sum[cls_id] += conf
        self.conf_sum = conf
        self.prev_class = cls_id
        self.switches = []          # (from_cls, to_cls, frame_idx) raw
        self.fps = fps

        # ── Level 5 temporal class stabilization state ────────
        self.active_class = cls_id          # running hysteresis label
        self.cand_class = None              # candidate class
        self.cand_run = 0                   # consecutive frames of candidate
        self.stable_votes = defaultdict(int)
        self.stable_conf_sum = defaultdict(float)
        self.stable_votes[cls_id] += 1
        self.stable_conf_sum[cls_id] += conf
        self.hyst_switches = []             # accepted switches only

    def update(self, cls_id, conf, frame_idx):
        self.last_frame = frame_idx
        self.frames_tracked += 1
        self.class_votes[cls_id] += 1
        self.class_conf_sum[cls_id] += conf
        self.conf_sum += conf
        if cls_id != self.prev_class:
            self.switches.append((self.prev_class, cls_id, frame_idx))
            self.prev_class = cls_id

        # ── Level 5 hysteresis: accept a class change only after it
        #    persists HYSTERESIS_FRAMES consecutive observed frames ──
        if cls_id == self.active_class:
            self.cand_class = None
            self.cand_run = 0
        else:
            if cls_id == self.cand_class:
                self.cand_run += 1
            else:
                self.cand_class = cls_id
                self.cand_run = 1
            if self.cand_run >= HYSTERESIS_FRAMES:
                self.hyst_switches.append(
                    (self.active_class, cls_id, frame_idx))
                self.active_class = cls_id
                self.cand_class = None
                self.cand_run = 0
        # record the class that is actually displayed this frame
        self.stable_votes[self.active_class] += 1
        self.stable_conf_sum[self.active_class] += conf

    @property
    def stable_class(self):
        """RAW class with most votes; tie-broken by higher summed confidence."""
        best = max(self.class_votes.items(),
                   key=lambda kv: (kv[1], self.class_conf_sum[kv[0]]))
        return best[0]

    @property
    def stabilized_class(self):
        """Level 5 final class: confidence-weighted vote over the
        hysteresis-accepted class sequence."""
        best = max(self.stable_conf_sum.items(),
                   key=lambda kv: (kv[1], self.stable_votes[kv[0]]))
        return best[0]

    @property
    def avg_conf(self):
        return self.conf_sum / self.frames_tracked

    @property
    def class_agreement(self):
        """RAW fraction of frames where the observed class == raw stable class."""
        stable = self.stable_class
        return self.class_votes[stable] / self.frames_tracked

    @property
    def class_agreement_stable(self):
        """Fraction of frames matching the stabilized class (0..1)."""
        stable = self.stabilized_class
        return self.stable_votes[stable] / self.frames_tracked

    def summary(self, video_name):
        return {
            "video": video_name,
            "track_id": self.track_id,
            "vehicle_class": VEHICLE_CLASSES.get(self.stable_class,
                                                 f"coco_{self.stable_class}"),
            "coco_class_id": self.stable_class,
            "first_frame": self.first_frame,
            "last_frame": self.last_frame,
            "first_timestamp": round(self.first_frame / self.fps, 3),
            "last_timestamp": round(self.last_frame / self.fps, 3),
            "frames_tracked": self.frames_tracked,
            "class_agreement": round(self.class_agreement, 4),
            "confidence_average": round(self.avg_conf, 4),
            # ── Level 5 stabilized (new columns only) ──────────
            "vehicle_class_stable": VEHICLE_CLASSES.get(
                self.stabilized_class, f"coco_{self.stabilized_class}"),
            "coco_class_id_stable": self.stabilized_class,
            "class_agreement_stable": round(self.class_agreement_stable, 4),
            "hysteresis_switches": len(self.hyst_switches),
        }


def _tracker_config():
    """Return the tracker yaml path used by model.track()."""
    return CUSTOM_TRACKER if USE_CUSTOM_TRACKER else TRACKER_CONFIG


def process_video(model, video_path: Path) -> dict:
    """Track + count one video. Returns per-track records + metadata."""

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return {"video": video_path.name, "status": "ERROR: cannot open video"}
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()

    # pick annotated-frame interval to get ~ANNOTATED_PER_VIDEO frames
    save_interval = max(1, total_frames // max(1, ANNOTATED_PER_VIDEO))
    out_dir = SCREENSHOTS_DIR / "tracking" / video_path.stem.replace(" ", "_")
    out_dir.mkdir(parents=True, exist_ok=True)

    tracks = {}            # track_id -> TrackInfo   (THE unique set)
    frames_processed = 0
    t0 = time.time()
    new_track_gated = 0    # new-track starts rejected by MIN_FIRST_CONF
    traj_rows = []         # per-frame trajectory diagnostics (registered tracks only)

    results = model.track(
        source=str(video_path),
        conf=CONFIDENCE,
        iou=IOU,
        imgsz=IMGSZ,
        classes=VEHICLE_CLASS_IDS,
        tracker=_tracker_config(),
        persist=True,
        stream=True,
        verbose=False,
        device="cpu",
    )

    for frame_idx, result in enumerate(results):
        if frame_idx % FRAME_STEP != 0:
            continue
        frames_processed += 1

        if result.boxes is not None and result.boxes.id is not None:
            b_xyxy = result.boxes.xyxy.cpu().numpy()
            tids   = result.boxes.id.cpu().numpy().astype(int)
            clss   = result.boxes.cls.cpu().numpy().astype(int)
            confs  = result.boxes.conf.cpu().numpy()

            for (x1, y1, x2, y2), tid, cid, cf in zip(b_xyxy, tids, clss, confs):
                tid = int(tid)
                if tid not in tracks:
                    if float(cf) < MIN_FIRST_CONF:
                        continue    # don't START a track on a weak detection
                    tracks[tid] = TrackInfo(tid, int(cid), float(cf),
                                            frame_idx, fps)
                    new_track_gated += 1
                else:
                    tracks[tid].update(int(cid), float(cf), frame_idx)

                traj_rows.append({
                    "video": video_path.name,
                    "frame": frame_idx,
                    "track_id": tid,
                    "vehicle_class": VEHICLE_CLASSES.get(int(cid), f"coco_{int(cid)}"),
                    "vehicle_class_stable": VEHICLE_CLASSES.get(
                        tracks[tid].active_class,
                        f"coco_{tracks[tid].active_class}"),
                    "confidence": round(float(cf), 4),
                    "x1": int(x1), "y1": int(y1),
                    "x2": int(x2), "y2": int(y2),
                    "centroid_x": round((x1 + x2) / 2, 2),
                    "centroid_y": round((y1 + y2) / 2, 2),
                })

            # save annotated frame at intervals
            if frame_idx % save_interval == 0:
                img = result.plot(line_width=2)
                for (x1, y1, x2, y2), tid, cid in zip(b_xyxy, tids, clss):
                    name = VEHICLE_CLASSES.get(int(cid), f"coco_{int(cid)}")
                    color = CLASS_COLORS.get(int(cid), (255, 255, 255))
                    draw_box(img, int(x1), int(y1), int(x2), int(y2),
                             f"{name}#{int(tid)}", color)
                cv2.imwrite(str(out_dir / f"frame_{frame_idx:06d}.jpg"), img)
        elif frame_idx % save_interval == 0:
            # no detections this frame, still save a plain frame for context
            cv2.imwrite(str(out_dir / f"frame_{frame_idx:06d}.jpg"),
                        result.plot(line_width=2))

    elapsed = round(time.time() - t0, 1)

    track_records = [t.summary(video_path.name) for t in tracks.values()]
    track_records.sort(key=lambda r: r["track_id"])

    # class counts by stable class
    counts = defaultdict(int)
    stable_counts = defaultdict(int)
    for r in track_records:
        counts[r["vehicle_class"]] += 1
        stable_counts[r["vehicle_class_stable"]] += 1

    # short-lived tracks
    short = [r for r in track_records if r["frames_tracked"] < MIN_TRACK_FRAMES]

    # conservative tracks: long enough + confident enough to be trustworthy
    conservative = [r for r in track_records
                    if r["frames_tracked"] >= MIN_CONSERVATIVE_FRAMES
                    and r["confidence_average"] >= MIN_CONSERVATIVE_CONF]

    # very suspicious: too short AND too low confidence (primary FP candidates)
    suspicious = [r for r in track_records
                  if r["frames_tracked"] <= 4
                  and r["confidence_average"] < 0.30]

    # class switching cases (from the complete switch logs)
    switches_all = []
    for t in tracks.values():
        for (f_c, t_c, fr) in t.switches:
            switches_all.append({
                "video": video_path.name,
                "track_id": t.track_id,
                "from_class": VEHICLE_CLASSES.get(f_c, f"coco_{f_c}"),
                "to_class": VEHICLE_CLASSES.get(t_c, f"coco_{t_c}"),
                "frame": fr,
            })

    return {
        "video": video_path.name,
        "status": "OK",
        "resolution": f"{width}x{height}",
        "fps": round(fps, 2),
        "total_frames": total_frames,
        "frames_processed": frames_processed,
        "elapsed_s": elapsed,
        "unique_tracks": len(tracks),
        "conservative_tracks": len(conservative),
        "new_track_gated": new_track_gated,
        "counts": dict(counts),
        "stable_counts": dict(stable_counts),
        "track_records": track_records,
        "short_lived": short,
        "conservative": conservative,
        "suspicious": suspicious,
        "switches": switches_all,
        "trajectory_rows": traj_rows,
    }


def main():
    parser = argparse.ArgumentParser(description="Unique vehicle tracker/counter")
    parser.add_argument("--conf",     type=float, default=CONFIDENCE)
    parser.add_argument("--iou",      type=float, default=IOU)
    parser.add_argument("--step",     type=int,   default=FRAME_STEP,
                        help="process every Nth frame (keep 1 for tracking)")
    parser.add_argument("--annotated", type=int,  default=ANNOTATED_PER_VIDEO)
    parser.add_argument("--min-frames", type=int, default=MIN_TRACK_FRAMES,
                        help="track lifetime below this = short-lived/FP flag")
    args = parser.parse_args()

    _g = globals()
    _g["CONFIDENCE"] = args.conf
    _g["IOU"] = args.iou
    _g["FRAME_STEP"] = args.step
    _g["ANNOTATED_PER_VIDEO"] = args.annotated
    _g["MIN_TRACK_FRAMES"] = args.min_frames

    print("=" * 62)
    print("  YOLO + ByteTrack  UNIQUE vehicle tracker / counter")
    print("=" * 62)
    print(f"  Model   : {DEFAULT_MODEL}")
    print(f"  Tracker : {_tracker_config()}")
    print(f"  Conf    : {CONFIDENCE}   IoU: {IOU}   imgsz: {IMGSZ}")
    print(f"  Step    : every {FRAME_STEP} frame(s)")
    print(f"  Track   : classes {list(VEHICLE_CLASSES.values())}  (COCO {VEHICLE_CLASS_IDS})")
    print(f"  MIN_FIRST_CONF          : {MIN_FIRST_CONF}")
    print(f"  Conservative count needs: >= {MIN_CONSERVATIVE_FRAMES} frames, "
          f"avg conf >= {MIN_CONSERVATIVE_CONF}")
    print()

    model = YOLO(DEFAULT_MODEL)

    video_files = sorted(
        f for f in RAW_VIDEOS_DIR.iterdir()
        if f.suffix.lower() in VIDEO_EXTENSIONS
    )
    if not video_files:
        print("No videos found.")
        return

    # CSV: per-track
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    track_csv = PROCESSED_DIR / "vehicle_tracking_results.csv"
    track_fields = [
        "video", "track_id", "vehicle_class", "coco_class_id",
        "first_frame", "last_frame", "first_timestamp", "last_timestamp",
        "frames_tracked", "class_agreement", "confidence_average",
        # ── Level 5 stabilized (new columns) ────────────────────
        "vehicle_class_stable", "coco_class_id_stable",
        "class_agreement_stable", "hysteresis_switches",
    ]

    # (write per-track rows lazily through the tracker below)
    all_track_rows = []
    all_traj_rows = []
    all_pers_video = []

    open(track_csv, "w", newline="", encoding="utf-8").close()  # clear

    for vf in video_files:
        print(f"--- {vf.name} ---")
        res = process_video(model, vf)
        if res["status"] != "OK":
            print(f"  ERROR: {res['status']}")
            continue

        all_pers_video.append(res)
        all_track_rows.extend(res["track_records"])
        all_traj_rows.extend(res["trajectory_rows"])

        print(f"  resolution      : {res['resolution']} @ {res['fps']} fps")
        print(f"  frames processed: {res['frames_processed']} / {res['total_frames']}")
        print(f"  unique TRACK IDs: {res['unique_tracks']}")
        print(f"  conservative    : {res['conservative_tracks']} "
              f"(>= {MIN_CONSERVATIVE_FRAMES} frames, "
              f"avg conf >= {MIN_CONSERVATIVE_CONF})")
        print(f"  new-track gates : {res['new_track_gated']} starts rejected "
              f"(first conf < {MIN_FIRST_CONF})")
        for cname, cnt in sorted(res["counts"].items()):
            print(f"    {cname:<12} {cnt}   (stable: "
                  f"{res['stable_counts'].get(cname, 0)})")
        print(f"  elapsed         : {res['elapsed_s']}s")
        if res["short_lived"]:
            print(f"  SHORT-LIVED tracks (<{MIN_TRACK_FRAMES} frames): "
                  f"{len(res['short_lived'])}")
            for s in res["short_lived"]:
                print(f"    tid={s['track_id']:<4} {s['vehicle_class']:<10} "
                      f"frames={s['frames_tracked']} conf={s['confidence_average']}")
        else:
            print("  SHORT-LIVED tracks: none")
        if res["suspicious"]:
            print(f"  SUSPICIOUS tracks (<=4 frames AND avg conf < 0.30): "
                  f"{len(res['suspicious'])}")
            for s in res["suspicious"]:
                print(f"    tid={s['track_id']:<4} {s['vehicle_class']:<10} "
                      f"frames={s['frames_tracked']} conf={s['confidence_average']}")
        else:
            print("  SUSPICIOUS tracks: none")
        if res["switches"]:
            print("  CLASS SWITCHES:")
            for sw in res["switches"]:
                print(f"    tid={sw['track_id']:<4} {sw['from_class']} -> "
                      f"{sw['to_class']} @ frame {sw['frame']}")
        else:
            print("  CLASS SWITCHES: none")
        print()

    # ---- write per-track CSV ----
    with open(track_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=track_fields)
        w.writeheader()
        for r in all_track_rows:
            w.writerow({k: r[k] for k in track_fields})

    # ---- write per-video summary CSV ----
    summary_csv = PROCESSED_DIR / "vehicle_count_summary.csv"
    with open(summary_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["video", "total_unique_vehicles", "conservative_vehicles",
                    "cars", "motorcycles", "buses", "trucks",
                    "stable_cars", "stable_motorcycles", "stable_buses", "stable_trucks",
                    "conservative_cars", "conservative_motorcycles",
                    "conservative_buses", "conservative_trucks",
                    "new_track_gates", "frames_processed"])
        for res in all_pers_video:
            c = res["counts"]
            sc = res["stable_counts"]
            cons = defaultdict(int)
            for r in res["conservative"]:
                cons[r["vehicle_class"]] += 1
            w.writerow([
                res["video"], res["unique_tracks"], res["conservative_tracks"],
                c.get("car", 0), c.get("motorcycle", 0),
                c.get("bus", 0), c.get("truck", 0),
                sc.get("car", 0), sc.get("motorcycle", 0),
                sc.get("bus", 0), sc.get("truck", 0),
                cons.get("car", 0), cons.get("motorcycle", 0),
                cons.get("bus", 0), cons.get("truck", 0),
                res["new_track_gated"], res["frames_processed"],
            ])

    # ---- write per-frame trajectory CSV (registered tracks only) ----
    traj_csv = PROCESSED_DIR / "vehicle_trajectories.csv"
    traj_fields = [
        "video", "frame", "track_id", "vehicle_class", "vehicle_class_stable",
        "confidence", "x1", "y1", "x2", "y2", "centroid_x", "centroid_y",
    ]
    all_traj_rows.sort(key=lambda r: (r["video"], r["track_id"], r["frame"]))
    with open(traj_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=traj_fields)
        w.writeheader()
        for r in all_traj_rows:
            w.writerow({k: r[k] for k in traj_fields})

    # ---- final summary table ----
    print("=" * 62)
    print("  FINAL UNIQUE-VEHICLE COUNTS  (raw | stabilized)")
    print("=" * 62)
    print("  raw = all unique track IDs | conservative = min "
          f"{MIN_CONSERVATIVE_FRAMES} frames & avg conf >= {MIN_CONSERVATIVE_CONF}")
    print(f"  {'Video':<28} {'Raw':>6} {'Cons':>6} {'Car':>14} {'Moto':>17} "
          f"{'Bus':>14} {'Truck':>18}")
    print("  " + "-" * 72)
    for res in all_pers_video:
        c = res["counts"]
        sc = res["stable_counts"]
        def fmt(label):
            return f"{c.get(label,0)}/{sc.get(label,0)}"
        print(f"  {res['video']:<28} {res['unique_tracks']:>6} "
              f"{res['conservative_tracks']:>6} "
              f"{fmt('car'):>14} {fmt('motorcycle'):>17} "
              f"{fmt('bus'):>14} {fmt('truck'):>18}")

    # ---- class-agreement statistics (raw vs stabilized) ----
    samples = [r for res in all_pers_video for r in res["track_records"]]
    print("\n  CLASS-AGREEMENT  fraction of frames matching label (raw | stabilized)")
    for label in ["car", "motorcycle", "bus", "truck", "bicycle"]:
        grp_raw = [r for r in samples if r["vehicle_class"] == label]
        grp_stab = [r for r in samples if r["vehicle_class_stable"] == label]
        if grp_raw or grp_stab:
            def avg_ag(grp):
                return sum(r["class_agreement"] for r in grp) / len(grp) if grp else 0.0
            def avg_sag(grp):
                return sum(r["class_agreement_stable"] for r in grp) / len(grp) if grp else 0.0
            print(f"    {label:<10} raw_tracks={len(grp_raw):>3} "
                  f"raw_agr={avg_ag(grp_raw):.3f}  |  stable_tracks={len(grp_stab):>3} "
                  f"stable_agr={avg_sag(grp_stab):.3f}")

    # ---- tracks whose stabilized class differs from raw majority ----
    changed = [r for r in samples
               if r["vehicle_class"] != r["vehicle_class_stable"]
               and r["coco_class_id_stable"] != r["coco_class_id"]]
    print(f"\n  STABILIZED-CLASS CHANGES vs raw majority: {len(changed)} track(s)")
    for r in sorted(changed, key=lambda r: (r["video"], r["track_id"])):
        print(f"    {r['video']:<18} tid={r['track_id']:<5} "
              f"{r['vehicle_class']:<10} -> {r['vehicle_class_stable']:<10} "
              f"frames={r['frames_tracked']:<4} "
              f"agreement {r['class_agreement']:.3f} -> {r['class_agreement_stable']:.3f} "
              f"(hyst_switches={r['hysteresis_switches']})")

    print(f"\n  Per-track CSV : {track_csv.resolve()}")
    print(f"  Summary CSV   : {summary_csv.resolve()}")
    print(f"  Trajectory CSV: {traj_csv.resolve()} "
          f"({len(all_traj_rows)} per-frame records)")
    print(f"  Annotated     : {(SCREENSHOTS_DIR / 'tracking').resolve()}")
    print("\n  NOTE: counts are UNIQUE track IDs — a vehicle may be counted")
    print("  twice if ByteTrack re-issues a new ID after a long occlusion.")


if __name__ == "__main__":
    main()