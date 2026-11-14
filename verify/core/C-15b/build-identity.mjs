import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const option = key => args[args.indexOf(key) + 1];
const root = path.resolve(option('--root'));
const outDir = path.resolve(option('--out-dir'));
const mode = option('--mode');
const patch = args.includes('--patch') ? option('--patch') : null;
const baseRoot = args.includes('--base-root') ? path.resolve(option('--base-root')) : root;
const git = (...args) => execFileSync('git', ['-C', baseRoot, ...args], { encoding: 'utf8' }).trim();
assert.ok(['production', 'benchmark'].includes(mode), 'identity requires the actual build mode');
assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'base source must be clean before recording build identity');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = {
    commit: git('rev-parse', 'HEAD'),
    tree: patch ? { patchSha256: sha256(await readFile(patch)) } : 'clean',
    root,
    mode,
    files: {},
};
async function inventory(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await inventory(file);
        else identity.files[path.relative(outDir, file).split(path.sep).join('/')] = sha256(await readFile(file));
    }
}
await inventory(outDir);
assert.ok(identity.files['index.html'], 'build has no entry HTML');
const destination = `${outDir}.identity.json`;
await writeFile(destination, JSON.stringify(identity, null, 2) + '\n');
console.log(JSON.stringify({ identity: destination, commit: identity.commit, mode, tree: identity.tree, files: Object.keys(identity.files).length }));
