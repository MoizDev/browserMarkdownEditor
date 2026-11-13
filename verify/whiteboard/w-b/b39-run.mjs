// Reference-only guard gate; all observations come from the real mounted app.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { launch } from '../harness/index.mjs';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://localhost:6520/' },
  receipt: { type: 'string' },
  'reference-commit': { type: 'string' },
  'harness-commit': { type: 'string' },
  mode: { type: 'string', default: 'clean' },
  out: { type: 'string', default: '/Users/adham/Developer/bme-impl/scratch/w-b/b39/run' },
} });
if (!['clean', 'tool'].includes(values.mode)) throw Error('This checkpoint supports clean/tool; served marker arms are not yet offered');
if (!values.receipt) throw Error('--receipt must name the independently built local reference manifest');
const out = resolve(values.out);
await mkdir(out, { recursive: true });
const report = { package: 'W-B2', mode: values.mode, pass: false, controls: [], errors: [] };
let h;
try {
  h = await launch({
    baseURL: values.url, blockOffOrigin: true, referenceBuild: values.receipt,
    expectedReferenceCommit: values['reference-commit'], expectedHarnessCommit: values['harness-commit'],
    referenceVariant: values.mode === 'tool' ? 'pinned-tool' : 'reference',
  });
  report.runtime = h.runtimeIdentity;
  const local = JSON.parse(await readFile(values.receipt, 'utf8'));
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
  if (values.mode === 'tool' && /PROBE_CONTROL_ASSERT session\.currentTool/.test(error.message)) {
    report.pass = true;
    report.rejectedByNamedGuard = true;
  }
  if (!report.pass) process.exitCode = 1;
} finally {
  if (h) {
    report.versionAssertions = h.probeVersionAssertions;
    report.controlJournal = h.referenceControlJournal;
    report.errors = h.errors;
    report.network = h.network;
    await h.page.screenshot({ path: resolve(out, 'final.png') }).catch(() => {});
    await h.close();
  }
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ ...report, network: report.network?.length }, null, 2));
