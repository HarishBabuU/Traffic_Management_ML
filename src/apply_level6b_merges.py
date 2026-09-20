"""
Level 6B - Apply Verified Fragment-Merge Relationships (POST-PROCESSING ONLY)
==============================================================================
Applies ONLY the 7 human-confirmed SAME_VEHICLE relationships from Level 6A to
the EXISTING track/trajectory outputs. Produces corrected logical identities
and corrected counts.

Policy (from the human reviewer):
  SAME_VEHICLE     -> merge fragment ID into parent ID (7 merges)
  DIFFERENT_VEHICLE -> keep IDs separate (47 -> 49 stays separate)
  UNCERTAIN        -> keep IDs separate conservatively (206 -> 138 stays separate)

Constraints honoured:
  * NO YOLO detection, NO ByteTrack, NO retraining, NO raw-video writes
  * Original CSVs are READ-ONLY; all Level 6B outputs are NEW files under
    data/processed/level6b/
  * Level 6A files are preserved untouched

Usage:
    python src/apply_level6b_merges.py
"""

import csv
from pathlib import Path
from collections import defaultdict

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PROCESSED = PROJECT_ROOT / "data" / "processed"
CANDIDATES_CSV = PROCESSED / "vehicle_merge_candidates.csv"
TRACKS_CSV = PROCESSED / "vehicle_tracking_results.csv"
TRAJ_CSV = PROCESSED / "vehicle_trajectories.csv"
SUMMARY_CSV = PROCESSED / "vehicle_count_summary.csv"
OUT_DIR = PROCESSED / "level6b"

# ── Approved Level 6A decisions (fragment_id -> parent_id) ────────────────
# Only these are SAME_VEHICLE merges. Nothing else may be merged.
APPROVED_MERGES = {
    (84, 66),    # low traffic.mp4   car  -> car       (SAME_VEHICLE)
    (29, 32),    # low traffic.mp4   car  -> car       (SAME_VEHICLE)
    (112, 114),  # no traffic video  bicycle -> bicycle (SAME_VEHICLE)
    (222, 138),  # traffic.mp4       bus  -> bus       (SAME_VEHICLE)
    (219, 138),  # traffic.mp4       bus  -> bus       (SAME_VEHICLE)
    (230, 138),  # traffic.mp4       bus-stable -> bus (SAME_VEHICLE)
    (220, 189),  # traffic.mp4       motorcycle -> motorcycle (SAME_VEHICLE)
}

MUST_STAY_SEPARATE = {
    (47, 49),    # DIFFERENT_VEHICLE
    (206, 138),  # UNCERTAIN  -> conservative keep-separate
}

MIN_CONSERVATIVE_FRAMES = 3
MIN_CONSERVATIVE_CONF = 0.30


def read_csv(path: Path):
    with open(path, "r", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, rows, fieldnames):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
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
        return v


def derive_fps(rows):
    """Estimate fps per video from track summaries (frame / timestamp)."""
    per_video = defaultdict(list)
    for r in rows:
        ff = to_int(r["first_frame"])
        ts = float(r["first_timestamp"])
        if ff and ts > 0:
            per_video[r["video"]].append(ff / ts)
    fps = {}
    for vid, vals in per_video.items():
        vals.sort()
        fps[vid] = vals[len(vals) // 2]
    return fps


def majority(weighted):
    """Return class with max vote; tie-break by summed confidence."""
    best = None
    for cls, (cnt, conf) in weighted.items():
        if best is None or (cnt, conf) > (weighted[best][0], weighted[best][1]):
            best = cls
    return best


CLASS_NAME_TO_ID = {
    "bicycle": 1,
    "car": 2,
    "motorcycle": 3,
    "bus": 5,
    "truck": 7,
}


def main():
    candidates = read_csv(CANDIDATES_CSV)
    track_rows = read_csv(TRACKS_CSV)
    traj_rows = read_csv(TRAJ_CSV)
    summary_rows = read_csv(SUMMARY_CSV)

    # ── build merge map keyed by video ──────────────────────────────────────
    merge_map = defaultdict(dict)   # video -> {fragment_id: parent_id}
    for frag, parent in sorted(APPROVED_MERGES):
        match = [c for c in candidates
                 if to_int(c["fragment_id"]) == frag and to_int(c["parent_id"]) == parent]
        if not match:
            raise SystemExit(f"FATAL: approved merge {frag}->{parent} not found in candidates CSV")
        vid = match[0]["video"]
        merge_map[vid][frag] = parent

    # ── group trajectory rows by (video, track_id) ─────────────────────────
    traj_by_track = defaultdict(list)
    for r in traj_rows:
        key = (r["video"], to_int(r["track_id"]))
        traj_by_track[key].append(r)

    # ── build logical id per original (video, track_id) ────────────────────
    logical_of = {}        # (video, tid) -> logical_id
    merged_into = defaultdict(list)   # (video, parent) -> [fragments]
    for vid, frag_map in merge_map.items():
        for frag, parent in frag_map.items():
            logical_of[(vid, frag)] = parent
            merged_into[(vid, parent)].append(frag)

    removed_count = len(APPROVED_MERGES)
    applied = {merge: 0 for merge in APPROVED_MERGES}

    # ── build corrected track summary ───────────────────────────────────────
    corrected_tracks = []
    provenance = {}      # (video, logical_id) -> "frag->parent" note
    for r in track_rows:
        vid = r["video"]
        tid = to_int(r["track_id"])
        key = (vid, tid)
        if key in logical_of:
            parent = logical_of[key]
            prov = provenance.setdefault((vid, parent), [])
            prov.append(f"{tid}->{parent}")
            applied[(tid, parent)] += 1
            continue  # fragment absorbed into parent (handled at parent row)
        corrected_tracks.append(r)
        provenance.setdefault((vid, tid), [])

    # ── recompute merged-parent summary rows ────────────────────────────────
    fps = derive_fps(track_rows)
    recomputed = defaultdict(dict)   # (video, parent) -> dict of metrics
    for (vid, parent), fragments in merged_into.items():
        parent_key = (vid, parent)
        merged_keys = [(vid, parent)] + [(vid, f) for f in fragments]
        rows = []
        for k in merged_keys:
            rows.extend(traj_by_track.get(k, []))
        rows.sort(key=lambda x: (int(float(x["frame"])), x["track_id"]))

        raw_votes = defaultdict(lambda: [0, 0.0])
        stable_votes = defaultdict(lambda: [0, 0.0])
        frames = [float(r["frame"]) for r in rows]
        confs = [float(r["confidence"]) for r in rows]
        for r in rows:
            raw = r["vehicle_class"]
            stable = r["vehicle_class_stable"]
            raw_votes[raw][0] += 1
            raw_votes[raw][1] += float(r["confidence"])
            stable_votes[stable][0] += 1
            stable_votes[stable][1] += float(r["confidence"])
        raw_cls = majority(raw_votes)
        stable_cls = majority(stable_votes)
        n = len(rows) or 1
        raw_agree = raw_votes[raw_cls][0] / n
        stable_agree = stable_votes[stable_cls][0] / n
        avg_conf = sum(confs) / n
        f0 = int(frames[0]) if frames else None
        f1 = int(frames[-1]) if frames else None
        frate = fps.get(vid, 24.0)
        recomputed[parent_key] = {
            "video": vid,
            "track_id": parent,
            "vehicle_class": raw_cls,
            "coco_class_id": CLASS_NAME_TO_ID.get(raw_cls, "coco_" + raw_cls),
            "first_frame": f0,
            "last_frame": f1,
            "first_timestamp": round(f0 / frate, 3) if f0 is not None else "",
            "last_timestamp": round(f1 / frate, 3) if f1 is not None else "",
            "frames_tracked": len(rows),
            "class_agreement": round(raw_agree, 4),
            "confidence_average": round(avg_conf, 4),
            "vehicle_class_stable": stable_cls,
            "coco_class_id_stable": CLASS_NAME_TO_ID.get(stable_cls, "coco_" + stable_cls),
            "class_agreement_stable": round(stable_agree, 4),
            "hysteresis_switches": "",
        }

    final_tracks = []
    for r in corrected_tracks:
        vid = r["video"]
        tid = to_int(r["track_id"])
        rec = dict(r)
        if (vid, tid) in recomputed:
            rec.update(recomputed[(vid, tid)])
        final_tracks.append(rec)

    final_tracks.sort(key=lambda x: (x["video"], int(x["track_id"])))

    # ── build corrected trajectory (re-label absorbed frames) ──────────────
    corrected_traj = []
    for r in traj_rows:
        rec = dict(r)
        key = (r["video"], to_int(r["track_id"]))
        if key in logical_of:
            rec["track_id"] = logical_of[key]
        corrected_traj.append(rec)
    corrected_traj.sort(key=lambda x: (x["video"], int(x["track_id"]), float(x["frame"])))

    # ── corrected counts per video ─────────────────────────────────────────
    COUNT_FIELDS = ["car", "motorcycle", "bus", "truck", "bicycle"]
    from collections import defaultdict as dd

    def tally(rows, stable=False):
        col = "vehicle_class_stable" if stable else "vehicle_class"
        per_video = dd(lambda: dd(int))
        for r in rows:
            per_video[r["video"]][r[col]] += 1
        out = {}
        for vid, d in per_video.items():
            out[vid] = {c: d.get(c, 0) for c in COUNT_FIELDS}
        return out

    orig_raw = tally(track_rows, stable=False)          # raw per-track
    orig_stable = tally(track_rows, stable=True)
    new_raw = tally(final_tracks, stable=False)
    new_stable = tally(final_tracks, stable=True)

    def conservative_count(rows):
        per = defaultdict(int)
        for r in rows:
            nf = int(r["frames_tracked"])
            cf = float(r["confidence_average"])
            if nf >= MIN_CONSERVATIVE_FRAMES and cf >= MIN_CONSERVATIVE_CONF:
                per[r["video"]] += 1
        return dict(per)

    orig_cons = conservative_count(track_rows)
    new_cons = conservative_count(final_tracks)

    # original total per video (unique track ids == row count)
    orig_total = defaultdict(int)
    for r in track_rows:
        orig_total[r["video"]] += 1
    new_total = defaultdict(int)
    for r in final_tracks:
        new_total[r["video"]] += 1

    orig_total_all = sum(orig_total.values())
    new_total_all = sum(new_total.values())

    # ── write outputs ───────────────────────────────────────────────────────
    track_fields = list(track_rows[0].keys())
    out_track = write_csv(OUT_DIR / "level6b_track_summary.csv",
                          final_tracks, track_fields)
    out_traj = write_csv(OUT_DIR / "level6b_trajectories.csv",
                         corrected_traj, list(traj_rows[0].keys()))

    summary_fields = [
        "video", "total_unique_vehicles", "conservative_vehicles",
        "cars", "motorcycles", "buses", "trucks",
        "stable_cars", "stable_motorcycles", "stable_buses", "stable_trucks",
        "conservative_cars", "conservative_motorcycles",
        "conservative_buses", "conservative_trucks",
        "new_track_gates", "frames_processed",
    ]
    corrected_summary = []
    for row in summary_rows:
        vid = row["video"]
        cons = defaultdict(int)
        for r in final_tracks:
            if r["video"] != vid:
                continue
            if int(r["frames_tracked"]) >= MIN_CONSERVATIVE_FRAMES \
               and float(r["confidence_average"]) >= MIN_CONSERVATIVE_CONF:
                cons[r["vehicle_class"]] += 1
        corrected_summary.append({
            "video": vid,
            "total_unique_vehicles": new_total[vid],
            "conservative_vehicles": new_cons.get(vid, 0),
            "cars": new_raw[vid].get("car", 0),
            "motorcycles": new_raw[vid].get("motorcycle", 0),
            "buses": new_raw[vid].get("bus", 0),
            "trucks": new_raw[vid].get("truck", 0),
            "stable_cars": new_stable[vid].get("car", 0),
            "stable_motorcycles": new_stable[vid].get("motorcycle", 0),
            "stable_buses": new_stable[vid].get("bus", 0),
            "stable_trucks": new_stable[vid].get("truck", 0),
            "conservative_cars": cons.get("car", 0),
            "conservative_motorcycles": cons.get("motorcycle", 0),
            "conservative_buses": cons.get("bus", 0),
            "conservative_trucks": cons.get("truck", 0),
            "new_track_gates": row["new_track_gates"],
            "frames_processed": row["frames_processed"],
        })
    out_summ = write_csv(OUT_DIR / "level6b_count_summary.csv",
                         corrected_summary, summary_fields)

    # ── comparison CSV: original vs corrected by video & class ─────────────
    comp_rows = []
    cid = 0
    all_vids = sorted(set(list(orig_total) + list(new_total)))
    for vid in all_vids:
        for c in COUNT_FIELDS:
            cid += 1
            comp_rows.append({
                "row": cid, "video": vid, "class": c,
                "original_raw": orig_raw[vid].get(c, 0),
                "corrected_raw": new_raw[vid].get(c, 0),
                "raw_delta": new_raw[vid].get(c, 0) - orig_raw[vid].get(c, 0),
                "original_stable": orig_stable[vid].get(c, 0),
                "corrected_stable": new_stable[vid].get(c, 0),
                "stable_delta": new_stable[vid].get(c, 0) - orig_stable[vid].get(c, 0),
            })
        comp_rows.append({
            "row": cid + 1, "video": vid, "class": "__TOTAL__",
            "original_raw": orig_total[vid], "corrected_raw": new_total[vid],
            "raw_delta": new_total[vid] - orig_total[vid],
            "original_stable": orig_total[vid], "corrected_stable": new_total[vid],
            "stable_delta": new_total[vid] - orig_total[vid],
        })
        cid += 1
    comp_rows.append({
        "row": cid + 1, "video": "__ALL_VIDEOS__", "class": "__TOTAL__",
        "original_raw": orig_total_all, "corrected_raw": new_total_all,
        "raw_delta": new_total_all - orig_total_all,
        "original_stable": orig_total_all, "corrected_stable": new_total_all,
        "stable_delta": new_total_all - orig_total_all,
    })
    comp_fields = ["row", "video", "class", "original_raw", "corrected_raw",
                   "raw_delta", "original_stable", "corrected_stable", "stable_delta"]
    out_comp = write_csv(OUT_DIR / "level6b_count_comparison.csv",
                         comp_rows, comp_fields)

    # ── merge manifest (each of the 9 visual decisions) ────────────────────
    decision_of = {}
    for frag, parent in APPROVED_MERGES:
        decision_of[(frag, parent)] = ("SAME_VEHICLE", "MERGED")
    for frag, parent in MUST_STAY_SEPARATE:
        decision_of[(frag, parent)] = ("DIFFERENT_VEHICLE"
                                       if (frag, parent) == (47, 49)
                                       else "UNCERTAIN", "NOT_MERGED")
    manifest = []
    for vid, frag_map in merge_map.items():
        for frag, parent in frag_map.items():
            manifest.append({
                "video": vid, "fragment_id": frag, "parent_id": parent,
                "decision": decision_of[(frag, parent)][0],
                "applied": decision_of[(frag, parent)][1],
            })
    for frag, parent in MUST_STAY_SEPARATE:
        match = [c for c in candidates
                 if to_int(c["fragment_id"]) == frag and to_int(c["parent_id"]) == parent]
        if match:
            manifest.append({
                "video": match[0]["video"], "fragment_id": frag,
                "parent_id": parent,
                "decision": decision_of[(frag, parent)][0],
                "applied": decision_of[(frag, parent)][1],
            })
    manifest.sort(key=lambda x: (x["video"], x["fragment_id"]))
    man_fields = ["video", "fragment_id", "parent_id", "decision", "applied"]
    out_man = write_csv(OUT_DIR / "level6b_merge_manifest.csv", manifest, man_fields)

    # ── validation ──────────────────────────────────────────────────────────
    merged_keys = set(APPROVED_MERGES)
    present_tids = {to_int(r["track_id"]) for r in final_tracks}
    present_fragments = {frag for frag, _ in APPROVED_MERGES} & present_tids

    # check 47 & 49 and 206 & 138 all still present as logical tracks
    present = {(r["video"], to_int(r["track_id"])) for r in final_tracks}
    check_same_video = {
        (84, 66): "low traffic.mp4", (29, 32): "low traffic.mp4",
        (112, 114): "no traffic video.mp4", (222, 138): "traffic.mp4",
        (219, 138): "traffic.mp4", (230, 138): "traffic.mp4",
        (220, 189): "traffic.mp4",
    }
    validations = []
    def check(name, ok, detail):
        validations.append({"check": name, "ok": "PASS" if ok else "FAIL",
                            "detail": detail})

    check("exactly 7 merges applied", len(APPROVED_MERGES) == 7,
          f"approved merges = {len(APPROVED_MERGES)}")
    check("all 7 merges applied exactly once",
          all(v == 1 for v in applied.values()),
          str(dict(applied)))
    check("all merged fragments absent as logical tracks",
          not present_fragments, f"leftover fragments={present_fragments}")
    for (frag, parent), vid in check_same_video.items():
        check(f"parent {parent} present after merge ({frag}->{parent})",
              (vid, parent) in present, f"video={vid}")
    check("47 not merged into 49 (DIFFERENT_VEHICLE)",
          (47, 49) not in {tuple(merged_keys) for merged_keys in [(a, b) for a, b in APPROVED_MERGES]},
          "47/49 remain separate")
    check("47 present as logical track", ("low traffic.mp4", 47) in present, "")
    check("49 present as logical track", ("low traffic.mp4", 49) in present, "")
    check("206 not merged into 138 (UNCERTAIN)",
          (206, 138) not in APPROVED_MERGES, "")
    check("206 present as logical track", ("traffic.mp4", 206) in present, "")
    check("138 present as logical track", ("traffic.mp4", 138) in present, "")
    check("trajectory row count preserved",
          len(corrected_traj) == len(traj_rows),
          f"{len(traj_rows)} -> {len(corrected_traj)}")
    check("no original file overwritten",
          not any(p.name in {"vehicle_trajectories.csv",
                             "vehicle_tracking_results.csv",
                             "vehicle_count_summary.csv",
                             "vehicle_merge_candidates.csv"}
                  for p in OUT_DIR.glob("*.csv")),
          "level6b/ contains only new files")
    check("counts equal sum of merge removals",
          new_total_all == orig_total_all - len(APPROVED_MERGES),
          f"{orig_total_all} -> {new_total_all} (= -{orig_total_all - new_total_all})")

    out_val = write_csv(OUT_DIR / "level6b_validation.csv", validations,
                        ["check", "ok", "detail"])
    all_pass = all(v["ok"] == "PASS" for v in validations)

    # ── text report ─────────────────────────────────────────────────────────
    lines = []
    lines.append("=" * 66)
    lines.append("  Level 6B - Corrected Logical Identities & Counts")
    lines.append("=" * 66)
    lines.append(f"  Merges approved & applied : {len(APPROVED_MERGES)}")
    lines.append(f"  Kept separate (DIFFERENT)  : 47 -> 49")
    lines.append(f"  Kept separate (UNCERTAIN)  : 206 -> 138")
    lines.append("")
    lines.append("  Merge manifest (applied):")
    for m in manifest:
        lines.append(f"    {m['video']:<18} frag {m['fragment_id']:>3} -> "
                     f"parent {m['parent_id']:>3}   [{m['decision']}] {m['applied']}")
    lines.append("")
    lines.append("  Corrected counts per video  (raw | stable):")
    hdr = f"    {'Video':<20} {'Raw':>5} {'Conservative':>13} {'Car/ CarS':>14}" \
          f" {'Moto/MotoS':>14} {'Bus/BusS':>12} {'Truck/TruckS':>14} {'Bike/BikeS':>12}"
    lines.append(hdr)
    lines.append("    " + "-" * 100)
    for vid in all_vids:
        c = corrected_summary[[r["video"] for r in corrected_summary].index(vid)]
        ns, nc = new_stable[vid], new_raw[vid]
        lines.append(
            f"    {vid:<20} {new_total[vid]:>5} {c['conservative_vehicles']:>13} "
            f"{new_raw[vid]['car']:>5}/{ns['car']:<5} "
            f"{new_raw[vid]['motorcycle']:>5}/{ns['motorcycle']:<5} "
            f"{new_raw[vid]['bus']:>5}/{ns['bus']:<5} "
            f"{new_raw[vid]['truck']:>5}/{ns['truck']:<5} "
            f"{new_raw[vid]['bicycle']:>5}/{ns['bicycle']:<5}")
    lines.append("")
    lines.append("  Delta vs original  (raw | stable):")
    for vid in all_vids:
        o_t, n_t = orig_total[vid], new_total[vid]
        lines.append(f"    {vid:<20} total {o_t} -> {n_t} "
                     f"({n_t - o_t:+d})   conservative "
                     f"{orig_cons.get(vid,0)} -> {new_cons.get(vid,0)}")
        for c in COUNT_FIELDS:
            o_r = orig_raw[vid].get(c, 0); n_r = new_raw[vid].get(c, 0)
            o_s = orig_stable[vid].get(c, 0); n_s = new_stable[vid].get(c, 0)
            if o_r or n_r or o_s or n_s:
                lines.append(f"      {c:<12} raw {o_r} -> {n_r} ({n_r - o_r:+d})   "
                             f"stable {o_s} -> {n_s} ({n_s - o_s:+d})")
    lines.append("")
    lines.append(f"  OVERALL total: {orig_total_all} -> {new_total_all} "
                 f"({new_total_all - orig_total_all:+d})  => "
                 + ("DECREASED" if new_total_all < orig_total_all
                    else "INCREASED" if new_total_all > orig_total_all
                    else "UNCHANGED"))
    lines.append("")
    lines.append("  Validation: " + ("ALL CHECKS PASSED" if all_pass
                                    else "!! SOME CHECKS FAILED !!"))
    for v in validations:
        lines.append(f"    [{v['ok']}] {v['check']}{'  ' + v['detail'] if v['detail'] else ''}")
    lines.append("")
    lines.append("  Outputs written:")
    for p in sorted(OUT_DIR.glob("*.csv")):
        lines.append(f"    {p.resolve()}")

    report_txt = OUT_DIR / "level6b_report.txt"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(report_txt, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()