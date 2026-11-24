// Build input for the browser gate, never a module test or an app fault hook.
// Run under the build lock, then npm ci + vite build in the emitted directory.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const [target, sourceCommit = 'HEAD'] = process.argv.slice(2);
if (!target) throw new Error('Usage: make-mutant.mjs <fresh-scratch-directory> [commit]');
const out = resolve(target);
await mkdir(out); // Existing output is an error, never an overwrite.
const commit = execFileSync('git', ['rev-parse', sourceCommit], { encoding: 'utf8' }).trim();
const archive = execFileSync('git', ['archive', '--format=tar', commit], { maxBuffer: 256 * 1024 * 1024 });
execFileSync('tar', ['-xf', '-', '-C', out], { input: archive });
const file = 'src/utils/pdfClassicOpen.ts';
const original = await readFile(join(out, file), 'utf8');
const needle = '        wasmUrl: assetUrl(classicAssets.directories.wasm),\n';
if (original.split(needle).length !== 2) throw new Error('Missing-wasm mutant patch must match exactly once; gate is unproven');
const modified = original.replace(needle, '');
await writeFile(join(out, file), modified);
const sha = data => createHash('sha256').update(data).digest('hex');
const identity = { kind: 'P-02a missing-wasmUrl mutant', commit, file, beforeSha256: sha(original), afterSha256: sha(modified), removed: needle };
await writeFile(join(out, 'p02a-mutant.json'), `${JSON.stringify(identity, null, 2)}\n`);
await writeFile(join(out, 'mutant.vite.config.mjs'), `import original from ${JSON.stringify(join(out, 'vite.config.ts'))};\nimport { pdfClassicAssets } from ${JSON.stringify(join(out, 'build/pdfClassicAssets.ts'))};\nexport default { ...original, plugins: [...original.plugins, pdfClassicAssets()], root: ${JSON.stringify(out)}, cacheDir: ${JSON.stringify(join(out, '.vite-cache'))}, build: { ...original.build, outDir: ${JSON.stringify(join(out, 'dist'))}, emptyOutDir: true } };\n`);
console.log(JSON.stringify(identity));
