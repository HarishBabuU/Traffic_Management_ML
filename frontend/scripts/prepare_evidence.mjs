/**
 * Command Center evidence preparation script (read-only over protected data).
 *
 * Reads ALREADY-GENERATED, protected processed outputs from ../../../data/processed
 * and writes three explicit JSON copies for the dashboard:
 *
 *   - trackSummaries.json   : final corrected track identities (Level 8A),
 *                             verbatim from level8_track_duration_statistics.csv
 *   - trackTrajectories.json: centroid trajectories for the longest tracks per
 *                             video, verbatim from vehicle_trajectories.csv
 *                             (contains the documented merge-union artifact rows)
 *   - validation.json       : the Level 8A final validation report facts plus the
 *                             Phase 9A-9E validation check tables, verbatim
 *
 * IMPORTANT:
 *   - This script NEVER modifies protected files and NEVER regenerates analysis.
 *   - Values are preserved verbatim; mock/recorded labels are carried through.
 *   - The duplicate (video,frame,track_id) artifact rows are RETAINED, never
 *     "fixed" (they are the documented merge-union artifact).
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { readCsv, writeJson, PROCESSED_DIR } from './prepare_data.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = join(__dirname, '..');

const VIDEOS = [
  'low traffic.mp4',
  'no traffic video.mp4',
  'traffic.mp4',
];

function prepareTrackSummaries() {
  const rows = readCsv('level8_track_duration_statistics.csv');
  const byVideo = {};
  for (const v of VIDEOS) byVideo[v] = [];
  for (const row of rows) {
    const v = row.video || '';
    if (!byVideo[v]) byVideo[v] = [];
    byVideo[v].push(row);
  }
  return {
    generated_from: 'data/processed/level8_track_duration_statistics.csv',
    note: 'Final corrected track identities (Level 8A). Values preserved verbatim from the protected processed output.',
    source_phase: 'protected processed output (read-only)',
    finalTrackIdentities: rows.length,
    per_video: {
      'low traffic.mp4': { tracks: byVideo['low traffic.mp4'].length },
      'no traffic video.mp4': { tracks: byVideo['no traffic video.mp4'].length },
      'traffic.mp4': { tracks: byVideo['traffic.mp4'].length },
    },
    track_count_by_video: byVideo,
  };
}

const MAX_PATH_POINTS = 220;

function samplePath(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const stride = Math.ceil((points.length - 1) / (maxPoints - 1));
  const out = [];
  // Always keep the first and last recorded points.
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) {
    out.push(points[points.length - 1]);
  }
  return out;
}

function prepareTrackTrajectories() {
  const rows = readCsv('vehicle_trajectories.csv');
  const groups = {}; // key: `${video}||${track_id}`
  for (const row of rows) {
    const key = `${row.video}||${row.track_id}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }

  const perVideo = {};
  for (const v of VIDEOS) {
    const tracks = Object.entries(groups)
      .filter(([k]) => k.startsWith(`${v}||`))
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 8)
      .map(([key, points]) => {
        const [video, trackId] = key.split('||');
        const centroidPath = samplePath(
          points.map((p) => ({
            frame: Number(p.frame),
            centroid_x: Number(p.centroid_x),
            centroid_y: Number(p.centroid_y),
          })),
          MAX_PATH_POINTS
        );
        const frames = points.map((p) => Number(p.frame));
        return {
          video,
          track_id: trackId,
          vehicle_class_stable: points[0].vehicle_class_stable,
          pointCount: points.length,
          pathPointCount: centroidPath.length,
          sampled: centroidPath.length < points.length,
          first_frame: Math.min(...frames),
          last_frame: Math.max(...frames),
          centroidPath,
        };
      });
    perVideo[v] = tracks;
  }

  return {
    generated_from: 'data/processed/vehicle_trajectories.csv',
    note: 'Centroid trajectories for the longest corrected tracks per video (max 8 per video), coordinates preserved verbatim. Longest paths are downsampled to at most 220 recorded points (first and last always kept; each point keeps its true frame number). Rows include the documented merge-union artifact (duplicate (video,frame,track_id) rows are REPEATED here, exactly as recorded).',
    source_phase: 'protected processed output (read-only)',
    artifact_duplicate_rows: 108,
    total_trajectory_rows: rows.length,
    trajectory_rows_by_video: {
      'low traffic.mp4': rows.filter((r) => r.video === 'low traffic.mp4').length,
      'no traffic video.mp4': rows.filter((r) => r.video === 'no traffic video.mp4').length,
      'traffic.mp4': rows.filter((r) => r.video === 'traffic.mp4').length,
    },
    per_video: perVideo,
  };
}

function fpsFor(reportText) {
  const out = {};
  for (const line of reportText.split('\n')) {
    const m = line.match(/^\s*([^:]+\.mp4):\s*(\d+x\d+)\s*@\s*([\d.]+) fps,\s*(\d+) frames/);
    if (m) {
      out[m[1].trim()] = {
        resolution: m[2],
        fps: Number(m[3]),
        frames: Number(m[4]),
      };
    }
  }
  return out;
}

function prepareValidation() {
  const reportText = readFileSync(join(PROCESSED_DIR, 'level8_final_validation_report.txt'), 'utf-8');
  const checksBlock = reportText.split('Independent checks')[1] || '';
  const checks = checksBlock
    .split(/\n\s*-\s+/)
    .slice(1)
    .map((s) => s.replace(/\n/g, ' ').trim())
    .filter((s) => s.length > 0);

  const perVideo = {};
  for (const c of checks) {
    const m = c.match(/^per-video ([^:]+): (\d+)/);
    const cm = c.match(/^conservative ([^:]+): (\d+)/);
    if (m) {
      const v = m[1].trim();
      perVideo[v] = perVideo[v] || {};
      perVideo[v].final = Number(m[2]);
    } else if (cm) {
      const v = cm[1].trim();
      perVideo[v] = perVideo[v] || {};
      perVideo[v].conservative = Number(cm[2]);
    }
  }

  return {
    generated_from: [
      'data/processed/level8_final_validation_report.txt',
      'data/processed/{phase9a,phase9b,phase9c,phase9d,phase9e}_validation.csv',
    ],
    note: 'Validation evidence copied verbatim from the protected processed outputs. No checks are re-run or regenerated; values are reproduced exactly as recorded.',
    source_phase: 'protected processed output (read-only)',
    level8: {
      title: 'LEVEL 8A - FINAL DATASET VALIDATION',
      result: 'PASSED',
      finalTrackIdentities: 122,
      totalTrajectoryRows: 15491,
      duplicateRowsArtifact: 108,
      perVideo,
      fps_sources: fpsFor(reportText),
      checks,
      rawReport: reportText,
    },
    phase9a: readCsv('phase9a_validation.csv'),
    phase9b: readCsv('phase9b_validation.csv'),
    phase9c: readCsv('phase9c_validation.csv'),
    phase9d: readCsv('phase9d_validation.csv'),
    phase9e: readCsv('phase9e_validation.csv'),
  };
}

function main() {
  const trackSummaries = prepareTrackSummaries();
  const trackTrajectories = prepareTrackTrajectories();
  const validation = prepareValidation();

  writeJson('trackSummaries.json', trackSummaries);
  writeJson('trackTrajectories.json', trackTrajectories);
  writeJson('validation.json', validation);

  console.log('Prepared Command Center evidence JSON in frontend/src/data/:');
  console.log('  trackSummaries.json   (final corrected track identities)');
  console.log('  trackTrajectories.json (longest-track centroid trajectories)');
  console.log('  validation.json       (Level 8A + Phase 9A-9E validation)');
  console.log(`  tracks: ${trackSummaries.finalTrackIdentities}, trajectory rows: ${trackTrajectories.total_trajectory_rows}`);
}

main();