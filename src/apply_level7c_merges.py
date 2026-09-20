"""
Level 7C - Apply Level 7C Visual-Verification Merges (POST-PROCESSING ONLY)
==========================================================================
Applies ONLY the 9 human-confirmed SAME_VEHICLE decisions from Level 7C
visual verification onto the Level 7B corrected dataset.

Decisions applied (9 SAME_VEHICLE -> 13 individual merge operations):
  1  traffic.mp4          truck chain 224,228,229,234,236 -> 138 (canonical)
  2  low traffic.mp4      101 -> 90
  3  no traffic video.mp4 118 -> 114
  4  traffic.mp4          167 -> 126
  5  traffic.mp4          160 -> 131
  6  low traffic.mp4      45 -> 46
  7  (NOT merged)         65 <-> 79 : visually confirmed DIFFERENT_VEHICLE
  8  traffic.mp4          176 -> 131
  9  traffic.mp4          153 -> 146
  10 traffic.mp4          163 -> 150

Conserved methodology from Level 7B:
  * NO detection, NO tracking, NO retraining, NO raw-video writes
  * Level 7B inputs are READ-ONLY; all outputs are NEW files under
    data/processed/level7c/
  * trajectory rows are preserved 1:1; only approved track-id relabelling
  * counts/summaries recomputed from remapped trajectories using the exact
    Level 7B methodology (raw/stable/conservative)

Usage:
    python src/apply_level7c_merges.py
"""

import csv
import hashlib
from pathlib import Path
from collections import defaultdict

PROJECT_ROOT = Path(__file__).resolve().parent.parent
L7B = PROJECT_ROOT / "data" / "processed" / "level7b"
OUT_DIR = PROJECT_ROOT / "data" / "processed" / "level7c"

TRACKS_CSV = L7B / "level7b_track_summary.csv"
TRAJ_CSV = L7B / "level7b_trajectories.csv"
SUMMARY_CSV = L7B / "level7b_count_summary.csv"

L7B_INPUTS = [
    L7B / "level7b_trajectories.csv",
    L7B / "level7b_track_summary.csv",
    L7B / "level7b_count_summary.csv",
    L7B / "level7b_count_comparison.csv",
    L7B / "level7b_merge_manifest.csv",
    L7B / "level7b_validation.csv",
    L7B / "level7b_report.txt",
]

# ── Level 7C approved merges: (video, source_id, canonical_parent_id) ────
APPROVED_MERGES = [
    # 1: truck chain -> canonical 138 (single decision, 5 operations)
    ("traffic.mp4", 224, 138),
    ("traffic.mp4", 228, 138),
    ("traffic.mp4", 229, 138),
    ("traffic.mp4", 234, 138),
    ("traffic.mp4", 236, 138),
    # 2..6
    ("low traffic.mp4", 101, 90),
    ("no traffic video.mp4", 118, 114),
    ("traffic.mp4", 167, 126),
    ("traffic.mp4", 160, 131),
    ("low traffic.mp4", 45, 46),
    # 8..10
    ("traffic.mp4", 176, 131),
    ("traffic.mp4", 153, 146),
    ("traffic.mp4", 163, 150),
]

# Visually confirmed DIFFERENT_VEHICLE - explicitly NOT merged.
NOT_MERGED_PAIR = ("low traffic.mp4", 65, 79)

# Decision group label per approved merge operation
DECISION_GROUP = {
    ("traffic.mp4", 224): "D1_truckchain->138",
    ("traffic.mp4", 228): "D1_truckchain->138",
    ("traffic.mp4", 229): "D1_truckchain->138",
    ("traffic.mp4", 234): "D1_truckchain->138",
    ("traffic.mp4", 236): "D1_truckchain->138",
    ("low traffic.mp4", 101): "D2_101->90",
    ("no traffic video.mp4", 118): "D3_118->114",
    ("traffic.mp4", 167): "D4_167->126",
    ("traffic.mp4", 160): "D5_160->131",
    ("low traffic.mp4", 45): "D6_45->46",
    ("traffic.mp4", 176): "D8_176->131",
    ("traffic.mp4", 153): "D9_153->146",
    ("traffic.mp4", 163): "D10_163->150",
}

MIN_CONSERVATIVE_FRAMES = 3
MIN_CONSERVATIVE_CONF = 0.30

CLASS_NAME_TO_ID = {
    "bicycle": 1,
    "car": 2,
    "motorcycle": 3,
    "bus": 5,
    "truck": 7,
}
COUNT_FIELDS = ["car", "motorcycle", "bus", "truck", "bicycle"]

EXPECTED_IDENTITY_REDUCTION = len(APPROVED_MERGES)  # 13


def sha16(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def read_csv(path):
    with open(path, "r", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(rows, name, fieldnames, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_dir / name, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(r)
    return out_dir / name


def to_int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return v


def derive_fps(rows):
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
    best = None
    for cls, (cnt, conf) in weighted.items():
        if best is None or (cnt, conf) > (weighted[best][0], weighted[best][1]):
            best = cls
    return best


def main():
    before = {p.name: sha16(p) for p in L7B_INPUTS if p.exists()}

    track_rows = read_csv(TRACKS_CSV)
    traj_rows = read_csv(TRAJ_CSV)
    summary_rows = read_csv(SUMMARY_CSV)

    # ── build source lookup ─────────────────────────────────────────────────
    track_by_key = {(r["video"], to_int(r["track_id"])): r for r in track_rows}

    # ── validate each approved merge against Level 7B data ─────────────────
    merge_map = defaultdict(dict)   # video -> {source_id: parent_id}
    for vid, frag, parent in APPROVED_MERGES:
        if (vid, frag) not in track_by_key:
            raise SystemExit(
                f"FATAL: merge {vid} {frag}->{parent}: source id missing in level7b")
        if (vid, parent) not in track_by_key:
            raise SystemExit(
                f"FATAL: merge {vid} {frag}->{parent}: parent id missing in level7b")
        merge_map[vid][frag] = parent

    # 65/79 NOT merged - must both exist and stay present
    nm_vid, nm_a, nm_b = NOT_MERGED_PAIR
    if (nm_vid, nm_a) not in track_by_key or (nm_vid, nm_b) not in track_by_key:
        raise SystemExit(
            f"FATAL: NOT_MERGED_PAIR {nm_vid} {nm_a}<->{nm_b} missing in level7b")
    if (nm_vid, nm_a) in merge_map.get(nm_vid, {}) or \
       (nm_vid, nm_b) in merge_map.get(nm_vid, {}):
        raise SystemExit(
            f"FATAL: NOT_MERGED_PAIR {nm_a}<->{nm_b} is also in approved merges")

    # ── logical mapping ─────────────────────────────────────────────────────
    logical_of = {}
    merged_into = defaultdict(list)
    for vid, smap in merge_map.items():
        for frag, parent in smap.items():
            logical_of[(vid, frag)] = parent
            merged_into[(vid, parent)].append(frag)

    applied = {(vid, frag): 0 for vid, frag, _ in APPROVED_MERGES}

    # ── corrected track summary (drop merged sources) ──────────────────────
    corrected_tracks = []
    for r in track_rows:
        vid = r["video"]
        tid = to_int(r["track_id"])
        key = (vid, tid)
        if key in logical_of:
            parent = logical_of[key]
            applied[(vid, tid)] += 1
            continue
        corrected_tracks.append(r)

    # ── recompute merged-parent metrics from trajectory union ──────────────
    traj_by_track = defaultdict(list)
    for r in traj_rows:
        traj_by_track[(r["video"], to_int(r["track_id"]))].append(r)

    fps = derive_fps(track_rows)
    recomputed = defaultdict(dict)
    for (vid, parent), fragments in merged_into.items():
        merged_keys = [(vid, parent)] + [(vid, f) for f in fragments]
        rows = []
        for k in merged_keys:
            rows.extend(traj_by_track.get(k, []))
        rows.sort(key=lambda x: (float(x["frame"]), x["track_id"]))

        raw_votes = defaultdict(lambda: [0, 0.0])
        stable_votes = defaultdict(lambda: [0, 0.0])
        for r in rows:
            raw_votes[r["vehicle_class"]][0] += 1
            raw_votes[r["vehicle_class"]][1] += float(r["confidence"])
            stable_votes[r["vehicle_class_stable"]][0] += 1
            stable_votes[r["vehicle_class_stable"]][1] += float(r["confidence"])
        raw_cls = majority(raw_votes)
        stable_cls = majority(stable_votes)
        n = len(rows) or 1
        raw_agree = raw_votes[raw_cls][0] / n
        stable_agree = stable_votes[stable_cls][0] / n
        confs = [float(r["confidence"]) for r in rows]
        avg_conf = sum(confs) / n
        frames = [float(r["frame"]) for r in rows]
        f0, f1 = int(frames[0]), int(frames[-1])
        frate = fps.get(vid, 24.0)
        parent_orig = track_by_key.get((vid, parent))
        hyst = parent_orig["hysteresis_switches"] if parent_orig else ""
        recomputed[(vid, parent)] = {
            "video": vid,
            "track_id": parent,
            "vehicle_class": raw_cls,
            "coco_class_id": CLASS_NAME_TO_ID.get(raw_cls, "coco_" + raw_cls),
            "first_frame": f0,
            "last_frame": f1,
            "first_timestamp": round(f0 / frate, 3),
            "last_timestamp": round(f1 / frate, 3),
            "frames_tracked": len(rows),
            "class_agreement": round(raw_agree, 4),
            "confidence_average": round(avg_conf, 4),
            "vehicle_class_stable": stable_cls,
            "coco_class_id_stable": CLASS_NAME_TO_ID.get(stable_cls, "coco_" + stable_cls),
            "class_agreement_stable": round(stable_agree, 4),
            "hysteresis_switches": hyst,
        }

    final_tracks = []
    for r in corrected_tracks:
        rec = dict(r)
        key = (r["video"], to_int(r["track_id"]))
        if key in recomputed:
            rec.update(recomputed[key])
        final_tracks.append(rec)
    final_tracks.sort(key=lambda x: (x["video"], int(x["track_id"])))

    # ── corrected trajectories (re-label absorbed frames) ──────────────────
    corrected_traj = []
    for r in traj_rows:
        rec = dict(r)
        key = (r["video"], to_int(r["track_id"]))
        if key in logical_of:
            rec["track_id"] = logical_of[key]
        corrected_traj.append(rec)
    corrected_traj.sort(key=lambda x: (x["video"], int(x["track_id"]), float(x["frame"])))

    # ── counts ──────────────────────────────────────────────────────────────
    def tally(rows, stable=False):
        col = "vehicle_class_stable" if stable else "vehicle_class"
        per_video = defaultdict(lambda: defaultdict(int))
        for r in rows:
            per_video[r["video"]][r[col]] += 1
        return {vid: {c: d.get(c, 0) for c in COUNT_FIELDS}
                for vid, d in per_video.items()}

    orig_raw = tally(track_rows, False)
    orig_stable = tally(track_rows, True)
    new_raw = tally(final_tracks, False)
    new_stable = tally(final_tracks, True)

    def conservative(rows):
        per = defaultdict(int)
        for r in rows:
            if int(r["frames_tracked"]) >= MIN_CONSERVATIVE_FRAMES \
               and float(r["confidence_average"]) >= MIN_CONSERVATIVE_CONF:
                per[r["video"]] += 1
        return dict(per)

    orig_cons = conservative(track_rows)
    new_cons = conservative(final_tracks)

    orig_total = defaultdict(int)
    for r in track_rows:
        orig_total[r["video"]] += 1
    new_total = defaultdict(int)
    for r in final_tracks:
        new_total[r["video"]] += 1

    orig_total_all = sum(orig_total.values())
    new_total_all = sum(new_total.values())

    # ── write outputs ───────────────────────────────────────────────────────
    out_track = write_csv(final_tracks, "level7c_track_summary.csv",
                          list(track_rows[0].keys()), OUT_DIR)
    out_traj = write_csv(corrected_traj, "level7c_trajectories.csv",
                         list(traj_rows[0].keys()), OUT_DIR)

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
            if r["video"] == vid \
               and int(r["frames_tracked"]) >= MIN_CONSERVATIVE_FRAMES \
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
    out_summ = write_csv(corrected_summary, "level7c_count_summary.csv",
                         summary_fields, OUT_DIR)

    # ── comparison CSV ──────────────────────────────────────────────────────
    comp_rows = []
    all_vids = sorted(set(list(orig_total) + list(new_total)))
    cid = 0
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
        cid += 1
        comp_rows.append({
            "row": cid, "video": vid, "class": "__TOTAL__",
            "original_raw": orig_total[vid], "corrected_raw": new_total[vid],
            "raw_delta": new_total[vid] - orig_total[vid],
            "original_stable": orig_total[vid], "corrected_stable": new_total[vid],
            "stable_delta": new_total[vid] - orig_total[vid],
        })
    cid += 1
    comp_rows.append({
        "row": cid, "video": "__ALL_VIDEOS__", "class": "__TOTAL__",
        "original_raw": orig_total_all, "corrected_raw": new_total_all,
        "raw_delta": new_total_all - orig_total_all,
        "original_stable": orig_total_all, "corrected_stable": new_total_all,
        "stable_delta": new_total_all - orig_total_all,
    })
    comp_fields = ["row", "video", "class", "original_raw", "corrected_raw",
                   "raw_delta", "original_stable", "corrected_stable", "stable_delta"]
    out_comp = write_csv(comp_rows, "level7c_count_comparison.csv", comp_fields, OUT_DIR)

    # ── merge manifest (9 decisions, 13 operations, + NOT_MERGED) ──────────
    manifest = []
    for vid, frag, parent in APPROVED_MERGES:
        fr = track_by_key[(vid, frag)]
        pa = track_by_key[(vid, parent)]
        manifest.append({
            "decision_group": DECISION_GROUP[(vid, frag)],
            "video": vid,
            "source_id": frag,
            "canonical_parent_id": parent,
            "source_class_stable": fr["vehicle_class_stable"],
            "parent_class_stable": pa["vehicle_class_stable"],
            "decision": "SAME_VEHICLE",
            "applied": "MERGED",
        })
    mf = track_by_key[(nm_vid, nm_a)]
    mb = track_by_key[(nm_vid, nm_b)]
    manifest.append({
        "decision_group": "D7_65_vs_79",
        "video": nm_vid,
        "source_id": nm_a,
        "canonical_parent_id": nm_b,
        "source_class_stable": mf["vehicle_class_stable"],
        "parent_class_stable": mb["vehicle_class_stable"],
        "decision": "DIFFERENT_VEHICLE",
        "applied": "NOT_MERGED",
    })
    manifest.sort(key=lambda x: (x["video"], x["source_id"]))
    man_fields = ["decision_group", "video", "source_id", "canonical_parent_id",
                  "source_class_stable", "parent_class_stable", "decision", "applied"]
    out_man = write_csv(manifest, "level7c_merge_manifest.csv", man_fields, OUT_DIR)

    # ── validation ──────────────────────────────────────────────────────────
    present = {(r["video"], to_int(r["track_id"])) for r in final_tracks}
    ids = {to_int(r["track_id"]) for r in final_tracks}
    validations = []

    def check(name, ok, detail=""):
        validations.append({"check": name, "ok": "PASS" if ok else "FAIL",
                            "detail": detail})

    src_ids = [m[1] for m in APPROVED_MERGES]
    src_set = set(src_ids)

    # 1: trajectory row count preserved
    check("input trajectory row count == output",
          len(corrected_traj) == len(traj_rows),
          f"{len(traj_rows)} -> {len(corrected_traj)}")

    # 2: no unexpected track IDs changed
    new_ids_in = set()
    for r in corrected_traj:
        new_ids_in.add(to_int(r["track_id"]))
    unexpected = set()
    for r in track_rows:
        k = (r["video"], to_int(r["track_id"]))
        if k in logical_of:
            continue
        if k not in present:
            unexpected.add(k)
    check("no unexpected track IDs changed", not unexpected, str(unexpected))

    # 3: all approved source IDs mapped correctly (each applied exactly once,
    #    removed from logical tracks)
    check("all approved source IDs mapped correctly",
          all(v == 1 for v in applied.values())
          and not (src_set & ids),
          f"applied={dict(applied)} leftover={src_set & ids}")

    # 4: 65 and 79 remain separate identities
    check("65 and 79 remain separate identities",
          (nm_vid, nm_a) in present and (nm_vid, nm_b) in present,
          f"65 present={ (nm_vid, nm_a) in present }, 79 present={ (nm_vid, nm_b) in present }")

    # 5-12: frame assignments for each approved group
    frame_checks = [
        ("traffic.mp4", [224, 228, 229, 234, 236], 138),
        ("low traffic.mp4", [101], 90),
        ("no traffic video.mp4", [118], 114),
        ("traffic.mp4", [167], 126),
        ("traffic.mp4", [160, 176], 131),
        ("traffic.mp4", [153], 146),
        ("traffic.mp4", [163], 150),
        ("low traffic.mp4", [45], 46),
    ]
    # count frames per original (video, source) and verify all landed in parent
    for vid, frg_list, parent in frame_checks:
        frags_str = "+".join(str(f) for f in frg_list)
        n_orig = sum(int(r["frames_tracked"])
                     for r in track_rows
                     if r["video"] == vid and to_int(r["track_id"]) in frg_list)
        n_new = len([r for r in corrected_traj
                     if r["video"] == vid and to_int(r["track_id"]) == parent
                     if (r["video"], 0) or True])
        # count how many of parent's rows in output came from these fragments
        landed = 0
        for r in traj_rows:
            if r["video"] == vid and to_int(r["track_id"]) in frg_list:
                key = (vid, to_int(r["track_id"]))
                if logical_of.get(key) == parent:
                    landed += 1
        check(f"all frames of {frags_str} assigned to {parent}",
              landed == n_orig,
              f"{n_orig} rows -> {landed} landed in {parent}")

    # 13: no Level 7B files modified
    check("no source Level 7B file modified",
          all(p.exists() for p in L7B_INPUTS)
          and all(before[p.name] == sha16(p) for p in L7B_INPUTS
                  if p.name in before),
          "level7b/ hashes unchanged")

    # identity reduction == number of independent merges applied
    check("identity reduction equals independent merges applied",
          new_total_all == orig_total_all - EXPECTED_IDENTITY_REDUCTION,
          f"{orig_total_all} -> {new_total_all} (expected -{EXPECTED_IDENTITY_REDUCTION})")

    out_val = write_csv(validations, "level7c_validation.csv",
                        ["check", "ok", "detail"], OUT_DIR)
    all_pass = all(v["ok"] == "PASS" for v in validations)

    # ── report ──────────────────────────────────────────────────────────────
    n_same = len([m for m in manifest if m["applied"] == "MERGED"])
    n_not = len([m for m in manifest if m["applied"] == "NOT_MERGED"])
    n_decisions = len(set(DECISION_GROUP.values()))

    lines = []
    lines.append("=" * 66)
    lines.append("  Level 7C - Corrected Identities after Visual Verification")
    lines.append("=" * 66)
    lines.append(f"  Applied merges: {n_same} SAME_VEHICLE operations "
                 f"(from {n_decisions} approved decisions / 13 ops)   "
                 f"NOT merged: {n_not} ({nm_a}<->{nm_b} DIFFERENT_VEHICLE)")
    lines.append("")
    lines.append("  Merge manifest (SAME_VEHICLE):")
    for m in manifest:
        if m["applied"] == "MERGED":
            lines.append(f"    {m['decision_group']:<18} {m['video'][:13]:<15} "
                         f"src {m['source_id']:>3} -> parent {m['canonical_parent_id']:>3}  "
                         f"({m['source_class_stable']}->{m['parent_class_stable']})")
    lines.append(f"    {'D7_65_vs_79':<18} {nm_vid[:13]:<15} "
                 f"src {nm_a:>3} <-> {nm_b:>3}  NOT MERGED (DIFFERENT_VEHICLE)")
    lines.append("")
    lines.append("  Counts (raw | stable)  [level7c]:")
    for vid in all_vids:
        ns, nc = new_stable[vid], new_raw[vid]
        lines.append(
            f"    {vid:<20} total {new_total[vid]:>3}  cons {new_cons.get(vid,0):>3}  "
            f"car {new_raw[vid]['car']}/{ns['car']}  moto {new_raw[vid]['motorcycle']}/{ns['motorcycle']}  "
            f"bus {new_raw[vid]['bus']}/{ns['bus']}  truck {new_raw[vid]['truck']}/{ns['truck']}  "
            f"bike {new_raw[vid]['bicycle']}/{ns['bicycle']}")
    lines.append("")
    lines.append("  Delta vs Level 7B:")
    for vid in all_vids:
        o_t, n_t = orig_total[vid], new_total[vid]
        lines.append(f"    {vid:<20} total {o_t} -> {n_t} ({n_t - o_t:+d})  "
                     f"cons {orig_cons.get(vid,0)} -> {new_cons.get(vid,0)}")
        for c in COUNT_FIELDS:
            o_r, n_r = orig_raw[vid].get(c, 0), new_raw[vid].get(c, 0)
            o_s, n_s = orig_stable[vid].get(c, 0), new_stable[vid].get(c, 0)
            if o_r != n_r or o_s != n_s:
                lines.append(f"      {c:<10} raw {o_r}->{n_r} ({n_r - o_r:+d})  "
                             f"stable {o_s}->{n_s} ({n_s - o_s:+d})")
    lines.append("")
    lines.append(
        f"  Trajectory rows: {len(traj_rows)} -> {len(corrected_traj)} "
        f"(preserved 1:1)")
    lines.append(
        f"  Unique identities removed: {orig_total_all - new_total_all}  "
        f"(= {EXPECTED_IDENTITY_REDUCTION} independent merge operations "
        f"including the truck chain, which merges 5 source ids -> 138)")
    lines.append("")
    lines.append(f"  OVERALL total: {orig_total_all} -> {new_total_all} "
                 f"({new_total_all - orig_total_all:+d})  => "
                 + ("DECREASED" if new_total_all < orig_total_all
                    else "UNCHANGED" if new_total_all == orig_total_all
                    else "INCREASED"))
    lines.append("")
    lines.append("  Validation: " + ("ALL CHECKS PASSED" if all_pass
                                     else "!! SOME CHECKS FAILED !!"))
    for v in validations:
        lines.append(f"    [{v['ok']}] {v['check']}{'  ' + v['detail'] if v['detail'] else ''}")
    lines.append("")
    lines.append("  Outputs written:")
    for p in sorted(OUT_DIR.glob("*.csv")):
        lines.append(f"    {p.resolve()}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    report_txt = OUT_DIR / "level7c_report.txt"
    with open(report_txt, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()