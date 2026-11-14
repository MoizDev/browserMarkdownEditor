import assert from 'node:assert/strict';
import { runArm, hash } from './lib/browser.mjs';
import { seedPdf, exportNotebook } from './lib/files.mjs';

await runArm('WB-D1', 'same-name-other-folder', async h => {
  const first = await seedPdf(), second = await seedPdf();
  await h.seed({ 'Seed.md': '# Export collision control',
    'A/Same.notebook': '', 'A/Same.pdf': first, 'B/Same.notebook': '', 'B/Same.pdf': second });
  await h.openVault(); await h.open('A/Same.notebook'); await h.ready();
  const a = await exportNotebook(h);
  assert(a.asked, 'Positive control: first replacement must ask');
  await h.open('B/Same.notebook'); await h.ready();
  const before = await h.read('B/Same.pdf'), mark = await h.mark();
  const b = await exportNotebook(h);
  await h.waitWrite('B/Same.pdf', mark);
  const after = await h.read('B/Same.pdf');
  await h.artifact('original-B.pdf', before); await h.artifact('replaced-B.pdf', after);
  const entries = await h.io('list');
  const recovery = [];
  for (const entry of entries.filter(e => e.kind === 'file' && /(^|\/)\.Garbage\//.test(e.path))) {
    const bytes = await h.read(entry.path);
    recovery.push({ path: entry.path, sha256: hash(bytes), matchesOriginal: hash(bytes) === hash(before) });
  }
  return { witness: { firstAsked: a.asked, secondAsked: b.asked,
    targetChanged: hash(before) !== hash(after), replacedBytesRecoverable: recovery.some(e => e.matchesOriginal) },
    reproduced: !b.asked && hash(before) !== hash(after), firstDialog: a, secondDialog: b, recovery,
    beforeSha256: hash(before), afterSha256: hash(after), capture: await h.capture('after-replacement'),
    loss: 'OPFS, not a real-disk failure between truncation and write. This arm measures cross-folder trust, not cross-vault trust.' };
});
