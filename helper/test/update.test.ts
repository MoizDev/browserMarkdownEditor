// Self-update's parts, against temp folders and in-process fakes — never the real
// install (helper/scripts/update-smoke.ts does that, on the real service manager).

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLayout } from '../src/install/layout.ts';
import {
    UPDATE_ASSET_NAMES, UpdateFailed, UpdateRefused, assetUrl, cleanupLeftovers, createUpdater, downloadVerified, manifestUrl,
    parseManifest, swapInto, updateAssetName, type UpdateProgress, type UpdaterDeps,
} from '../src/update.ts';

const sha256 = (data: string | Uint8Array) => new Bun.CryptoHasher('sha256').update(data).digest('hex');
const posix = process.platform !== 'win32';

let scratch: string;
beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'vaultagent-update-test-'));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('updateAssetName', () => {
    test('one asset per OS/arch, all of them published', () => {
        expect(updateAssetName('macos', 'arm64')).toBe('vaultagent-macos-arm64');
        expect(updateAssetName('macos', 'x64')).toBe('vaultagent-macos-x64');
        expect(updateAssetName('windows', 'x64')).toBe('vaultagent-windows-x64.exe');
        expect(updateAssetName('windows', 'arm64')).toBe('vaultagent-windows-x64.exe'); // emulated, as the installer
        expect(updateAssetName('linux', 'x64')).toBe('vaultagent-linux-x64');
        expect(updateAssetName('linux', 'arm64')).toBe('vaultagent-linux-arm64');
        expect(updateAssetName('linux', 'ia32')).toBeNull();
        expect(updateAssetName('macos', 'ppc')).toBeNull();
        const named = (['macos', 'windows', 'linux'] as const).flatMap(p => ['x64', 'arm64'].map(a => updateAssetName(p, a)));
        expect(new Set(named)).toEqual(new Set(UPDATE_ASSET_NAMES));
    });

    test('urls: the manifest from latest, the asset from its own version', () => {
        expect(manifestUrl('https://x/releases')).toBe('https://x/releases/latest/download/vaultagent-release.json');
        expect(assetUrl('https://x/releases', '1.2.3', 'vaultagent-linux-x64')).toBe('https://x/releases/download/vaultagent-v1.2.3/vaultagent-linux-x64');
    });
});

describe('parseManifest', () => {
    const good = { app: 'vaultagent', version: '1.2.3', assets: { 'vaultagent-linux-x64': { sha256: 'a'.repeat(64), size: 10 } } };
    test('accepts a valid one', () => {
        expect(parseManifest(good)).toEqual(good as never);
        expect(parseManifest({ ...good, version: '1.2.3-rc.1' }).version).toBe('1.2.3-rc.1');
    });
    test.each([
        ['another app', { ...good, app: 'other' }],
        ['a bad version', { ...good, version: '1.2.3/../../x' }],
        ['no assets', { ...good, assets: {} }],
        ['assets not an object', { ...good, assets: [] }],
        ['a bad checksum', { ...good, assets: { a: { sha256: 'xyz', size: 10 } } }],
        ['an oversize asset', { ...good, assets: { a: { sha256: 'a'.repeat(64), size: 301 * 1024 * 1024 } } }],
        ['a fractional size', { ...good, assets: { a: { sha256: 'a'.repeat(64), size: 1.5 } } }],
        ['not an object', 'nope'],
    ])('rejects %s', (_why, raw) => {
        expect(() => parseManifest(raw)).toThrow(UpdateFailed);
    });
});

describe('downloadVerified', () => {
    const body = new TextEncoder().encode('the new helper '.repeat(5000));
    let server: ReturnType<typeof Bun.serve>;
    let base: string;
    beforeAll(() => {
        server = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch(req) {
                const path = new URL(req.url).pathname;
                if (path === '/ok') return new Response(body);
                // No Content-Length up front: only the running count can catch it.
                if (path === '/long') {
                    return new Response(new ReadableStream({
                        start(c) {
                            c.enqueue(body);
                            c.enqueue(body);
                            c.close();
                        },
                    }));
                }
                return new Response('no', { status: 404 });
            },
        });
        base = `http://127.0.0.1:${server.port}`;
    });
    afterAll(() => server.stop(true));

    test('writes the exact bytes and reports progress', async () => {
        const dest = join(scratch, 'dl-ok');
        const seen: number[] = [];
        await downloadVerified(`${base}/ok`, { sha256: sha256(body), size: body.length }, dest, r => seen.push(r));
        expect(new Uint8Array(readFileSync(dest))).toEqual(body);
        expect(seen.at(-1)).toBe(body.length);
    });

    test('a checksum mismatch throws and leaves no file', async () => {
        const dest = join(scratch, 'dl-sha');
        await expect(downloadVerified(`${base}/ok`, { sha256: 'b'.repeat(64), size: body.length }, dest, () => {})).rejects.toThrow(/checksum/);
        expect(existsSync(dest)).toBe(false);
    });

    test('a body over the published size throws and leaves no file', async () => {
        const dest = join(scratch, 'dl-long');
        await expect(downloadVerified(`${base}/long`, { sha256: sha256(body), size: body.length }, dest, () => {})).rejects.toThrow(/checksum/);
        expect(existsSync(dest)).toBe(false);
    });

    test('an HTTP error throws', async () => {
        const dest = join(scratch, 'dl-404');
        await expect(downloadVerified(`${base}/missing`, { sha256: sha256(body), size: body.length }, dest, () => {})).rejects.toThrow(/HTTP 404/);
        expect(existsSync(dest)).toBe(false);
    });
});

describe.if(posix)('swapInto', () => {
    test('renames the staged binary over the installed one', () => {
        const dir = join(scratch, 'swap');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'vaultagent'), 'old');
        writeFileSync(join(dir, 'vaultagent.update-1'), 'new');
        swapInto(join(dir, 'vaultagent.update-1'), join(dir, 'vaultagent'), 'linux');
        expect(readFileSync(join(dir, 'vaultagent'), 'utf8')).toBe('new');
        expect(readdirSync(dir)).toEqual(['vaultagent']);
    });

    test('a failed swap throws and changes nothing', () => {
        const dir = join(scratch, 'swap-fail');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'vaultagent'), 'old');
        expect(() => swapInto(join(dir, 'missing'), join(dir, 'vaultagent'), 'linux')).toThrow(UpdateFailed);
        expect(readFileSync(join(dir, 'vaultagent'), 'utf8')).toBe('old');
    });

    // Windows' rename-aside path, run on POSIX: the second rename fails, the first is undone.
    test('windows: a failed swap puts the old binary back', () => {
        const dir = join(scratch, 'swap-win');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'vaultagent.exe'), 'old');
        expect(() => swapInto(join(dir, 'missing.exe'), join(dir, 'vaultagent.exe'), 'windows')).toThrow(UpdateFailed);
        expect(readdirSync(dir)).toEqual(['vaultagent.exe']);
        expect(readFileSync(join(dir, 'vaultagent.exe'), 'utf8')).toBe('old');
    });
});

test('cleanupLeftovers removes only what an update leaves', () => {
    const dir = join(scratch, 'leftovers');
    mkdirSync(dir, { recursive: true });
    for (const n of ['vaultagent', 'vaultagent.update-123', 'vaultagent.previous-9.exe', 'vaultagent.log', 'vaultagent.update-x']) writeFileSync(join(dir, n), '');
    cleanupLeftovers(dir);
    expect(readdirSync(dir).sort()).toEqual(['vaultagent', 'vaultagent.log', 'vaultagent.update-x']);
});

describe('createUpdater', () => {
    const NEW_BIN = 'new helper binary';
    const ASSET = 'vaultagent-linux-x64';
    let root: string;
    let n = 0;

    function setup(over: Partial<UpdaterDeps> & { latest?: string; assetBody?: string } = {}) {
        root = join(scratch, `updater-${++n}`);
        const layout = installLayout('linux', root);
        mkdirSync(layout.appDir, { recursive: true });
        writeFileSync(layout.binary, 'old helper binary');
        const latest = over.latest ?? '1.1.0';
        const assetBody = over.assetBody ?? NEW_BIN;
        const fetched: string[] = [];
        const fetchImpl = async (url: string) => {
            fetched.push(url);
            if (url === manifestUrl('https://rel')) {
                return Response.json({ app: 'vaultagent', version: latest, assets: { [ASSET]: { sha256: sha256(NEW_BIN), size: NEW_BIN.length } } });
            }
            if (url === assetUrl('https://rel', latest, ASSET)) return new Response(assetBody);
            return new Response('', { status: 404 });
        };
        const probed: string[] = [];
        const restarts = { n: 0 };
        const updater = createUpdater({
            platform: 'linux',
            arch: 'x64',
            layout,
            currentVersion: '1.0.0',
            releasesBase: 'https://rel',
            activeRuns: () => 0,
            stopServer: () => {},
            execPath: layout.binary,
            fetchImpl,
            probe: async (path, version) => {
                probed.push(`${version}:${readFileSync(path, 'utf8')}`);
            },
            restart: () => restarts.n++,
            runDrainMs: 50,
            ...over,
        });
        return { updater, layout, fetched, probed, restarts };
    }
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    test('check reports a newer release, and caches it', async () => {
        const { updater, fetched } = setup();
        expect(await updater.check(false)).toEqual({ current: '1.0.0', latest: '1.1.0', available: true, installed: true });
        await updater.check(false);
        expect(fetched.length).toBe(1);
        await updater.check(true);
        expect(fetched.length).toBe(2);
    });

    test('a failed check is an answer with an error, not a throw', async () => {
        const { updater } = setup({ fetchImpl: async () => new Response('', { status: 500 }) });
        expect(await updater.check(true)).toMatchObject({ latest: null, available: false, installed: true, error: expect.stringContaining('HTTP 500') });
    });

    test('success: phases in order, the binary replaced, nothing left over, busy until the restart', async () => {
        const { updater, layout, probed, restarts } = setup();
        const phases: UpdateProgress['phase'][] = [];
        expect(await updater.update(p => {
            if (phases.at(-1) !== p.phase) phases.push(p.phase);
        })).toEqual({ from: '1.0.0', to: '1.1.0' });
        expect(phases).toEqual(['checking', 'downloading', 'verifying', 'installing']);
        expect(probed).toEqual([`1.1.0:${NEW_BIN}`]);
        expect(readFileSync(layout.binary, 'utf8')).toBe(NEW_BIN);
        expect(readdirSync(layout.appDir)).toEqual(['vaultagent']);
        expect(updater.busy).toBe(true);
        await expect(updater.update(() => {})).rejects.toBeInstanceOf(UpdateRefused);
        updater.restart();
        expect(restarts.n).toBe(1);
    });

    test('not newer: refused as not-found', async () => {
        const { updater, layout } = setup({ latest: '1.0.0' });
        await expect(updater.update(() => {})).rejects.toMatchObject({ code: 'not-found' });
        expect(readFileSync(layout.binary, 'utf8')).toBe('old helper binary');
        expect(updater.busy).toBe(false);
    });

    test('busy while a run is in flight anywhere', async () => {
        const { updater, fetched } = setup({ activeRuns: () => 1 });
        await expect(updater.update(() => {})).rejects.toMatchObject({ code: 'busy' });
        expect(fetched.length).toBe(0);
    });

    test('refused when not running from the installed binary', async () => {
        const { updater, fetched } = setup({ execPath: join(scratch, 'somewhere-else') });
        await expect(updater.update(() => {})).rejects.toMatchObject({ code: 'unsupported' });
        // …and its check says so, so the panel never offers an update that cannot work.
        expect(await updater.check(true)).toMatchObject({ installed: false, available: false });
        expect(fetched.length).toBe(0);
    });

    test('a corrupt download or a failed probe changes nothing', async () => {
        const corrupt = setup({ assetBody: 'new helper binarX' });
        await expect(corrupt.updater.update(() => {})).rejects.toThrow(/checksum/);
        expect(readFileSync(corrupt.layout.binary, 'utf8')).toBe('old helper binary');
        expect(readdirSync(corrupt.layout.appDir)).toEqual(['vaultagent']);
        expect(corrupt.updater.busy).toBe(false);
        rmSync(root, { recursive: true, force: true });

        const broken = setup({ probe: async () => { throw new UpdateFailed("The new version didn't start on this computer."); } });
        await expect(broken.updater.update(() => {})).rejects.toThrow(/didn't start/);
        expect(readFileSync(broken.layout.binary, 'utf8')).toBe('old helper binary');
        expect(readdirSync(broken.layout.appDir)).toEqual(['vaultagent']);
        expect(broken.updater.busy).toBe(false);
    });
});
