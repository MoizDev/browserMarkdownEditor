// Bookkeeping over retained real-app outputs; this does not exercise an app or codec.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { seedPdf } from './lib/files.mjs';

const root = process.env.WA_SCRATCH ?? '/Users/adham/Developer/bme-impl/scratch/w-a';
const phase = process.env.PHASE ?? 'before';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = { 'WB-D1': 1, 'WB-D2': 1, 'WB-D3': 9, 'WB-D5': 2, 'WB-D6': 2,
  'WB-D8': 9, 'WB-D19': 12, 'WB-D21': 2, 'WB-D22': 9, 'WB-D28': 2, 'WB-D33': 2, 'WB-D39': 4 };
async function files(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(name)); else result.push(name);
  }
  return result.sort();
}
function compare(left, right, key = '') {
  if (/heapDelta/.test(key)) return [];
  if (typeof left === 'number' && typeof right === 'number') {
    const tolerance = /Pixels/.test(key) ? Math.max(Math.abs(left), Math.abs(right)) * .05 + 3
      : /freshPinchRatio/.test(key) ? Math.max(Math.abs(left), Math.abs(right)) * .01
      : /zoom/.test(key) ? Math.max(Math.abs(left), Math.abs(right)) * .1
      : /canvasAttributedFiresInSeconds1To9\.raf/.test(key) ? Math.max(Math.abs(left), Math.abs(right)) * .3
      : /canvasAttributedFiresInSeconds1To9\.(timeout|interval)/.test(key) ? 2 : 0;
    return Math.abs(left - right) <= tolerance ? [] : [{ field: key, left, right, tolerance }];
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].flatMap(child => compare(left[child], right[child], key ? `${key}.${child}` : child));
  }
  return left === right ? [] : [{ field: key, left, right }];
}
const rows = [];
for (const [row, expectedArms] of Object.entries(expected)) {
  const base = path.join(root, 'reference', row, phase), arms = new Map();
  for (const file of (await files(base)).filter(file => file.endsWith('/result.json'))) {
    const result = JSON.parse(await fs.readFile(file, 'utf8'));
    const match = path.basename(path.dirname(file)).match(/^(.*)-([12])$/);
    if (!match) throw Error(`Result has no repeat identity: ${file}`);
    const [, name, repeat] = match;
    const arm = arms.get(name) ?? { name, repetitions: [] };
    const artifacts = [];
    for (const artifact of await files(path.dirname(file))) {
      const bytes = await fs.readFile(artifact);
      artifacts.push({ path: path.relative(root, artifact), bytes: bytes.length, sha256: sha(bytes) });
    }
    arm.repetitions.push({ repeat: Number(repeat), result: path.relative(root, file), sha256: sha(await fs.readFile(file)),
      build: result.identity.build, chrome: result.identity.chrome, versionMarkers: result.identity.versionMarkers,
      fixture: result.fixture ?? null, witness: result.witness, reproduced: result.reproduced,
      observationStatus: result.status ?? 'observed', errors: result.errors, artifacts });
    arms.set(name, arm);
  }
  for (const arm of arms.values()) {
    arm.repetitions.sort((a, b) => a.repeat - b.repeat);
    const [a, b] = arm.repetitions;
    arm.differences = a && b ? compare(a.witness, b.witness) : [{ field: 'repeat', missing: true }];
    if (a && b && a.reproduced !== b.reproduced) arm.differences.push({ field: 'reproduced', left: a.reproduced, right: b.reproduced });
    if (a && b && (a.build.commit !== b.build.commit || a.build.indexSha256 !== b.build.indexSha256 || a.chrome !== b.chrome)) {
      arm.differences.push({ field: 'identity', message: 'Repeat build/browser differs' });
    }
    arm.status = arm.repetitions.some(r => r.observationStatus.startsWith('pending')) ? 'pending-B39'
      : arm.differences.length ? 'repeat-mismatch-or-missing' : 'repeated-observation';
  }
  rows.push({ row, expectedArms, recordedArms: arms.size,
    complete: arms.size === expectedArms && [...arms.values()].every(a => a.status === 'repeated-observation'),
    arms: [...arms.values()].sort((a, b) => a.name.localeCompare(b.name)) });
}
const scripts = [];
for (const file of (await files(import.meta.dirname)).filter(file => !file.endsWith('reference-manifest.json'))) {
  const bytes = await fs.readFile(file);
  scripts.push({ path: path.relative(import.meta.dirname, file), bytes: bytes.length, sha256: sha(bytes) });
}
const result = { package: 'W-00', phase, kind: 'reference capture, not M0 acceptance',
  privateProbe: 'none; WB-D33 pending B-39 because public Status does not identify selected nodes',
  mutantStatus: 'Per-fix semantic mutants are not built in this reference-only package; no acceptance gate is signed off.',
  fixtureSources: { emptyCanvas: { bytes: 0, sha256: sha(Buffer.alloc(0)), origin: 'original empty new canvas' },
    originalPdf: { sha256: sha(await seedPdf()), origin: 'lib/files.mjs seedPdf, installed MIT pdf-lib, fixed dates' },
    retainedCorpus: 'per-result fixture SHA-256 or retained fixture-* artifact; planning corpus generated from real app input',
    storedDark: { sha256: sha(JSON.stringify({ version: 13, user: { id: 'W00OriginalPreference', color: '#55B467', colorScheme: 'dark' } })), origin: 'original nondefault browser preference record in WB-D28.mjs' } },
  status: rows.every(row => row.complete) ? 'complete-reference-observations' : 'partial-reference-observations',
  rows, scripts };
const filename = path.join(import.meta.dirname, 'reference-manifest.json');
await fs.writeFile(filename, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ manifest: filename, status: result.status,
  rows: rows.map(row => ({ row: row.row, arms: `${row.recordedArms}/${row.expectedArms}`, complete: row.complete,
    pendingOrDifferent: row.arms.filter(a => a.status !== 'repeated-observation').map(a => ({ name: a.name, status: a.status, differences: a.differences })) })) }, null, 2));
