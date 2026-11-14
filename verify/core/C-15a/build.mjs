import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';

// Build provenance, not a behavioural test. Run this whole process under the
// integrator's build grant, from the source worktree whose bytes are built.
const [mode, configArg, outArg, patchArg] = process.argv.slice(2);
assert(['production', 'benchmark'].includes(mode) && configArg && outArg,
    'Usage: node build.mjs production|benchmark CONFIG OUT_DIR [MUTANT_PATCH]');
const root = process.cwd();
const out = resolve(outArg);
assert(!out.startsWith(`${root}/`), 'Build outputs belong outside the worktree');
const config = resolve(configArg);
const identityPath = `${out}.identity.json`;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const commit = git('rev-parse', 'HEAD');
let tree = 'clean';
if (patchArg) {
    const patch = resolve(patchArg);
    assert.equal(git('status', '--porcelain').trim(), 'M src/App.tsx', 'A mutant may change only its named App hook');
    execFileSync('git', ['apply', '--reverse', '--check', patch], { cwd: root });
    tree = { patchSha256: hash(await readFile(patch)), diffSha256: hash(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root })) };
} else assert.equal(git('status', '--porcelain'), '', 'Clean builds require committed source');
const statusBefore = git('status', '--porcelain');
await rm(identityPath, { force: true });
const args = [resolve('node_modules/vite/bin/vite.js'), 'build', root, '--config', config, '--outDir', out];
if (mode === 'benchmark') args.push('--mode', 'benchmark');
const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, BME_OUT: out } });
if (result.error) throw result.error;
assert.equal(result.status, 0, 'Vite build failed; no identity emitted');
assert.equal(git('rev-parse', 'HEAD'), commit, 'Source commit changed during build');
assert.equal(git('status', '--porcelain'), statusBefore, 'Source tree changed during build');
const files = {};
async function inventory(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await inventory(path);
        else files[relative(out, path).split('\\').join('/')] = hash(await readFile(path));
    }
}
await inventory(out);
await writeFile(identityPath, JSON.stringify({ commit, tree, mode, root, configSha256: hash(await readFile(config)), files }, null, 2));
console.log(`BUILD-IDENTITY ${identityPath} commit=${commit} mode=${mode} files=${Object.keys(files).length}`);
