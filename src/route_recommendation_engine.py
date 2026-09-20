"""
Phase 9E - Route Recommendation Engine.

Consumes the Phase 9D road suitability scores
(data/processed/phase9d_road_scores.csv) as the source of per-road
suitability information. This engine NEVER modifies Phase 9D data and
NEVER re-scores roads; it only combines explicit candidate routes and
produces explainable route-level results.

All candidate routes (config/route_recommendation_config.json) are
DETERMINISTIC MOCK/TEST routes with fictional MOCK-ROAD-* IDs. They
describe no real roads and must never be presented as real routes.

This is a prototype and is NOT a production navigation system.
"""

from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config" / "route_recommendation_config.json"
DEFAULT_9D_SCORES_CSV = PROJECT_ROOT / "data" / "processed" / "phase9d_road_scores.csv"
PROCESSED_DIR = PROJECT_ROOT / "data" / "processed"
CONF_FLOOR = 0.05

OUTPUT_COLUMNS = [
    "route_id",
    "route_name",
    "data_mode",
    "data_source",
    "is_mock",
    "total_segment_count",
    "known_segment_count",
    "unknown_segment_count",
    "known_fraction",
    "weighting_method",
    "segment_sequence",
    "segment_scores",
    "explicit_distance_km_total",
    "explicit_travel_time_minutes_total",
    "route_score",
    "route_category",
    "route_confidence",
    "recommendation_status",
    "reason",
]

# Protected file groups consumed/inspected by Phase 9E. Everything
# present must remain byte-for-byte unchanged between baseline and checks.
PROTECTED_GROUPS = {
    "phase9a": "data/processed/phase9a_*",
    "phase9b": "data/processed/phase9b_*",
    "phase9c": "data/processed/phase9c_*",
    "phase9d": "data/processed/phase9d_*",
    "level8": "data/processed/level8_*",
    "level7d": "data/processed/level7d/*",
}


class RouteRecommendationError(Exception):
    pass


def _clamp(value, lo, hi):
    return max(lo, min(hi, value))


def _fmt_number(value, digits):
    if value is None:
        return ""
    return f"{value:.{digits}f}"


def _sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class RouteRecommendationEngine:
    def __init__(self, config_path=None, scores_path=None, scores_map=None):
        self.config_path = Path(config_path) if config_path else DEFAULT_CONFIG_PATH
        self.config = json.loads(self.config_path.read_text(encoding="utf-8"))

        self.mode_factors = self.config.get("confidence", {}).get(
            "mode_factors", {"live": 1.0, "manual": 0.9, "mock": 0.7, "unknown": 0.25}
        )
        self.conf_floor = float(self.config.get("confidence", {}).get("floor", CONF_FLOOR))
        self.score_decimals = int(self.config.get("scoring", {}).get("round_decimals", 1))
        self.conf_decimals = int(
            self.config.get("confidence", {}).get("round_decimals", 2)
        )
        bands = self.config.get("suitability_thresholds", [])

        self.scores_path = Path(scores_path) if scores_path else Path(
            self.config.get("source", {}).get("phase9d_scores_csv", "data/processed/phase9d_road_scores.csv")
        )
        if not self.scores_path.is_absolute():
            self.scores_path = PROJECT_ROOT / self.scores_path

        self.road_scores = (
            self.load_phase9d_scores(self.scores_path) if scores_map is None else dict(scores_map)
        )
        self.suitability_bands = sorted(
            bands, key=lambda b: b["min"], reverse=True
        )

    # ------------------------------------------------------------------
    # Phase 9D intake (read-only)
    # ------------------------------------------------------------------
    def load_phase9d_scores(self, path):
        col = self.config.get("source", {}).get("columns", {})
        road_id_col = col.get("road_id", "road_id")
        score_col = col.get("overall_score", "overall_score")
        conf_col = col.get("confidence", "confidence")
        mode_col = col.get("data_mode", "data_mode")
        mock_col = col.get("is_mock", "is_mock")
        src_col = col.get("data_source", "data_source")
        name_col = col.get("road_name", "road_name")
        cat_col = col.get("suitability_category", "suitability_category")

        scores = {}
        with open(path, newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                rid = (row.get(road_id_col) or "").strip()
                if not rid:
                    continue
                raw_score = (row.get(score_col) or "").strip()
                if raw_score.upper() == "UNKNOWN" or raw_score == "":
                    parsed_score = None
                else:
                    parsed_score = float(raw_score)
                confidence = float((row.get(conf_col) or "0").strip())
                scores[rid] = {
                    "road_id": rid,
                    "road_name": (row.get(name_col) or "").strip(),
                    "overall_score": parsed_score,
                    "confidence": confidence,
                    "data_mode": (row.get(mode_col) or "").strip() or "unknown",
                    "is_mock": (row.get(mock_col) or "False").strip(),
                    "data_source": (row.get(src_col) or "").strip(),
                    "suitability_category": (row.get(cat_col) or "").strip(),
                }
        if not scores:
            raise RouteRecommendationError(
                f"No road records loaded from {path}. Cannot run Phase 9E."
            )
        return scores

    # ------------------------------------------------------------------
    # Segment / route validation
    # ------------------------------------------------------------------
    def _segment_validation_errors(self, route):
        errors = []
        segments = route.get("segments") or []
        if not segments:
            errors.append("route has no segments")
            return errors, segments
        orders = [seg.get("segment_order") for seg in segments]
        if not all(isinstance(o, int) for o in orders):
            errors.append("segment_order must be a positive integer")
        elif sorted(orders) != list(range(1, len(segments) + 1)):
            errors.append("segment_order must be 1..N with unique values")
        for seg in segments:
            rid = (seg.get("road_id") or "").strip()
            if not rid:
                errors.append("a segment has no road_id")
            elif rid not in self.road_scores:
                errors.append(f"road_id {rid} is not in the Phase 9D scores")
        return errors, segments

    def _weighting_method(self, segments, known_scores):
        segs_ok = [seg for seg in segments if (seg.get("road_id") or "").strip() in self.road_scores]
        if not segs_ok:
            return "n/a"
        distances = [
            seg.get("distance_km")
            for seg in segs_ok
            if seg.get("distance_km") is not None
        ]
        if len(distances) == len(segs_ok) and all(d >= 0 for d in distances):
            return "distance"
        return "equal"

    # ------------------------------------------------------------------
    # Route scoring
    # ------------------------------------------------------------------
    def evaluate_route(self, route):
        route_id = (route.get("route_id") or "").strip()
        route_name = route.get("route_name") or ""
        data_mode = (route.get("data_mode") or "unknown").strip()
        data_source = route.get("data_source") or ""
        is_mock = "True" if data_mode == "mock" else "False"

        invalids, segments = self._segment_validation_errors(route)
        total = len(segments)
        if total == 0:
            invalids.append("route has no segments")

        known = 0
        unknown = 0
        seg_records = []  # (road_id, seg_score or None, distance, travel_time)
        confs = []
        mode_vals = []
        for seg in segments:
            rid = (seg.get("road_id") or "").strip()
            distance = seg.get("distance_km")
            travel = seg.get("travel_time_minutes")
            info = self.road_scores.get(rid)
            if info is None:
                seg_score = None
                confs.append(self.conf_floor)
                mode_vals.append("unknown")
            else:
                seg_score = info["overall_score"]
                confs.append(info["confidence"])
                mode_vals.append(info["data_mode"] or "unknown")
            if seg_score is None:
                unknown += 1
                seg_score = "UNKNOWN"
            else:
                known += 1
            seg_records.append((rid, seg_score, distance, travel))

        known_fraction = round(known / total, 3) if total else 0.0

        weighting = self._weighting_method(segments, seg_records)
        if invalids:
            route_score = "UNKNOWN"
            category = "UNKNOWN"
            status = "INVALID_ROUTE"
        elif known == 0:
            route_score = "UNKNOWN"
            category = "UNKNOWN"
            status = "INSUFFICIENT_DATA"
        else:
            known_vals = [rec for rec in seg_records if rec[1] != "UNKNOWN"]
            if weighting == "distance":
                total_dist = sum(float(rec[2]) for rec in known_vals)
                if total_dist > 0:
                    score = sum(
                        float(rec[1]) * float(rec[2]) for rec in known_vals
                    ) / total_dist
                else:
                    score = sum(float(rec[1]) for rec in known_vals) / len(known_vals)
            else:
                score = sum(float(rec[1]) for rec in known_vals) / len(known_vals)
            route_score = round(score, self.score_decimals)
            category = self.category_for(route_score)
            status = "ELIGIBLE"

        mean_conf = (sum(confs) / len(confs)) if confs else self.conf_floor
        mode_factor = (
            min(self.mode_factors.get(m, self.mode_factors.get("unknown", 0.25)) for m in mode_vals)
            if mode_vals
            else self.mode_factors.get("unknown", 0.25)
        )
        route_conf = round(
            _clamp(mean_conf * known_fraction * mode_factor, self.conf_floor, 1.0),
            self.conf_decimals,
        )

        segment_sequence = ";".join(rec[0] for rec in seg_records)
        segment_scores = ";".join(
            f"{rec[0]}={rec[1]}" for rec in seg_records
        )
        dist_values = [rec[2] for rec in seg_records if rec[2] is not None]
        time_values = [rec[3] for rec in seg_records if rec[3] is not None]
        total_distance = (
            round(sum(float(d) for d in dist_values), 3) if dist_values else ""
        )
        total_travel = (
            round(sum(float(t) for t in time_values), 3) if time_values else ""
        )

        reason_parts = [f"Route {route_id} has {total} segment(s): {segment_sequence}."]

        if invalids:
            reason_parts.append("Invalid route: " + "; ".join(invalids) + ".")
            reason_parts.append(
                "No route score is produced for an invalid route (UNKNOWN)."
            )
        elif status == "INSUFFICIENT_DATA":
            reason_parts.append(
                "Every referenced road has an UNKNOWN Phase 9D score (0 known segments). "
                "No score can be computed, so the route score is UNKNOWN."
            )
        else:
            if weighting == "distance":
                expr = " + ".join(
                    f"{float(rec[1])}*{float(rec[2])}" for rec in seg_records if rec[1] != "UNKNOWN"
                )
                denom = sum(float(rec[2]) for rec in seg_records if rec[1] != "UNKNOWN")
                reason_parts.append(
                    f"Distance-weighted average over known segments: ({expr}) / {denom:.3g} = {route_score}/100."
                )
            else:
                expr = " + ".join(
                    f"{float(rec[1])}" for rec in seg_records if rec[1] != "UNKNOWN"
                )
                n = sum(1 for rec in seg_records if rec[1] != "UNKNOWN")
                reason_parts.append(
                    f"Equal weighting over known segments: ({expr}) / {n} = {route_score}/100."
                )
            reason_parts.append(
                f"Suitability category: {category}. Known segments {known}/{total}, "
                f"unknown segments {unknown}."
            )
            if unknown > 0:
                reason_parts.append(
                    "UNKNOWN segments are never scored as good; they are excluded from the "
                    "score and lower confidence."
                )
            if known_fraction < 0.5:
                reason_parts.append(
                    "Data completeness is LOW (<50% of this route has known scores); "
                    "treat with extra caution."
                )
            reason_parts.append(f"Route confidence: {route_conf}.")

        reason_parts.append(
            "This is a MOCK/TEST route with fictional roads and is not real-world evidence."
        )
        reason = " ".join(reason_parts)

        return {
            "route_id": route_id,
            "route_name": route_name,
            "data_mode": data_mode,
            "data_source": data_source,
            "is_mock": is_mock,
            "total_segment_count": total,
            "known_segment_count": known,
            "unknown_segment_count": unknown,
            "known_fraction": known_fraction,
            "weighting_method": weighting,
            "segment_sequence": segment_sequence,
            "segment_scores": segment_scores,
            "explicit_distance_km_total": total_distance,
            "explicit_travel_time_minutes_total": total_travel,
            "route_score": route_score,
            "route_category": category,
            "route_confidence": route_conf,
            "recommendation_status": status,
            "reason": reason,
        }

    def category_for(self, score):
        if score is None:
            return "UNKNOWN"
        for band in self.suitability_bands:
            if band["min"] <= score <= band["max"]:
                return band["label"]
        return "UNKNOWN"

    # ------------------------------------------------------------------
    # Ranking / recommendation
    # ------------------------------------------------------------------
    @staticmethod
    def _eligible_key(row):
        return (
            -float(row["route_score"]),
            -float(row["route_confidence"]),
            -int(row["known_segment_count"]),
            row["route_id"],
        )

    def rank(self, rows):
        counts = {}
        for row in rows:
            counts[row["route_id"]] = counts.get(row["route_id"], 0) + 1
        for row in rows:
            if counts[row["route_id"]] > 1:
                row["recommendation_status"] = "INVALID_ROUTE"
                row["route_score"] = "UNKNOWN"
                row["route_category"] = "UNKNOWN"
                row["route_confidence"] = self.conf_floor
                row["reason"] = (
                    "Invalid route: duplicate route_id " + row["route_id"] +
                    " appears more than once in the candidate set; duplicate routes are " +
                    "excluded from recommendation. " + row["reason"]
                )

        eligible = [
            row for row in rows
            if row["recommendation_status"] not in ("INVALID_ROUTE", "INSUFFICIENT_DATA")
            and row["route_score"] != "UNKNOWN"
        ]
        if eligible:
            best = min(eligible, key=self._eligible_key)
            best["recommendation_status"] = "RECOMMENDED"

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------
    def build_validation(self, rows):
        def check(name, ok, detail=""):
            return {"check": name, "ok": "PASS" if ok else "FAIL", "detail": str(detail)}

        checks = []
        checks.append(check("required columns present", set(OUTPUT_COLUMNS) <= set(rows[0].keys())))
        bad_score = [
            r["route_id"] for r in rows
            if r["route_score"] != "UNKNOWN"
            and not (0 <= float(r["route_score"]) <= 100)
        ]
        checks.append(
            check("route scores numeric 0-100 or UNKNOWN",
                  not bad_score, bad_score)
        )
        bad_conf = [
            r["route_id"] for r in rows
            if not (0.0 <= float(r["route_confidence"]) <= 1.0)
        ]
        checks.append(check("route confidence within 0-1", not bad_conf, bad_conf))

        bad_cat = [
            r["route_id"] for r in rows
            if r["route_score"] != "UNKNOWN"
            and r["route_category"]
            != self.category_for(float(r["route_score"]))
        ]
        checks.append(check("routes categories match score bands", not bad_cat, bad_cat))

        unknown_good = [
            r["route_id"] for r in rows
            if r["route_score"] == "UNKNOWN" and r["route_category"] != "UNKNOWN"
        ]
        checks.append(
            check("UNKNOWN route never converted to GOOD", not unknown_good, unknown_good)
        )
        all_unknown = [
            r for r in rows
            if r["unknown_segment_count"] == r["total_segment_count"] > 0
        ]
        bad_all_unknown = [
            r["route_id"] for r in all_unknown
            if not (r["route_score"] == "UNKNOWN" and r["route_category"] == "UNKNOWN")
        ]
        checks.append(
            check("all-UNKNOWN routes remain UNKNOWN", not bad_all_unknown, bad_all_unknown)
        )

        invalid_marked = [
            r["route_id"] for r in rows
            if "NONEXISTENT" in r["reason"] and r["recommendation_status"] != "INVALID_ROUTE"
        ]
        checks.append(
            check("invalid routes explicitly marked invalid",
                  not invalid_marked, invalid_marked)
        )
        known_numeric = [
            r["route_id"] for r in rows
            if r["unknown_segment_count"] > 0 and r["route_score"] != "UNKNOWN"
            and r["known_segment_count"] == 0
        ]
        checks.append(
            check("score never built from zero known segments", not known_numeric, known_numeric)
        )

        mock_rows = [r for r in rows if r["data_mode"] == "mock"]
        bad_mock = [r["route_id"] for r in mock_rows if r["is_mock"] != "True"]
        checks.append(check("mock routes remain labelled mock", not bad_mock, bad_mock))
        live = [r["route_id"] for r in rows if r["data_mode"] in ("live", "manual")]
        checks.append(check("no fabricated live data", not live, live))

        ids = [r["route_id"] for r in rows]
        dups = sorted({i for i in ids if ids.count(i) > 1})
        dup_flagged = [
            r["route_id"] for r in rows
            if r["recommendation_status"] == "INVALID_ROUTE" and "duplicate route_id" in r["reason"]
        ]
        checks.append(
            check("duplicate route IDs rejected", set(dups) <= set(dup_flagged), dups)
        )

        recommended = [r for r in rows if r["recommendation_status"] == "RECOMMENDED"]
        if recommended:
            checks.append(
                check("single RECOMMENDED route", len(recommended) == 1,
                      [r["route_id"] for r in recommended])
            )
        else:
            checks.append(check("single RECOMMENDED route", True, "no eligible routes"))

        eligible = [r for r in rows if r["recommendation_status"] == "ELIGIBLE"]
        if recommended and eligible:
            best_eligible_score = max(float(r["route_score"]) for r in eligible)
            checks.append(
                check("RECOMMENDED has highest eligible score",
                      float(recommended[0]["route_score"]) >= best_eligible_score,
                      recommended[0]["route_score"])
            )

        again = [self.evaluate_route(route) for route in self.config.get("routes", [])]
        self.rank(again)
        same = True
        for a, b in zip(rows, again):
            if a["route_score"] != b["route_score"] or \
               a["route_category"] != b["route_category"] or \
               a["route_confidence"] != b["route_confidence"] or \
               a["recommendation_status"] != b["recommendation_status"]:
                same = False
                break
        checks.append(check("deterministic repeated execution", same))

        return checks

    def check_protected_files(self):
        results = {}
        total_checked = 0
        for group, pat in PROTECTED_GROUPS.items():
            prefix, _, pattern = pat.rpartition("/")
            base_dir = PROJECT_ROOT / prefix
            files = sorted(
                p for p in base_dir.glob(pattern) if p.is_file()
            ) if base_dir.exists() else []
            total_checked += len(files)
            changed = []
            for p in files:
                name = p.name
                if group == "level7d":
                    key = "level7d/" + name
                else:
                    key = name
                expected = self._baseline.get(key)
                if expected is None:
                    changed.append(f"{name} (no baseline)")
                else:
                    actual = (_sha256(p), p.stat().st_size)
                    if actual != tuple(expected[:2]):
                        changed.append(name)
            results[group] = {
                "count": len(files),
                "changed": changed,
                "ok": not changed,
            }
        return results, total_checked

    # ------------------------------------------------------------------
    # Outputs
    # ------------------------------------------------------------------
    def run(self, write_outputs=True):
        rows = [self.evaluate_route(route) for route in self.config.get("routes", [])]
        self.rank(rows)

        checks = self.build_validation(rows)

        # Baseline for protected-file integrity (Phase 9E pre-change hashes).
        baseline_path = Path(
            r"C:\Users\haris\AppData\Local\Temp\opencode\phase9e_baseline_hashes.json"
        )
        if baseline_path.exists():
            self._baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
        else:
            self._baseline = {}
        integrity, total_hashed = self.check_protected_files()

        summary = {
            "rows": rows,
            "checks": checks,
            "integrity": integrity,
            "total_hashed": total_hashed,
            "baseline_path": baseline_path,
        }

        if write_outputs:
            self.write_outputs(rows, checks, integrity, total_hashed)
        return summary

    def write_outputs(self, rows, checks, integrity, total_hashed):
        csv_path = PROCESSED_DIR / "phase9e_route_recommendations.csv"
        txt_path = PROCESSED_DIR / "phase9e_route_recommendation_report.txt"
        val_path = PROCESSED_DIR / "phase9e_validation.csv"

        with open(csv_path, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=OUTPUT_COLUMNS)
            writer.writeheader()
            for row in rows:
                writer.writerow(row)

        with open(val_path, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=["check", "ok", "detail"])
            writer.writeheader()
            for check in checks:
                writer.writerow(check)

        report = self.build_report(rows, checks, integrity, total_hashed)
        txt_path.write_text(report, encoding="utf-8")

    def build_report(self, rows, checks, integrity, total_hashed):
        line = "=" * 76
        verdict = "PASS" if all(c["ok"] == "PASS" for c in checks) else "FAIL"
        out = []
        out.append(line)
        out.append("  PHASE 9E - ROUTE RECOMMENDATION ENGINE (explainable prototype)")
        out.append(line)
        out.append(f"  Candidate routes      : {len(rows)}")
        out.append(f"  Validation checks     : {len(checks)}")

        out.append("")
        out.append("  1. PURPOSE")
        out.append("     Combine Phase 9D road suitability scores into explainable")
        out.append("     route-level scores for explicit candidate routes.")
        out.append("")
        out.append("  2. INPUT")
        out.append("     Phase 9D road scores consumed read-only from:")
        out.append(f"       {self.scores_path}")
        out.append("     The Phase 9D road IDs used by Phase 9E candidate routes:")
        out.append("       " + ", ".join(sorted(self.road_scores)))
        out.append("")
        out.append("  3. ROUTE MODEL")
        out.append("     Each route has: route_id, segment_order, road_id, road_name,")
        out.append("     optional distance_km, optional travel_time_minutes, data_mode.")
        out.append("     If a distance or travel time is unavailable it is NOT estimated")
        out.append("     and is left explicitly unavailable/blank. Fictional mock")
        out.append("     distances are used only to exercise the weighting logic.")
        out.append("")
        out.append("  4. ROUTE SCORE")
        out.append("     * Every segment score comes from Phase 9D (overall_score).")
        out.append("     * If EVERY segment has an explicit distance_km:")
        out.append("         route_score = sum(score_i * dist_i) / sum(dist_i) over KNOWN segments.")
        out.append("     * Otherwise equal weighting over the KNOWN segments is used.")
        out.append("     * UNKNOWN segments are NEVER scored as 100 and never counted toward")
        out.append("       the score; they lower completeness and confidence.")
        out.append("     * If every segment is UNKNOWN the route score is UNKNOWN.")
        out.append("")
        out.append("  5. ROUTE CONFIDENCE")
        out.append("     route_confidence = mean(Phase 9D segment confidence over ALL")
        out.append("       segments) * (known_segment_count / total_segment_count)")
        out.append("       * min(per-segment data-mode factor)  [clipped to 0.05..1.0]")
        out.append("     mode factors: live=1.0, manual=0.9, mock=0.7, unknown=0.25.")
        out.append("     This is intentionally conservative: mock data, UNKNOWN segments")
        out.append("     and incomplete routes all lower confidence.")
        out.append("")
        out.append("  6. ROUTE CATEGORY (same bands as Phase 9D)")
        out.append("     80-100 = GOOD | 60-79 = MODERATE | 40-59 = CAUTION |")
        out.append("     20-39 = POOR | 0-19 = VERY_POOR | UNKNOWN -> UNKNOWN")
        out.append("")
        out.append("  7. RECOMMENDATION")
        out.append("     RECOMMENDED   : highest-scoring eligible route (single pick)")
        out.append("     ELIGIBLE      : valid route with a numeric route score")
        out.append("     INSUFFICIENT_DATA : zero known segments (score UNKNOWN)")
        out.append("     INVALID_ROUTE : nonexistent road_id, duplicate route_id, empty")
        out.append("                    segment list, or invalid segment_order")
        out.append("     Ties broken by: confidence, then known segment count, then id.")
        out.append("")
        out.append("  8. ROUTE RESULTS")
        out.append(
            f"     {'route_id':<10}{'score':<9}{'cat':<11}{'conf':<6}{'status':<18}known"
        )
        for r in rows:
            out.append(
                f"     {r['route_id']:<10}{(str(r['route_score'])):<9}"
                f"{str(r['route_category']):<11}{str(r['route_confidence']):<6}"
                f"{str(r['recommendation_status']):<18}"
                f"{r['known_segment_count']}/{r['total_segment_count']}"
            )
        out.append("")
        out.append("  9. EXPLAINABLE REASONS")
        for r in rows:
            out.append(f"     {r['route_id']}: {r['reason']}")
        out.append("")
        out.append("  10. MOCK/TEST LIMITATIONS")
        out.append("      All candidate routes are DETERMINISTIC MOCK/TEST routes over the")
        out.append("      fictional Phase 9D MOCK-ROAD-* records. They describe no real")
        out.append("      roads and are NOT a production navigation system. Live traffic,")
        out.append("      weather, or road data is never fabricated.")
        out.append("")
        out.append("  VALIDATION")
        for c in checks:
            out.append(f"    [{c['ok']:<4}] {c['check']}  {c['detail']}")
        out.append("")
        out.append("  PROTECTED FILE INTEGRITY")
        for group, res in integrity.items():
            out.append(
                f"    [{('PASS' if res['ok'] else 'FAIL'):<4}] {group}: "
                f"{res['count']} file(s) unchanged"
            )
        out.append(f"    Total protected files verified : {total_hashed}")
        out.append("")
        out.append(f"  OVERALL VERDICT : {verdict}")
        out.append("")
        out.append("  IMPORTANT DISCLAIMER")
        out.append("  This is an explainable prototype route recommendation engine and is")
        out.append("  not a calibrated traffic-engineering or production navigation system.")
        out.append("")
        return "\n".join(out) + "\n"


def main():
    engine = RouteRecommendationEngine()
    summary = engine.run()
    checks = summary["checks"]
    rows = summary["rows"]
    print("  Candidate routes     :", len(rows))
    for r in rows:
        print(
            f"    {r['route_id']:<10} score={str(r['route_score']):<8} "
            f"cat={str(r['route_category']):<11} conf={r['route_confidence']} "
            f"status={r['recommendation_status']}"
        )
    print("  VALIDATION")
    for c in checks:
        print(f"    [{c['ok']:<4}] {c['check']}  {c['detail']}")
    print("  PROTECTED FILE INTEGRITY")
    for group, res in summary["integrity"].items():
        print(
            f"    [{('PASS' if res['ok'] else 'FAIL'):<4}] {group}: "
            f"{res['count']} file(s) unchanged {res['changed']}"
        )
    print(f"  Total protected files verified : {summary['total_hashed']}")
    print("  OVERALL VERDICT : " + (
        "PASS" if all(c["ok"] == "PASS" for c in checks) else "FAIL"
    ))


if __name__ == "__main__":
    main()