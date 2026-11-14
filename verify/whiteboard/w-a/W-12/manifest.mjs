// Artifact bookkeeping over real-app browser runs, not a product/codec test.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = process.env.W12_BUILD_ROOT ?? '/Users/adham/Developer/bme-impl/scratch/w-a/w12';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function files(dir) {
  const found = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await files(name)); else found.push(name);
  }
  return found.sort();
}
async function evidence(name) {
  const result = { name, results: [], faults: [], artifacts: [] };
  for (const file of await files(path.join(root, 'evidence', name))) {
    const bytes = await fs.readFile(file);
    result.artifacts.push({ path: path.relative(root, file), bytes: bytes.length, sha256: hash(bytes) });
    if (file.endsWith('/result.json')) {
      const r = JSON.parse(bytes.toString());
      result.results.push({ arm: r.arm, status: r.status, passed: r.passed, failures: r.failures,
        witness: r.witness, identity: r.identity, errors: r.errors,
        windowTouchRegistrations: r.windowTouchRegistrations ? {
          beforePen: r.windowTouchRegistrations.beforePen.appActive,
          armed: r.windowTouchRegistrations.armed.appActive,
          after: r.windowTouchRegistrations.after.appActive,
        } : undefined });
    } else if (file.endsWith('/failure.json')) {
      const r = JSON.parse(bytes.toString()); result.faults.push({ path: path.relative(root, file), message: r.message, build: r.build });
    }
  }
  return result;
}
const names = ['candidate-dynamic-r2', 'no-filter-dynamic', 'forget-touches-dynamic',
  'candidate-dynamic-lazy-r2', 'eager-canvas-dynamic', 'always-touch-dynamic',
  'candidate-cancel', 'candidate-cancel-pan', 'seam', 'seam-lazy'];
const captures = Object.fromEntries(await Promise.all(names.map(async name => [name, await evidence(name)])));
const builds = {};
for (const name of ['candidate-dynamic', 'no-filter-dynamic', 'forget-touches-dynamic', 'eager-canvas-dynamic', 'always-touch-dynamic']) {
  const file = path.join(root, name, 'build.json');
  const bytes = await fs.readFile(file).catch(() => null);
  if (bytes) builds[name] = { ...JSON.parse(bytes.toString()), metadataSha256: hash(bytes) };
}
const rows = name => captures[name].results;
const primary = rows('candidate-dynamic-r2'), noFilter = rows('no-filter-dynamic'), forgotten = rows('forget-touches-dynamic');
const lazy = rows('candidate-dynamic-lazy-r2');
const checks = {
  penAndLifetime: primary.length === 6 && primary.every(r => r.passed),
  noFilterMutant: noFilter.length === 6 && noFilter.every(r => r.failures?.includes('pen-stroke-complete')),
  forgottenContactsMutant: forgotten.length === 6 && forgotten.every(r => r.failures?.includes('held-touch-after-pen-up')),
  noIdleBlockingAndNoCanvas: lazy.length === 1 && lazy[0].passed && lazy[0].witness.idleNonPassiveWindowTouchListeners === 0,
  eagerImportMutant: captures['eager-canvas-dynamic'].faults.some(r => /A Markdown-only session loaded (a canvas engine chunk|the canvas library)/.test(r.message)),
  idleTouchMutant: captures['always-touch-dynamic'].faults.some(r => r.message.startsWith('W12-TOUCH-IDLE:')),
};
const cancel = [...rows('candidate-cancel'), ...rows('candidate-cancel-pan')];
const seam = rows('seam'), seamLazy = rows('seam-lazy');
const sourceSha256 = hash(await fs.readFile('src/utils/penPriority.ts'));
const seamVerified = seam.length === 6 && seam.every(r => r.passed
  && r.identity.build.sourceMode === 'unmodified-seam-ref' && r.identity.build.filterSha256 === sourceSha256)
  && seamLazy.length === 1 && seamLazy[0].passed
  && seamLazy[0].identity.build.sourceMode === 'unmodified-seam-ref';
const scripts = [];
for (const file of await files(import.meta.dirname)) {
  if (file.endsWith('gate-manifest.json')) continue;
  const bytes = await fs.readFile(file); scripts.push({ path: path.relative(import.meta.dirname, file), sha256: hash(bytes), bytes: bytes.length });
}
for (const name of ['../lib/browser.mjs', '../lib/files.mjs']) {
  const bytes = await fs.readFile(path.resolve(import.meta.dirname, name));
  scripts.push({ path: name, sha256: hash(bytes), bytes: bytes.length });
}
const result = { package: 'W-12', sourceSha256,
  status: Object.values(checks).every(Boolean) ? seamVerified ? 'available-proofs-complete-cancel-not-covered' : 'waiting-startup-seam-replay' : 'incomplete',
  checks, seamVerified, trustedCancel: { status: 'NOT COVERED', routesAttempted: cancel.length,
    qualifyingRoutes: cancel.filter(r => r.witness.trustedPenCancel).length,
    upOnlyMutant: 'not proved; no trusted pen cancel was available', decisionOwner: 'w-lead / r-gates / vr-lead' },
  attribution: 'Registration API ledger retains raw records. App records have a served-origin stack; anonymous Playwright hit-target touch interceptors are not attributed to the app. Every primary arm controls this attribution with four real non-passive app listeners after pen-down, then zero after contacts end.',
  privateProbe: 'none', builds, captures, scripts };
await fs.writeFile(path.join(import.meta.dirname, 'gate-manifest.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ status: result.status, checks, seamVerified, trustedCancel: result.trustedCancel }, null, 2));
