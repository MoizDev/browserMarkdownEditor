// Source-only scratch candidates and logic mutants; run this whole command under bme-lock build.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const variant = process.argv[2] ?? 'candidate';
const seamRef = process.env.W12_SEAM_REF;
assert(!seamRef || variant === 'candidate', 'A real seam replay must not also overlay a mutant');
assert(['candidate', 'no-filter', 'forget-touches', 'up-only', 'eager-canvas', 'always-touch'].includes(variant), 'Unknown build variant');
const lane = process.cwd();
const root = process.env.W12_BUILD_ROOT ?? '/Users/adham/Developer/bme-impl/scratch/w-a/w12';
const name = process.env.W12_BUILD_NAME ?? variant;
assert(/^[a-z0-9-]+$/.test(name), 'Build name must be an owned simple directory name');
const output = path.resolve(root, name), source = path.join(output, 'source');
assert(!fs.existsSync(output), `Refusing to overwrite build evidence: ${output}`);
fs.mkdirSync(source, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const command = (program, args, cwd = source) => execFileSync(program, args, { cwd, stdio: 'inherit' });
const commit = execFileSync('git', ['rev-parse', seamRef ?? 'HEAD'], { cwd: lane, encoding: 'utf8' }).trim();
const archive = path.join(output, 'source.tar');
command('git', ['archive', '--output', archive, commit], lane);
command('tar', ['-xf', archive, '-C', source]);
const overlays = [];
for (const name of seamRef ? [] : ['src/utils/penPriority.ts', 'src/components/DrawingPane.tsx',
  'src/components/NotebookPane.tsx', 'src/components/PdfAnnotateCanvas.tsx']) {
  const bytes = fs.readFileSync(path.join(lane, name));
  fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
  fs.writeFileSync(path.join(source, name), bytes);
  overlays.push({ path: name, sha256: hash(bytes) });
}
const installPatch = path.join(lane, 'verify/whiteboard/w-a/W-12/install-main.patch');
if (!seamRef) {
  command('git', ['apply', '--check', installPatch]);
  command('git', ['apply', installPatch]);
} else {
  const main = fs.readFileSync(path.join(source, 'src/main.tsx'), 'utf8');
  const call = /^installPenPriority\(\)\s*;?\s*$/m.exec(main);
  assert(call && call.index < main.indexOf('ReactDOM.createRoot'), 'Actual seam has no startup install before render');
}
fs.copyFileSync(installPatch, path.join(output, 'install-main.patch'));

let mutation = null;
if (variant !== 'candidate') {
  const file = variant === 'no-filter' ? 'src/main.tsx' : 'src/utils/penPriority.ts';
  const filename = path.join(source, file), before = fs.readFileSync(filename, 'utf8');
  const find = variant === 'no-filter' ? 'installPenPriority()'
    : variant === 'forget-touches' ? '                pens.delete(event.pointerId);'
    : variant === 'eager-canvas' ? "// Today's canvas engine admits a pinch mid-pen and never finishes the stroke"
    : variant === 'always-touch' ? "    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const) {"
    : "} else if (event.type === 'pointerup' || event.type === 'pointercancel') {";
  const replace = variant === 'no-filter' ? '// Mutant: no startup filter.'
    : variant === 'forget-touches' ? '                stoppedPointers.clear();\n                stoppedTouches.clear();\n                pens.delete(event.pointerId);'
    : variant === 'eager-canvas' ? `import '../components/canvasPen';\n${find}`
    : variant === 'always-touch' ? `    for (const type of touchTypes) window.addEventListener(type, onTouch, touchOptions);\n\n${find}`
    : "} else if (event.type === 'pointerup') {";
  assert.equal(before.split(find).length - 1, 1, 'Mutant source patch no longer applies exactly once');
  const modified = path.join(output, 'modified-source');
  fs.writeFileSync(modified, before.replace(find, replace));
  const diff = spawnSync('git', ['diff', '--no-index', '--', filename, modified], { encoding: 'utf8' });
  assert.equal(diff.status, 1, 'Mutant must change its source file');
  const patch = diff.stdout.replace(/^diff --git .*$/m, `diff --git a/${file} b/${file}`)
    .replace(/^--- .*$/m, `--- a/${file}`).replace(/^\+\+\+ .*$/m, `+++ b/${file}`);
  const patchFile = path.join(output, 'mutant.patch'); fs.writeFileSync(patchFile, patch);
  command('git', ['apply', '--check', patchFile]); command('git', ['apply', patchFile]);
  mutation = { file, find, replace, count: 1, beforeSha256: hash(before),
    afterSha256: hash(fs.readFileSync(filename)), patchSha256: hash(patch) };
}
const config = path.join(output, 'vite.config.mjs');
fs.writeFileSync(config, `import original from ${JSON.stringify(path.join(source, 'vite.config.ts'))};\nexport default { ...original, root: ${JSON.stringify(source)}, cacheDir: ${JSON.stringify(path.join(output, 'vite-cache'))}, build: { ...original.build, outDir: ${JSON.stringify(path.join(output, 'dist'))}, emptyOutDir: true } };\n`);
command('npm', ['ci', '--no-audit', '--no-fund']);
command(path.join(source, 'node_modules/.bin/vite'), ['build', '--config', config, '--configLoader', 'runner']);
const metadata = { commit, ref: seamRef ?? 'impl/lane/w-a plus recorded owned overlays and main install seam',
  sourceMode: seamRef ? 'unmodified-seam-ref' : 'owned-overlays-with-startup-seam',
  mode: 'production', variant, overlays, installPatchApplied: !seamRef,
  installPatchSha256: hash(fs.readFileSync(installPatch)), mutation,
  filterSha256: hash(fs.readFileSync(path.join(source, 'src/utils/penPriority.ts'))),
  indexSha256: hash(fs.readFileSync(path.join(output, 'dist/index.html'))) };
fs.writeFileSync(path.join(output, 'build.json'), JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify({ output, config, metadata }, null, 2));
