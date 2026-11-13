// A source mutant, never a production flag or an injected browser timer.
// Invoke through bme-lock build; copies tracked sources and installs its OWN deps.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { scratch, lockState } from '../lib/bench/lock.mjs';
const exec = promisify(execFile);
const [controlPath] = process.argv.slice(2);
if (!controlPath) throw new Error('Usage: bme-lock build -- node verify/bench/build-delay.mjs <same-build-control-report.json>');
const state = await lockState();
if (!state.holders.some(h => h.cls === 'build' && h.pid === process.ppid)) throw new Error('A direct bme-lock build parent is required');
const control = JSON.parse(await readFile(resolve(controlPath), 'utf8'));
if (control.identities.A.sha256 !== control.identities.B.sha256 || !(control.result?.medians.A > 0)) throw new Error('A same-build control recording is required');
const delayMs = control.result.medians.A * 0.10;
const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const parent = join(scratch, 'v-c/mutants'); await mkdir(parent, { recursive: true });
const folder = await mkdtemp(join(parent, 'open-delay-'));
const source = join(folder, 'source'); await mkdir(source);
const archive = join(folder, 'source.tar');
const { stdout: commit } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
await exec('git', ['archive', '--format=tar', 'HEAD', '-o', archive], { cwd: root });
await exec('/usr/bin/tar', ['-xf', archive, '-C', source]);
const path = join(source, 'src/context/FileSystemContext.tsx');
const original = await readFile(path, 'utf8');
const anchor = "            const handle = await window.showDirectoryPicker({ mode: 'readwrite' });";
if (original.split(anchor).length !== 2) throw new Error('VER-13: open-path mutant anchor no longer matches exactly once');
const patch = `            // Scratch mutant only: a measured 10% delay on the actual open path.\n`
    + `            performance.mark('bme-mutant-delay-start');\n`
    + `            { const until = performance.now() + ${JSON.stringify(delayMs)}; while (performance.now() < until) { /* busy wait */ } }\n`
    + `            performance.mark('bme-mutant-delay-end');\n`
    + `            performance.measure('bme-mutant-delay', 'bme-mutant-delay-start', 'bme-mutant-delay-end');\n`;
const modified = original.replace(anchor, patch + anchor);
await writeFile(path, modified);
const dist = join(folder, 'dist');
const config = join(folder, 'vite.config.mjs');
await writeFile(config, `import original from ${JSON.stringify(join(source, 'vite.config.ts'))};\nexport default { ...original, root: ${JSON.stringify(source)}, cacheDir: ${JSON.stringify(join(folder, 'vite-cache'))}, build: { ...original.build, outDir: ${JSON.stringify(dist)}, emptyOutDir: true } };\n`);
// execFile's buffered output is retained beside the mutant, including a failed build.
for (const [name, executable, args] of [
    ['install', 'npm', ['ci', '--no-audit', '--no-fund']],
    ['build', join(source, 'node_modules/.bin/vite'), ['build', '--config', config]],
]) {
    try {
        const result = await exec(executable, args, { cwd: source, maxBuffer: 16 * 1024 ** 2 });
        await writeFile(join(folder, `${name}.log`), result.stdout + result.stderr);
    } catch (error) {
        await writeFile(join(folder, `${name}.log`), (error.stdout ?? '') + (error.stderr ?? '')); throw error;
    }
}
const sha = text => createHash('sha256').update(text).digest('hex');
const metadata = { kind: 'measured-open-path-delay', sourceCommit: commit.trim(),
    controlReport: resolve(controlPath), controlBuild: control.identities.A.sha256, controlMode: control.mode,
    delayMs, intendedFraction: 0.10, anchor, patch, originalSourceSha256: sha(original), mutantSourceSha256: sha(modified) };
await writeFile(join(dist, 'bench-mutant.json'), JSON.stringify(metadata, null, 2));
console.log(JSON.stringify({ dist, metadata }, null, 2));
