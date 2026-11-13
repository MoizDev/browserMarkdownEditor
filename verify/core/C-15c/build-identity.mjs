import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const [rootArg, mode, outputArg, identityArg, baseArg, patchArg] = process.argv.slice(2);
assert.ok(rootArg && ['production', 'benchmark', 'development'].includes(mode) && outputArg && identityArg,
    'Use build-identity.mjs <source-root> <mode> <outDir|-> <identity-file> [base-root patch-file]');
const root = resolve(rootArg), base = resolve(baseArg || rootArg);
const git = (...args) => execFileSync('git', ['-C', base, ...args], { encoding: 'utf8' }).trim();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(git('status', '--porcelain'), '', 'identity must be created from a clean committed base');
const identity = {
    commit: git('rev-parse', 'HEAD'),
    tree: patchArg ? { patchSha256: sha256(await readFile(patchArg)), baseClean: true } : 'clean',
    root,
    baseRoot: base,
    mode,
    files: {},
};
async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name), key = prefix + entry.name;
        if (entry.isDirectory()) await walk(path, key + '/');
        else identity.files[key] = sha256(await readFile(path));
    }
}
if (mode === 'development') {
    assert.equal(base, root, 'dev must be the clean worktree, never a mutant copy');
    identity.sources = {};
    for (const file of git('ls-files', '-z', 'src').split('\0').filter(Boolean)) {
        identity.sources[file] = sha256(await readFile(join(root, file)));
    }
    identity.entrySourceSha256 = identity.sources['src/main.tsx'];
} else await walk(resolve(outputArg));
await mkdir(dirname(resolve(identityArg)), { recursive: true });
await writeFile(identityArg, JSON.stringify(identity, null, 2) + '\n');
console.log(JSON.stringify({ identity: resolve(identityArg), commit: identity.commit, tree: identity.tree, mode, files: Object.keys(identity.files).length }));
