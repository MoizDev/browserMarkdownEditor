// Self-update, end to end, on the REAL service manager (launchd / systemd / Task
// Scheduler) — what the release workflow runs on each OS, and a local check:
//
//   CI=true bun helper/scripts/update-smoke.ts [--port 47890]
//   bun helper/scripts/update-smoke.ts --replace-installed [--port 47890]
//
// 1. Builds two helpers from source, 0.0.1 and 0.0.2, whose releases base is a
//    fake release server this script serves on 127.0.0.1:<port>.
// 2. Installs 0.0.1 for real (login registration included) and talks to it over
//    the panel's WebSocket, as the panel would.
// 3. A bad checksum, then a binary that does not start: each `helper.update` must
//    fail with the old helper still answering on the same socket and its binary
//    unchanged. Then the good release: the helper must come back as 0.0.2 under
//    its service manager, with no leftovers.
//    On macOS it also checks the PTY host (helper/ptyhost): installed and loaded
//    by the helper itself, and — after the update — still loaded and BYTE-IDENTICAL.
//    That is the invariant behind "terminal privacy grants survive a VaultAgent
//    update" (a grant is keyed to the host's cdhash), expressed as a check CI can run.
// 4. Uninstalls.
//
// It REPLACES whatever VaultAgent is installed for this user — hence the guard.
// Without a session the service manager can start the helper in (a CI runner with
// no GUI login), it warns and passes on macOS and Windows; on Linux it fails.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HELPER_PORTS, PRODUCTION_ORIGIN, RELEASE_MANIFEST, type HelperMessage } from '../../shared/vaultAgentProtocol.ts';
import { PTYHOST_LABEL, installLayout } from '../src/install/layout.ts';
import { findRunningHelper, helperPlatform } from '../src/server.ts';
import { updateAssetName, type Manifest } from '../src/update.ts';
import { buildManifest } from './release-manifest.ts';

const argv = process.argv.slice(2);
if (process.env.CI !== 'true' && !argv.includes('--replace-installed')) {
    console.error('update-smoke installs over the VaultAgent installed for this user. Run it in CI, or pass --replace-installed.');
    process.exit(2);
}
const releasePort = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : 47890;
const OLD = '0.0.1';
const NEW = '0.0.2';
const platform = helperPlatform();
const windows = platform === 'windows';
const asset = updateAssetName(platform, process.arch);
if (!asset) {
    console.error(`no self-update asset for ${platform}/${process.arch}`);
    process.exit(2);
}
const layout = installLayout(platform);
const helperDir = resolve(import.meta.dir, '..');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): boolean {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`);
    if (!ok) failures++;
    return ok;
}

async function sha(path: string): Promise<string> {
    const h = new Bun.CryptoHasher('sha256');
    h.update(await Bun.file(path).arrayBuffer());
    return h.digest('hex');
}

async function waitFor<T>(what: () => Promise<T | null>, ms: number): Promise<T | null> {
    for (const until = Date.now() + ms; Date.now() < until; await Bun.sleep(500)) {
        const v = await what();
        if (v) return v;
    }
    return null;
}

async function helperAt(version: string): Promise<{ port: number; version: string } | null> {
    const h = await findRunningHelper(HELPER_PORTS);
    return h && h.version === version ? h : null;
}

/** macOS: is the PTY host's LaunchAgent loaded in this user's GUI domain? */
const ptyHostLoaded = () => Bun.spawnSync(['/bin/launchctl', 'print', `gui/${process.getuid?.() ?? 0}/${PTYHOST_LABEL}`]).exitCode === 0;

function leftovers(): string[] {
    try {
        return readdirSync(layout.appDir).filter(n => /^vaultagent\.(update|previous)-/.test(n));
    } catch {
        return [];
    }
}

/** The panel's side of the socket: requests with reqIds, and every message seen. */
class Panel {
    private ws: WebSocket;
    private seq = 0;
    private waiting = new Map<string, (m: Extract<HelperMessage, { type: 'response' }>) => void>();
    readonly seen: HelperMessage[] = [];
    closed = false;

    private constructor(ws: WebSocket) {
        this.ws = ws;
        ws.onmessage = e => {
            const m = JSON.parse(String(e.data)) as HelperMessage;
            this.seen.push(m);
            if (m.type === 'response') this.waiting.get(m.reqId)?.(m);
        };
        ws.onclose = () => {
            this.closed = true;
        };
    }

    static open(port: number): Promise<Panel> {
        return new Promise((res, rej) => {
            // Bun's WebSocket takes headers: the helper only upgrades for an allowed Origin.
            const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: PRODUCTION_ORIGIN } } as unknown as string[]);
            ws.onopen = () => res(new Panel(ws));
            ws.onerror = () => rej(new Error('ws error'));
        });
    }

    request(type: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<Extract<HelperMessage, { type: 'response' }>> {
        const reqId = `r${++this.seq}`;
        return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(`${type}: no response`)), timeoutMs);
            this.waiting.set(reqId, m => {
                clearTimeout(t);
                res(m);
            });
            this.ws.send(JSON.stringify({ type, reqId, ...params }));
        });
    }

    close(): void {
        this.ws.close();
    }
}

const scratch = mkdtempSync(join(tmpdir(), 'vaultagent-update-smoke-'));
const releaseDir = join(scratch, 'release');
const releasesBase = `http://127.0.0.1:${releasePort}/releases`;
type Mode = 'good' | 'bad-sha' | 'broken';
let mode = 'good' as Mode;
const manifests = {} as Record<Mode, Manifest>;
let releaseServer = null as ReturnType<typeof Bun.serve> | null;
let installed = false;

function build(version: string): string {
    const out = join(scratch, `vaultagent-${version}${windows ? '.exe' : ''}`);
    const p = Bun.spawnSync([process.execPath, join(helperDir, 'scripts', 'build.ts'), '--version', version, '--releases-base', releasesBase, '--outfile', out],
        { stdout: 'inherit', stderr: 'inherit' });
    if (p.exitCode !== 0) throw new Error(`build ${version} failed`);
    return out;
}

async function main(): Promise<void> {
    const oldBin = build(OLD);
    const newBin = build(NEW);

    // The fake release: the good asset, and one that is not a working program.
    const goodDir = join(releaseDir, 'good');
    const brokenDir = join(releaseDir, 'broken');
    mkdirSync(goodDir, { recursive: true });
    mkdirSync(brokenDir, { recursive: true });
    await Bun.write(join(goodDir, asset!), Bun.file(newBin));
    writeFileSync(join(brokenDir, asset!), windows ? 'not a program\r\n' : '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    manifests.good = await buildManifest(NEW, goodDir, [asset!]);
    manifests.broken = await buildManifest(NEW, brokenDir, [asset!]);
    manifests['bad-sha'] = { ...manifests.good, assets: { [asset!]: { ...manifests.good.assets[asset!], sha256: '0'.repeat(64) } } };
    releaseServer = Bun.serve({
        hostname: '127.0.0.1',
        port: releasePort,
        fetch(req) {
            const path = new URL(req.url).pathname;
            if (path === `/releases/latest/download/${RELEASE_MANIFEST}`) return Response.json(manifests[mode]);
            if (path === `/releases/download/vaultagent-v${NEW}/${asset}`) return new Response(Bun.file(join(mode === 'broken' ? brokenDir : goodDir, asset!)));
            return new Response('not found', { status: 404 });
        },
    });

    const inst = Bun.spawnSync([oldBin, 'install'], { stdout: 'inherit', stderr: 'inherit' });
    installed = true;
    // The same no-session policy as below: there, registering (launchctl bootstrap into
    // gui/<uid>, the logon task) is itself what fails.
    if (inst.exitCode !== 0 && platform !== 'linux') {
        console.log(`::warning::install could not register the helper on this runner (no ${windows ? 'interactive' : 'GUI'} session?) — self-update not exercised`);
        return;
    }
    if (!check(`install ${OLD} exits 0`, inst.exitCode === 0, String(inst.exitCode))) return;
    const up = await waitFor(() => helperAt(OLD), 20_000);
    if (!up) {
        if (platform !== 'linux') {
            console.log(`::warning::the installed helper never answered /health on this runner (no ${windows ? 'interactive' : 'GUI'} session?) — self-update not exercised`);
            return;
        }
        check(`installed ${OLD} answers /health`, false);
        return;
    }
    check(`installed ${OLD} answers /health`, true);
    const installedSha = await sha(layout.binary);
    // The helper installs and loads the PTY host at its start, so allow it a moment after /health.
    const pinnedHost = platform === 'macos' ? (JSON.parse(await Bun.file(join(helperDir, 'ptyhost', 'PINNED.json')).text()) as { sha256: string }).sha256 : '';
    let hostBefore = '';
    if (platform === 'macos') {
        const hostUp = await waitFor(async () => (existsSync(layout.ptyHostBinary!) && ptyHostLoaded() ? true : null), 20_000);
        check('macOS: vaultagent-pty is installed and loaded', !!hostUp);
        hostBefore = existsSync(layout.ptyHostBinary!) ? await sha(layout.ptyHostBinary!) : '';
        check('macOS: the installed vaultagent-pty is the pinned binary', hostBefore === pinnedHost, hostBefore);
    }
    const panel = await Panel.open(up.port);
    check('hello', (await panel.request('hello', { protocol: 1 })).ok);

    const before = await panel.request('helper.checkUpdate', { force: true });
    const check1 = before.ok ? before.result as { available: boolean; latest: string; installed: boolean } : null;
    check(`checkUpdate offers ${NEW}`, !!check1 && check1.available && check1.latest === NEW && check1.installed, JSON.stringify(before));

    for (const [m, expect] of [['bad-sha', /checksum/], ['broken', /didn't start/]] as const) {
        mode = m;
        const r = await panel.request('helper.update');
        check(`${m}: update fails`, !r.ok && expect.test(r.error.message), JSON.stringify(r));
        check(`${m}: same socket still answers`, !panel.closed && (await panel.request('hello', { protocol: 1 })).ok);
        check(`${m}: /health still ${OLD}`, !!(await helperAt(OLD)));
        check(`${m}: installed binary unchanged`, (await sha(layout.binary)) === installedSha);
        check(`${m}: no leftovers`, leftovers().length === 0, leftovers().join(', '));
    }

    mode = 'good';
    panel.seen.length = 0;
    const r = await panel.request('helper.update');
    check('good: update responds {from, to}', r.ok && JSON.stringify(r.result) === JSON.stringify({ from: OLD, to: NEW }), JSON.stringify(r));
    const phases = new Set(panel.seen.flatMap(m => (m.type === 'update.progress' ? [m.phase] : [])));
    check('good: progress streamed', ['checking', 'downloading', 'verifying', 'installing'].every(p => phases.has(p as never)), [...phases].join(','));
    check('good: the old helper goes', !!(await waitFor(async () => panel.closed || null, 10_000)));
    const back = await waitFor(() => helperAt(NEW), 60_000);
    check(`good: comes back as ${NEW} under its service manager`, !!back);
    check('good: installed binary is the new one', (await sha(layout.binary)) === manifests.good.assets[asset!].sha256);
    if (platform === 'macos') {
        const hostUp = await waitFor(async () => (existsSync(layout.ptyHostBinary!) && ptyHostLoaded() ? true : null), 20_000);
        check('good: vaultagent-pty is still installed and loaded', !!hostUp);
        check('good: vaultagent-pty is byte-identical (privacy grants survive the update)', existsSync(layout.ptyHostBinary!) && (await sha(layout.ptyHostBinary!)) === hostBefore);
    }
    check('good: no leftovers', !!(await waitFor(async () => leftovers().length === 0 || null, 10_000)), leftovers().join(', '));
    if (back) {
        const again = await Panel.open(back.port);
        const c = await again.request('helper.checkUpdate', { force: true });
        check('good: now up to date', c.ok && (c.result as { available: boolean }).available === false, JSON.stringify(c));
        again.close();
    }
}

try {
    await main();
} catch (e) {
    check('update smoke', false, String(e));
} finally {
    if (installed && existsSync(layout.binary)) {
        // Uninstall with a copy: on Windows the installed .exe cannot delete its own folder while it runs.
        const copy = join(scratch, `uninstaller${windows ? '.exe' : ''}`);
        copyFileSync(layout.binary, copy);
        const u = Bun.spawnSync([copy, 'uninstall'], { stdout: 'inherit', stderr: 'inherit' });
        check('uninstall exits 0', u.exitCode === 0, String(u.exitCode));
        check('uninstall stops the helper', !!(await waitFor(async () => ((await findRunningHelper(HELPER_PORTS)) ? null : true), 20_000)));
        check('uninstall removes the binary', !!(await waitFor(async () => !existsSync(layout.binary) || null, 20_000)));
        if (platform === 'macos') {
            check('uninstall removes the PTY host and unloads it', !!(await waitFor(async () => (!existsSync(layout.ptyHostRegistration!) && !ptyHostLoaded() ? true : null), 20_000)));
        }
    }
    releaseServer?.stop(true);
    rmSync(scratch, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
