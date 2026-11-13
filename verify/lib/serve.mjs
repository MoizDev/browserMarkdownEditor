import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIdentity } from './identity.mjs';

const lock = '/Users/adham/Developer/bme-impl/scratch/bin/bme-lock';
const howto = '/Users/adham/Developer/bme-impl/scratch/HOWTO.md';
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const children = new Set();
let signalsInstalled = false;

async function preparationGrants() {
    await access(howto);
    const state = JSON.parse(await readFile(join(process.env.BME_LOCK_DIR ?? '/Users/adham/Developer/bme-impl/scratch/locks', 'state.json'), 'utf8'));
    const ancestors = new Set();
    let pid = process.pid;
    for (let depth = 0; pid > 0 && depth < 64; depth++) {
        ancestors.add(pid);
        const parent = Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
        if (!parent || parent === pid) break;
        pid = parent;
    }
    const grants = new Set(state.holders.filter(holder => ancestors.has(holder.pid)).map(holder => holder.cls));
    // With a 6-unit VM, four runs waiting for nested builds can fill the whole
    // pool forever. Preparation and browser execution must be separate phases.
    if (grants.has('run') || grants.has('bench')) throw new Error('Refusing to build or prepare under a run/bench grant; use --prepare under build first, then serveApp({build:false}) under run');
    return grants;
}

function start(args, cwd, alreadyGranted = false) {
    const command = alreadyGranted ? args.slice(args.indexOf('--') + 1) : [lock, ...args];
    const child = spawn(command[0], command.slice(1), { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const capture = bytes => { output = (output + bytes.toString()).slice(-50000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const ended = new Promise(resolve => {
        child.once('error', error => resolve({ code: null, error }));
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const stop = async () => {
        if (!children.has(stop)) return;
        if (child.pid && child.exitCode === null && child.signalCode === null) {
            try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
            let timer;
            await Promise.race([ended, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
            clearTimeout(timer);
            if (child.exitCode === null && child.signalCode === null) {
                try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
                await ended;
            }
        }
        children.delete(stop);
    };
    children.add(stop);
    if (!signalsInstalled) {
        signalsInstalled = true;
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, async () => {
            await Promise.allSettled([...children].map(stop => stop()));
            process.exit(128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal]);
        });
        process.on('exit', () => { for (const stop of children) stop.killSync?.(); });
    }
    stop.killSync = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ } } };
    return { child, ended, stop, output: () => output };
}

async function command(args, cwd) {
    const grants = args[0] === 'build' ? await preparationGrants() : new Set();
    const task = start(args, cwd, grants.has(args[0]));
    try {
        const result = await task.ended;
        if (result.code !== 0) throw new Error(`Command failed (${result.code}): ${args.join(' ')}\n${task.output()}`, { cause: result.error });
    } finally { await task.stop(); }
}

async function hashTree(root) {
    const hash = createHash('sha256');
    const visit = async (dir, prefix = '') => {
        for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = join(dir, entry.name), relative = `${prefix}${entry.name}`;
            if (entry.isDirectory()) await visit(path, `${relative}/`);
            else { hash.update(relative); hash.update('\0'); hash.update(await readFile(path)); hash.update('\0'); }
        }
    };
    await visit(root);
    return hash.digest('hex');
}

/** Preparation only: run under build, never run/bench (HOWTO §1, verification.md §2).
 * Reuses an ancestor build grant rather than nesting another one.
 * @param {{root?: string, scratch: string, mode?: 'dev'|'production'|'benchmark'}} options
 */
export async function prepareApp({ root = sourceRoot, scratch, mode = 'production' }) {
    await preparationGrants();
    if (!scratch || !['dev', 'production', 'benchmark'].includes(mode)) throw new Error('Preparation needs scratch and a known build mode');
    root = resolve(root); scratch = resolve(scratch);
    if (scratch === root || scratch.startsWith(`${root}/`)) throw new Error('Vite scratch must be outside the source root');
    await mkdir(scratch, { recursive: true });
    const config = join(scratch, 'vite.config.mjs'), dist = join(scratch, 'dist');
    await writeFile(config, `import original from ${JSON.stringify(join(root, 'vite.config.ts'))};\nexport default {...original,root:${JSON.stringify(root)},cacheDir:${JSON.stringify(join(scratch, 'vite-cache'))},optimizeDeps:{...original.optimizeDeps,exclude:[...(original.optimizeDeps?.exclude||[]),'@tldraw/assets/imports.vite']},build:{...original.build,outDir:${JSON.stringify(dist)},emptyOutDir:true}};\n`);
    let mutant;
    try { mutant = JSON.parse(await readFile(join(root, '.bme-mutant.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const repository = mutant?.sourceRoot ?? root;
    if (mode !== 'dev') await command(['build', '--', process.execPath, join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', config, '--mode', mode], root);
    const artifact = await buildIdentity({ worktree: repository, distDir: mode === 'dev' ? undefined : dist, patch: mutant });
    const identity = { ...artifact, mode, root, gitCommit: artifact.commit,
        sourceDiffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: repository })).digest('hex'),
        configSha256: createHash('sha256').update(await readFile(config)).digest('hex'), ...(mutant ? { mutant } : {}),
        contentSha256: mode === 'dev' ? await hashTree(join(root, 'src')) : artifact.manifestSha256 };
    const prepared = { root, scratch, mode, config, distDir: mode === 'dev' ? undefined : dist, identity, preparedAt: new Date().toISOString() };
    await writeFile(join(scratch, 'prepared.json'), `${JSON.stringify(prepared, null, 2)}\n`);
    return prepared;
}

/** Serve the prepared real app; build:true is refused under run/bench.
 * @param {{root?: string, scratch: string, port: number,
 *   mode?: 'dev'|'production'|'benchmark', build?: boolean}} options
 */
export async function serveApp({ root = sourceRoot, scratch, port, mode = 'production', build = true }) {
    await access(howto);
    if (!scratch || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('serveApp needs scratch and an assigned port');
    root = resolve(root); scratch = resolve(scratch);
    const prepared = build ? await prepareApp({ root, scratch, mode }) : JSON.parse(await readFile(join(scratch, 'prepared.json'), 'utf8'));
    if (prepared.root !== root || prepared.scratch !== scratch || prepared.mode !== mode) throw new Error('Prepared app identity/root/mode does not match the requested run; prepare it first');
    if (prepared.identity.configSha256 !== createHash('sha256').update(await readFile(prepared.config)).digest('hex')) throw new Error('Prepared Vite config changed after identity capture');
    const probe = createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
    await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    const args = ['serve', '--', process.execPath, join(root, 'node_modules/vite/bin/vite.js'), ...(mode === 'dev' ? [] : ['preview']), '--config', prepared.config, '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
    const server = start(args, root), url = `http://127.0.0.1:${port}/`;
    try {
        let exited = false;
        server.ended.then(() => { exited = true; });
        const deadline = Date.now() + 180000;
        while (Date.now() < deadline) {
            if (exited) throw new Error(`Vite exited before ready:\n${server.output()}`);
            if (server.output().includes(url)) {
                const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
                if (response.ok) return { url, distDir: prepared.distDir, identity: prepared.identity, stop: server.stop };
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`Vite readiness timed out:\n${server.output()}`);
    } catch (error) { await server.stop(); throw error; }
}

/** V-01a's anchored mutant; only scratch changes (verification.md VER-13).
 * @param {{root?: string, scratch: string}} options
 * @returns {Promise<string>} Scratch source root, with its exact patch manifest.
 */
export async function withSaveSkipped({ root = sourceRoot, scratch }) {
    await preparationGrants();
    root = await realpath(root);
    const target = join(scratch, `save-skipped-${Date.now()}`);
    await mkdir(target, { recursive: true });
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const file of files) {
        await mkdir(dirname(join(target, file)), { recursive: true });
        const source = join(root, file), destination = join(target, file);
        if ((await lstat(source)).isSymbolicLink()) await symlink(await readlink(source), destination);
        else await copyFile(source, destination);
    }
    const ownModules = await realpath(join(root, 'node_modules'));
    if (ownModules !== join(root, 'node_modules')) throw new Error('Mutant dependencies must be this worktree’s own install, not a shared symlink');
    // APFS clone: 3.4 s measured by the integrator, no shared mutable install.
    await command(['build', '--', '/bin/cp', '-c', '-R', ownModules, join(target, 'node_modules')], root);
    if (await realpath(join(target, 'node_modules')) === ownModules) throw new Error('Mutant dependencies must be an isolated clone');
    const path = join(target, 'src/App.tsx');
    const before = 'const result = await writeFileVersionedRef.current(handle, data, expected);';
    const after = "const result = { status: 'written' as const, version: expected! };";
    const original = await readFile(path, 'utf8');
    if (original.split(before).length !== 2) throw new Error('Save-skipped mutant anchor changed or is ambiguous (VER-13)');
    await writeFile(path, original.replace(before, after));
    await writeFile(join(target, '.bme-mutant.json'), JSON.stringify({ name: 'save-skipped', sourceRoot: root, file: 'src/App.tsx', before, after,
        originalSha256: createHash('sha256').update(original).digest('hex') }));
    return target;
}
