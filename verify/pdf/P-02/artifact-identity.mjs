// Record build bytes only after checking its entire tracked product source tree
// against a real Git commit (or the one exact, named missing-wasm source patch).
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [distArg, sourceArg, commitArg, outputArg, mutant] = process.argv.slice(2);
if (!distArg || !sourceArg || !commitArg || !outputArg || (mutant !== undefined && mutant !== 'missing-wasm')) throw new Error('Usage: artifact-identity.mjs <dist> <source-root> <commit> <output.json> [missing-wasm]');
const dist = resolve(distArg), root = resolve(sourceArg), output = resolve(outputArg);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const git = args => execFileSync('git', args, { cwd: repo, maxBuffer: 256 * 1024 * 1024 });
const commit = git(['rev-parse', `${commitArg}^{commit}`]).toString().trim();
const sha = data => createHash('sha256').update(data).digest('hex');
const tree = git(['ls-tree', '-rz', commit]).toString().split('\0').filter(Boolean);
const sourceFiles = {};
let mutated = 0;
for (const entry of tree) {
    const [metadata, file] = entry.split('\t');
    if (!/^(src\/|shared\/|build\/|index\.html$|vite\.config\.ts$|package(?:-lock)?\.json$|tsconfig\.json$|THIRD_PARTY_NOTICES$)/.test(file)) continue;
    const expectedBlob = metadata.split(' ')[2];
    const bytes = await readFile(join(root, file));
    if (mutant === 'missing-wasm' && file === 'src/utils/pdfClassicOpen.ts') {
        const original = git(['show', `${commit}:${file}`]).toString();
        const needle = '        wasmUrl: assetUrl(classicAssets.directories.wasm),\n';
        if (original.split(needle).length !== 2 || !bytes.equals(Buffer.from(original.replace(needle, '')))) throw new Error('Named missing-wasm patch does not match the built source');
        mutated++;
    } else {
        const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (blob !== expectedBlob) throw new Error(`Built source differs from its claimed commit: ${file}`);
    }
    sourceFiles[file] = sha(bytes);
}
if (!Object.keys(sourceFiles).length || (mutant === 'missing-wasm' && mutated !== 1)) throw new Error('Source identity is incomplete');
const files = {};
async function walk(path, prefix = '') {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (entry.isSymbolicLink()) throw new Error('Build identity refuses symlinks');
        const file = `${prefix}${entry.name}`;
        if (entry.isDirectory()) await walk(join(path, entry.name), `${file}/`);
        else {
            const bytes = await readFile(join(path, entry.name));
            files[file] = { sha256: sha(bytes), bytes: bytes.length };
        }
    }
}
await walk(dist);
const html = await readFile(join(dist, 'index.html'), 'utf8');
const entryScript = html.match(/<script[^>]+src="([^"]+\.js)"/i)?.[1];
if (!entryScript || !files['index.html'] || !Object.keys(files).some(f => /pdf\.worker.*\.mjs$/.test(f)) || !Object.keys(files).some(f => f.endsWith('/wasm/openjpeg.wasm'))) throw new Error('Expected production entry/worker/runtime assets are missing');
const identity = { schema: 1, commit, mutant: mutant || null, entryScript, sourceFiles, files };
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output, commit, mutant: identity.mutant, sourceFiles: Object.keys(sourceFiles).length, emittedFiles: Object.keys(files).length }));
