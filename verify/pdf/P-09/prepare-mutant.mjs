// Scratch SOURCE builds, never serve-time replacement of role/guard logic.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
const [destination, mutant] = process.argv.slice(2);
if (!destination || !mutant) throw new Error('Usage: prepare-mutant.mjs NEW_SCRATCH_DIR no-guard|null-plain|legacy-wins|entry-only|entry-and-funnel');
const root = new URL('../../../', import.meta.url).pathname;
await mkdir(destination); // Must be new; never patch a shared tree in place.
for (const name of ['src', 'shared', 'public', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json']) {
  try { await cp(path.join(root, name), path.join(destination, name), { recursive: true, errorOnExist: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
// macOS APFS clone: independent writable files, never a symlink/shared install.
execFileSync('/bin/cp', ['-cR', path.join(root, 'node_modules'), path.join(destination, 'node_modules')]);
const patches = {
  'no-guard': [['src/utils/pdfAttachmentInventory.ts', '    try {\n        const doc = await PDFDocument.load(bytes,', "    return { kind: 'plain', generation, alreadyAnnotated: false, original: bytes, snapshot: '', notebookSource: null };\n    try {\n        const doc = await PDFDocument.load(bytes,"]],
  'null-plain': [['src/utils/pdfAttachmentInventory.ts', "if (!(ef instanceof PDFDict)) return failure('null');", "if (!(ef instanceof PDFDict)) return { kind: 'plain', generation, alreadyAnnotated: false, original: bytes, snapshot: '', notebookSource: null };"]],
  'legacy-wins': [['src/utils/pdfAttachmentInventory.ts', 'if (newer.length) return', 'if (newer.length && !all.some(entry => has(entry, SNAPSHOT_ATTACHMENT))) return']],
  'entry-only': [['src/components/PdfPane.tsx', 'setSource({ role, handle, path: file.path, entry: annotateEntry });', "setSource({ role: isEditablePdfRole(role) ? role : { kind: 'plain', alreadyAnnotated: false, generation: role.generation, original: bytes, snapshot: '', notebookSource: null }, handle, path: file.path, entry: annotateEntry });"]],
};
patches['entry-and-funnel'] = [...patches['entry-only'],
  ['src/App.tsx', "if (isPdf && (!pdfData || !canRebuildAnnotatedPdf(pdfData.original))) return 'skipped';", "if (isPdf && !pdfData) return 'skipped';"],
  ['src/App.tsx', "if (isPdf && !canRebuildAnnotatedPdf(pdfData!.original)) return 'skipped';", '/* mutant: post-build capability check removed */'],
];
if (!patches[mutant]) throw new Error(`Unknown mutant ${mutant}`);
const applied = [];
for (const [file, oldText, newText] of patches[mutant]) {
  const target = path.join(destination, file), source = await readFile(target, 'utf8');
  if (source.split(oldText).length !== 2) throw new Error(`Mutant patch must match exactly once: ${file}: ${oldText}`);
  const changed = source.replace(oldText, newText);
  await writeFile(target, changed);
  applied.push({ file, oldText, newText, sourceSha256: createHash('sha256').update(source).digest('hex'), mutantSha256: createHash('sha256').update(changed).digest('hex') });
}
await writeFile(path.join(destination, 'patch-identity.json'), `${JSON.stringify({ mutant, commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), applied }, null, 2)}\n`);
await writeFile(path.join(destination, 'vite.config.mjs'), `import original from ${JSON.stringify(path.join(root, 'vite.config.ts'))};\nexport default { ...original, root: ${JSON.stringify(destination)}, cacheDir: ${JSON.stringify(path.join(destination, 'vite-cache'))}, build: { ...original.build, outDir: ${JSON.stringify(path.join(destination, 'dist'))}, emptyOutDir: true } };\n`);
console.log(JSON.stringify({ mutant, destination, config: path.join(destination, 'vite.config.mjs') }));
