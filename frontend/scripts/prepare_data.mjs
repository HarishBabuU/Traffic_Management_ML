/**
 * Phase 9F-1 data preparation script.
 *
 * Reads the ALREADY-GENERATED, protected processed outputs of Phase 8 /
 * Phase 9A-9E from ../../../data/processed and writes explicit JSON copies
 * that the browser dashboard can import safely (browsers cannot read
 * arbitrary project CSV files directly in every setup).
 *
 * IMPORTANT:
 *   - This script is READ-ONLY over the processed outputs. It never
 *     modifies them and never regenerates any analysis.
 *   - The JSON copies preserve the ORIGINAL values, data_mode, is_mock and
 *     source information. Mock data stays labelled mock.
 *   - It also copies the Phase 8 visualization PNGs (unchanged bytes) into
 *     the frontend's public/ folder so the UI can display them.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FRONTEND_ROOT = join(__dirname, '..');
export const PROJECT_ROOT = join(FRONTEND_ROOT, '..');
export const PROCESSED_DIR = join(PROJECT_ROOT, 'data', 'processed');
export const DEMO_CCTV_EVIDENCE_SOURCE = join(
  PROJECT_ROOT,
  'data',
  'demo_processed_cctv',
  'demo_cctv_traffic_evidence.json'
);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x !== ''));
}

export function readCsv(fileName) {
  const text = readFileSync(join(PROCESSED_DIR, fileName), 'utf-8');
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = idx < r.length ? r[idx] : '';
    });
    return obj;
  });
}

export function writeJson(fileName, payload) {
  const outDir = join(FRONTEND_ROOT, 'src', 'data');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, fileName),
    JSON.stringify(payload, null, 2) + '\n',
    'utf-8'
  );
}

function copyVisualizations() {
  const srcDir = join(PROCESSED_DIR, 'level8_visualizations');
  const outDir = join(FRONTEND_ROOT, 'public', 'level8');
  mkdirSync(outDir, { recursive: true });
  const files = readdirSync(srcDir).filter((f) => f.toLowerCase().endsWith('.png'));
  const copied = [];
  for (const f of files) {
    copyFileSync(join(srcDir, f), join(outDir, f));
    copied.push(f);
  }
  return copied;
}

function prepareDemoCctvEvidence() {
  const evidence = JSON.parse(readFileSync(DEMO_CCTV_EVIDENCE_SOURCE, 'utf-8'));
  return {
    ...evidence,
    generated_from: 'data/demo_processed_cctv/demo_cctv_traffic_evidence.json',
    note: 'Explicit prepared copy for the browser dashboard. All evidence values (kind, source, live, geographically_mapped, normalized_metric, camera_evidence, route_summary, limitations) are preserved verbatim from the already-generated demo CCTV processing output.',
    source_phase: 'protected demo CCTV processing output (read-only)',
  };
}

function wrap(fileName) {
  return {
    generated_from: `data/processed/${fileName}`,
    note: 'Explicit prepared copy for the browser dashboard. Original values, data_mode, is_mock and source information are preserved verbatim.',
    source_phase: 'protected processed output (read-only)',
    rows: readCsv(fileName),
  };
}

function main() {
  const payload = {
    traffic: wrap('phase9a_traffic_conditions.csv'),
    weather: wrap('phase9b_weather.csv'),
    roadConditions: wrap('phase9c_road_conditions.csv'),
    roadScores: wrap('phase9d_road_scores.csv'),
    routes: wrap('phase9e_route_recommendations.csv'),
    level8: {
      generated_from: [
        'data/processed/level8_traffic_statistics.csv',
        'data/processed/level8_class_by_video.csv',
        'data/processed/level8_traffic_over_time.csv',
      ],
      note: 'Explicit prepared copy for the browser dashboard. Original values preserved verbatim.',
      source_phase: 'protected processed output (read-only)',
      traffic_statistics: readCsv('level8_traffic_statistics.csv'),
      class_by_video: readCsv('level8_class_by_video.csv'),
      traffic_over_time: readCsv('level8_traffic_over_time.csv'),
    },
    copied_visualizations: copyVisualizations(),
  };

  writeJson('traffic.json', payload.traffic);
  writeJson('weather.json', payload.weather);
  writeJson('roadConditions.json', payload.roadConditions);
  writeJson('roadScores.json', payload.roadScores);
  writeJson('routes.json', payload.routes);
  writeJson('level8.json', payload.level8);
  writeJson('demoCctvEvidence.json', prepareDemoCctvEvidence());

  console.log('Prepared JSON data files in frontend/src/data/:');
  console.log('  traffic.json, weather.json, roadConditions.json, roadScores.json, routes.json, level8.json, demoCctvEvidence.json');
  console.log('Copied visualizations to frontend/public/level8/:');
  payload.copied_visualizations.forEach((f) => console.log('  ' + f));

  console.log('');
  console.log('demoCctvEvidence.json');
}

main();