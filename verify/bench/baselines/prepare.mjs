// Build preparation only: no browser and no baseline numbers. Invoke with bme-lock build.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildIdentity } from '../../lib/identity.mjs';
import { lockState, scratch } from '../../lib/bench/lock.mjs';
import { invocations, SEED } from '../../fixtures/catalog.mjs';
const exec = promisify(execFile);
const [referenceArg = '/Users/adham/Developer/bme-impl/wt/v-c-reference', reuseArg] = process.argv.slice(2);
const reuse = reuseArg ? JSON.parse(await readFile(resolve(reuseArg), 'utf8')) : null;
const reference = resolve(referenceArg);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const state = await lockState();
if (!state.holders.some(h => h.cls === 'build' && h.pid === process.ppid)) throw new Error('Direct bme-lock build parent required');
const git = async (...args) => (await exec('git', args, { cwd: reference })).stdout.trim();
const commit = await git('rev-parse', 'HEAD');
if (reuse ? commit !== reuse.referenceCommit : commit !== await git('rev-parse', 'impl/reference')) throw new Error('Reference checkout differs from the selected frozen reference; update its detached HEAD first');
if (await git('status', '--porcelain', '--untracked-files=no')) throw new Error('Read-only reference checkout is dirty');
await exec('git', ['merge-base', '--is-ancestor', 'b10d0d3', commit], { cwd: reference });
const parent = join(scratch, 'v-c/baselines/prepared'); await mkdir(parent, { recursive: true });
const out = await mkdtemp(join(parent, `${commit.slice(0, 12)}-`));
const metadata = { schema: 1, status: 'prepared-only', reference, referenceCommit: commit,
    mainBase: 'b10d0d3', preparedAt: new Date().toISOString(), builds: reuse?.builds ?? {}, fixtures: [...(reuse?.fixtures ?? [])],
    parentPrepared: reuseArg ? resolve(reuseArg) : null,
    sourceCapabilities: {}, measurements: 'NONE. Charter0 defers baseline recording to the post-K7 review phase; implementation smoke readings are UNQUALIFIED, never baselines.' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
for (const mode of reuse ? [] : ['production', 'benchmark']) {
    const dist = join(out, mode);
    const configPath = join(out, `${mode}.vite.config.mjs`);
    await writeFile(configPath, `import original from ${JSON.stringify(join(reference, 'vite.config.ts'))};\nexport default { ...original, root: ${JSON.stringify(reference)}, cacheDir: ${JSON.stringify(join(out, `${mode}-cache`))}, build: { ...original.build, outDir: ${JSON.stringify(dist)}, emptyOutDir: true } };\n`);
    const args = ['build', '--config', configPath, '--mode', mode];
    try {
        const result = await exec(join(reference, 'node_modules/.bin/vite'), args, { cwd: reference, maxBuffer: 16 * 1024 ** 2 });
        await writeFile(join(out, `${mode}.build.log`), result.stdout + result.stderr);
    } catch (error) {
        await writeFile(join(out, `${mode}.build.log`), (error.stdout ?? '') + (error.stderr ?? '')); throw error;
    }
    const sourceIdentity = await buildIdentity({ worktree: reference, distDir: dist });
    const identity = { ...sourceIdentity, dist, sha256: sourceIdentity.manifestSha256 };
    const plants = [];
    for (const file of identity.files.filter(f => f.path.endsWith('.js'))) {
        if ((await readFile(join(dist, file.path), 'utf8')).includes('bme-perf-hooks-plant-7f3a')) plants.push(file.path);
    }
    if (mode === 'production' && plants.length) throw new Error(`Production contains C9 hook plant: ${plants.join(', ')}`);
    metadata.builds[mode] = { ...identity, mode, sourceCommit: commit, configSha256: sha(await readFile(configPath)), plantChunks: plants };
}
// This is source availability, not a claim that a runtime path mounted or that a hook works.
for (const [name, path, text] of [
    ['vault', 'src/App.tsx', 'reportVault'], ['editor', 'src/editor/editorPerf.ts', 'perfRoot'],
    ['tree', 'src/components/FileExplorer.tsx', 'perfRoot'], ['graph', 'src/utils/graph.ts', 'perfRoot'],
]) {
    try { metadata.sourceCapabilities[name] = (await readFile(join(reference, path), 'utf8')).includes(text); }
    catch (error) { if (error.code !== 'ENOENT') throw error; metadata.sourceCapabilities[name] = false; }
}
for (const key of ['core/notes', 'core/vault-1000', 'platform/geometry', 'core/save-path', 'core/startup-v08']) {
    const invocation = invocations.find(x => x.key === key);
    if (!invocation) throw new Error(`Fixture invocation not registered: ${key}`);
    if (metadata.fixtures.some(f => f.generator === invocation.generator)) continue;
    const fixtureRoot = join(reuseArg ? dirname(resolve(reuseArg)) : out, 'fixtures');
    const fixtureOut = join(out, 'fixtures', key);
    const { stdout } = await exec(process.execPath, [join(root, invocation.generator), '--out', fixtureOut,
        '--seed', String(SEED), ...invocation.args.map(arg => arg.replace('$ROOT', fixtureRoot))], { cwd: root, maxBuffer: 16 * 1024 ** 2 });
    const manifest = JSON.parse(await readFile(join(root, `verify/fixtures/${invocation.stream}/manifest.json`), 'utf8'));
    for (const record of stdout.trim().split('\n').map(line => JSON.parse(line))) {
        const bytes = await readFile(join(fixtureOut, record.file));
        const expected = manifest.fixtures.find(x => x.generator === invocation.generator && x.file === record.file
            && x.seed === SEED && JSON.stringify(x.args) === JSON.stringify(invocation.args));
        if (!expected || record.sha256 !== sha(bytes) || record.bytes !== bytes.length
            || expected.sha256 !== record.sha256 || expected.bytes !== record.bytes) throw new Error(`VER-06 fixture identity mismatch: ${key}/${record.file}`);
        metadata.fixtures.push({ ...expected, path: join(fixtureOut, record.file) });
    }
}
if (await git('status', '--porcelain', '--untracked-files=no') || commit !== await git('rev-parse', 'HEAD')) {
    throw new Error('Read-only reference checkout changed during preparation; artifacts unproven');
}
metadata.referenceLog = await git('log', '--format=%H %s', 'b10d0d3..HEAD');
const path = join(out, 'prepared.json'); await writeFile(path, JSON.stringify(metadata, null, 4) + '\n');
console.log(path);
