/**
 * Demo CCTV preparation workflow (run with: npm run prepare:demo:cctv).
 *
 * ADDITIVE / READ-ONLY over the protected pipeline outputs:
 *   - reads the demo CCTV registry (src/data/demoCctvManifest.json)
 *   - reconciles it against the raw footage folders under data/demo_cctv/
 *   - prints the annotation + YOLO fine-tuning steps that WOULD run for a
 *     future demo dataset, then explicitly declares that NO TRAINING RUN is
 *     executed here
 *   - model weights are left UNCHANGED; nothing is written anywhere
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');
const manifestPath = join(__dirname, '..', 'src', 'data', 'demoCctvManifest.json');
const footageRoot = join(root, 'data', 'demo_cctv');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
if (manifest.kind !== 'DEMO RECORDED CCTV REGISTRY') {
  throw new Error('Unexpected manifest kind: ' + manifest.kind);
}

console.log('Demo CCTV preparation (verification only)');
console.log('  registry: ' + manifestPath);
console.log('  footage root: ' + footageRoot);
console.log('');

let missing = 0;
for (const route of manifest.routes) {
  const folder = join(footageRoot, route.route_id);
  const exists = existsSync(folder);
  const clips = exists ? readdirSync(folder).filter((f) => /\.mp4$/i.test(f)) : [];
  console.log(
    `  ${route.route_id} (${route.label}): ${route.cameras.length} registered source(s),` +
      ` footage folder ${exists ? `present (${clips.length} clip(s))` : 'MISSING'}`
  );
  if (!exists) missing += 1;
}

console.log('');
console.log('  recorded-demo honesty:');
console.log(`    live:              ${manifest.honesty.live}`);
console.log(`    geographicallyMapped: ${manifest.honesty.geographicallyMapped}`);
console.log(`    label:             ${manifest.honesty.label}`);

console.log('');
console.log('  Planned (NOT executed) steps for a future demo dataset:');
console.log('    1. annotate demo clips -> COCO/YOLO labels');
console.log('    2. fine-tune YOLOv5 detector on the demo subset');
console.log('    3. run the trained detector over the demo clips for metrics');

console.log('');
console.log('  RESULT');
console.log(`    footage folders missing: ${missing}`);
console.log('    NO TRAINING RUN executed by this script.');
console.log('    Model weights are UNCHANGED.');
console.log('    No files were written.');