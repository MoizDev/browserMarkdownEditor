// Reference-only guard gate; all observations come from the real mounted app.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { launch } from '../harness/index.mjs';
import { prepareConsistentMarker } from '../harness/today/markers.mjs';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://localhost:6520/' },
  receipt: { type: 'string' },
  'reference-commit': { type: 'string' },
  'harness-commit': { type: 'string' },
  mode: { type: 'string', default: 'clean' },
  out: { type: 'string', default: '/Users/adham/Developer/bme-impl/scratch/w-b/b39/run' },
} });
if (!['clean', 'tool', 'object', 'version'].includes(values.mode)) throw Error('Unknown B-39 arm');
if (!values.receipt) throw Error('--receipt must name the independently built local reference manifest');
const out = resolve(values.out);
await mkdir(out, { recursive: true });
const report = { package: 'W-B2', mode: values.mode, pass: false, controls: [], errors: [] };
let h;
let mutation;
const local = JSON.parse(await readFile(values.receipt, 'utf8'));
try {
  h = await launch({
    baseURL: values.url, blockOffOrigin: true, referenceBuild: values.receipt,
    expectedReferenceCommit: values['reference-commit'], expectedHarnessCommit: values['harness-commit'],
    referenceVariant: values.mode === 'tool' ? 'pinned-tool' : 'reference',
    beforeNavigate: async runtime => {
      if (values.mode === 'object' || values.mode === 'version') {
        mutation = await prepareConsistentMarker(runtime, { mode: values.mode, expectedBuild: local });
        runtime.mutations.push(mutation);
      }
    },
  });
  report.runtime = h.runtimeIdentity;
  report.expected = { referenceCommit: values['reference-commit'], harnessCommit: values['harness-commit'], variant: local.variant, patchSha256: local.patchSha256 };
  await h.vault.seed({
    'Letter.pdf': await h.pdf.seed(),
    'PairA.tldraw': await readFile(new URL('../harness/fixtures/pair-a.tldraw', import.meta.url), 'utf8'),
    'PairB.tldraw': await readFile(new URL('../harness/fixtures/pair-b.tldraw', import.meta.url), 'utf8'),
  });
  await h.vault.open();
  for (const [kind, path] of [['drawing', 'Control.tldraw'], ['notebook', 'Control.notebook'], ['pdf', 'Letter.pdf']]) {
    if (kind === 'drawing') await h.ui.createDrawing(path);
    else if (kind === 'notebook') await h.ui.createNotebook(path);
    else await h.ui.annotate(path);
    report.identity = await h.identity();
    const controls = await h.referenceControls.runUI(path);
    h.referenceControls.require(['session.currentTool', 'session.selection', 'session.canUndo', 'session.canRedo'], { kind, phase: 'after-action' });
    report.controls.push({ kind, path, controls });
    await h.page.screenshot({ path: resolve(out, `${kind}.png`) });
  }
  report.persistedPair = await h.referenceControls.persistedPair({ first: 'PairA.tldraw', second: 'PairB.tldraw' });
  if (values.mode !== 'clean') throw Error('EXPECTED_GUARD_MISSED: pinned toolbar did not trigger its named tool-field control');
  if (h.errors.length) throw Error(`Unexpected app errors: ${h.errors.join('; ')}`);
  report.pass = true;
} catch (error) {
  report.fault = error.stack;
  report.namedGuard = String(error.message).match(/PROBE_(?:OBJECT|VERSION|CONTROL|PATH)_ASSERT[^\n]*/)?.[0] ?? null;
  const expectedGuard = values.mode === 'tool' ? /PROBE_CONTROL_ASSERT session\.currentTool: draw real toolbar state/
    : values.mode === 'object' ? /PROBE_OBJECT_ASSERT editor\.getCurrentPageShapes: expected a function/
      : values.mode === 'version' ? /PROBE_VERSION_ASSERT @tldraw\/[\w-]+: fetched 0\.0\.0, expected 5\.2\.4/ : null;
  if (expectedGuard?.test(error.message)) {
    if (mutation) report.mutation = mutation.assertApplied();
    report.pass = true;
    report.rejectedByNamedGuard = true;
  }
  if (!report.pass) process.exitCode = 1;
} finally {
  if (h) {
    report.versionAssertions = h.probeVersionAssertions;
    report.controlJournal = h.referenceControlJournal;
    report.controlAttempts = h.referenceControlAttempts;
    const mapping = await readFile(new URL('../harness/FIELD_MAP.md', import.meta.url), 'utf8');
    const fields = mapping.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| Field ')).map(line => line.split('|')[1].trim());
    report.fieldCoverage = Object.fromEntries(['drawing', 'notebook', 'pdf'].map(kind => [kind, fields.map(field => ({
      field,
      status: h.referenceControlJournal?.some(row => row.kind === kind && row.complete && row.fields.includes(field)) ? 'CONTROLLED in this run (mapping limits still apply)' : 'UNCONTROLLED / unavailable / not a parity quantity — see FIELD_MAP.md',
    }))]));
    report.errors = h.errors;
    report.network = h.network;
    await h.page.screenshot({ path: resolve(out, 'final.png') }).catch(() => {});
    await h.close();
  }
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ ...report, network: report.network?.length }, null, 2));
