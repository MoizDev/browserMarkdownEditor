import { chmodSync, closeSync, fsyncSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
    HELPER_APP_ID, RELEASE_MANIFEST, compareVersions,
    type HealthResponse, type HelperPlatform, type UpdateCheck, type UpdatePhase,
} from '../../shared/vaultAgentProtocol.ts';
import { LAUNCHD_LABEL, SYSTEMD_UNIT, WINDOWS_TASK, type InstallLayout } from './install/layout.ts';
import { logError } from './log.ts';
import { detached, detachedCmd, drainTail, runCapture, stopProcess } from './proc.ts';

/** The raw binaries a release publishes for self-update. Renaming one breaks every
 *  installed helper's update path: the release workflow and its manifest use these. */
export const UPDATE_ASSET_NAMES = [
    'vaultagent-macos-arm64',
    'vaultagent-macos-x64',
    'vaultagent-windows-x64.exe',
    'vaultagent-linux-x64',
    'vaultagent-linux-arm64',
] as const;

export const RESTART_EXIT_CODE = 75;

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_ASSET_BYTES = 300 * 1024 * 1024;
const DOWNLOAD_IDLE_MS = 60_000;
const MANIFEST_TIMEOUT_MS = 20_000;
const CHECK_OK_TTL_MS = 10 * 60_000;
const CHECK_FAIL_TTL_MS = 30_000;
const RUN_DRAIN_MS = 5000;

export interface ReleaseAsset { sha256: string; size: number }
export interface Manifest { app: typeof HELPER_APP_ID; version: string; assets: Record<string, ReleaseAsset> }
export interface UpdateProgress { phase: UpdatePhase; received?: number; total?: number }

export class UpdateRefused extends Error {
    constructor(public code: 'busy' | 'unsupported' | 'not-found', message: string) {
        super(message);
        this.name = 'UpdateRefused';
    }
}

export class UpdateFailed extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'UpdateFailed';
    }
}

export function updateAssetName(platform: HelperPlatform, arch: string): string | null {
    if (platform === 'macos') return arch === 'arm64' ? 'vaultagent-macos-arm64' : arch === 'x64' ? 'vaultagent-macos-x64' : null;
    if (platform === 'windows') return arch === 'x64' || arch === 'arm64' ? 'vaultagent-windows-x64.exe' : null;
    if (platform === 'linux') return arch === 'x64' || arch === 'arm64' ? `vaultagent-linux-${arch}` : null;
    return null;
}

export function isReleaseVersion(v: unknown): v is string {
    return typeof v === 'string' && VERSION_RE.test(v);
}

export function parseManifest(raw: unknown): Manifest {
    const bad = (why: string) => new UpdateFailed(`The release information is invalid (${why}).`);
    if (!raw || typeof raw !== 'object') throw bad('not an object');
    const m = raw as Record<string, unknown>;
    if (m.app !== HELPER_APP_ID) throw bad('not a VaultAgent release');
    if (!isReleaseVersion(m.version)) throw bad('version');
    if (!m.assets || typeof m.assets !== 'object' || Array.isArray(m.assets)) throw bad('assets');
    const assets: Record<string, ReleaseAsset> = {};
    for (const [name, a] of Object.entries(m.assets as Record<string, unknown>)) {
        const { sha256, size } = (a ?? {}) as Record<string, unknown>;
        if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) throw bad(`${name} checksum`);
        if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > MAX_ASSET_BYTES) throw bad(`${name} size`);
        assets[name] = { sha256, size };
    }
    if (!Object.keys(assets).length) throw bad('no assets');
    return { app: HELPER_APP_ID, version: m.version, assets };
}

export const manifestUrl = (base: string) => `${base}/latest/download/${RELEASE_MANIFEST}`;
export const assetUrl = (base: string, version: string, name: string) => `${base}/download/vaultagent-v${version}/${name}`;

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

const NETWORK_ERROR = "Couldn't reach GitHub to download the update. Check your internet connection.";

export async function fetchManifest(base: string, fetchImpl: FetchImpl = fetch): Promise<Manifest> {
    let res: Response;
    try {
        res = await fetchImpl(manifestUrl(base), { signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS), redirect: 'follow' });
    } catch (e) {
        throw new UpdateFailed(NETWORK_ERROR, { cause: e });
    }
    if (!res.ok) throw new UpdateFailed(`Couldn't read the latest release (HTTP ${res.status}).`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_MANIFEST_BYTES) throw new UpdateFailed('The release information is invalid (too large).');
    let text: string;
    try {
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_MANIFEST_BYTES) throw new UpdateFailed('The release information is invalid (too large).');
        text = new TextDecoder().decode(buf);
    } catch (e) {
        if (e instanceof UpdateFailed) throw e;
        throw new UpdateFailed(NETWORK_ERROR, { cause: e });
    }
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        throw new UpdateFailed('The release information is invalid (not JSON).');
    }
    return parseManifest(json);
}

export async function downloadVerified(
    url: string,
    expect: ReleaseAsset,
    dest: string,
    onProgress: (received: number, total: number) => void,
    fetchImpl: FetchImpl = fetch,
): Promise<void> {
    const ctrl = new AbortController();
    let stalled = false;
    let idle = setTimeout(() => { stalled = true; ctrl.abort(); }, DOWNLOAD_IDLE_MS);
    const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { stalled = true; ctrl.abort(); }, DOWNLOAD_IDLE_MS);
    };
    let fd: number | null = null;
    try {
        let res: Response;
        try {
            res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'follow' });
        } catch (e) {
            throw new UpdateFailed(stalled ? 'The download stalled. Try again.' : NETWORK_ERROR, { cause: e });
        }
        if (!res.ok || !res.body) throw new UpdateFailed(`Couldn't download the update (HTTP ${res.status}).`);
        const declared = Number(res.headers.get('content-length') ?? 0);
        if (declared && declared !== expect.size) throw new UpdateFailed("The download didn't match its published checksum.");
        fd = openSync(dest, 'w', 0o700);
        const hasher = new Bun.CryptoHasher('sha256');
        let received = 0;
        let lastReport = 0;
        onProgress(0, expect.size);
        try {
            for await (const chunk of res.body) {
                touch();
                received += chunk.byteLength;
                if (received > expect.size) throw new UpdateFailed("The download didn't match its published checksum.");
                hasher.update(chunk);
                for (let off = 0; off < chunk.byteLength;) off += writeSync(fd, chunk, off);
                const now = Date.now();
                if (now - lastReport >= 200) {
                    lastReport = now;
                    onProgress(received, expect.size);
                }
            }
        } catch (e) {
            if (e instanceof UpdateFailed) throw e;
            const code = (e as NodeJS.ErrnoException).code;
            if (code === 'ENOSPC') throw new UpdateFailed('There is not enough disk space for the update.', { cause: e });
            throw new UpdateFailed(stalled ? 'The download stalled. Try again.' : 'The download was interrupted. Try again.', { cause: e });
        }
        // On disk before it is renamed over the installed copy: a power cut after
        // the swap must not leave a truncated binary as the only one.
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
        if (received !== expect.size || hasher.digest('hex') !== expect.sha256) {
            throw new UpdateFailed("The download didn't match its published checksum.");
        }
        onProgress(received, expect.size);
    } catch (e) {
        if (fd !== null) {
            try {
                closeSync(fd);
            } catch { /* already closed */ }
        }
        rmSync(dest, { force: true });
        throw e;
    } finally {
        clearTimeout(idle);
    }
}

const DIDNT_START = "The new version didn't start on this computer.";

export async function probeStaged(path: string, version: string): Promise<void> {
    const v = await runCapture([path, '--version'], { timeoutMs: 15_000 });
    if (v.code !== 0 || v.stdout.trim() !== version) throw new UpdateFailed(DIDNT_START);

    let proc: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'pipe'>>;
    try {
        proc = Bun.spawn([path, 'serve', '--no-register'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    } catch (e) {
        throw new UpdateFailed(DIDNT_START, { cause: e });
    }
    const errTail = drainTail(proc.stderr);
    const deadline = Date.now() + 20_000;
    try {
        const reader = proc.stdout.getReader();
        let out = '';
        let port = 0;
        while (!port && Date.now() < deadline) {
            const r = await Promise.race([
                reader.read(),
                Bun.sleep(deadline - Date.now()).then(() => ({ value: undefined, done: true as const })),
            ]);
            if (r.done) break;
            out += new TextDecoder().decode(r.value);
            if (out.length > 4096) out = out.slice(-4096);
            port = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out)?.[1] ?? 0);
        }
        reader.releaseLock();
        if (!port) {
            const exited = typeof (await Promise.race([proc.exited, Bun.sleep(200)])) === 'number';
            if (exited && /none of the ports/.test(await Promise.race([errTail, Bun.sleep(1000).then(() => '')]))) {
                throw new UpdateFailed("Couldn't start the new version to check it (no free port).");
            }
            throw new UpdateFailed(DIDNT_START);
        }
        let health: Partial<HealthResponse> = {};
        try {
            const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())) });
            health = (await r.json()) as Partial<HealthResponse>;
        } catch { /* reported below */ }
        if (health.app !== HELPER_APP_ID || health.version !== version) throw new UpdateFailed(DIDNT_START);
    } finally {
        await stopProcess(proc, 3000);
    }
}

export function swapInto(staged: string, binary: string, platform: HelperPlatform): void {
    const fail = (e: unknown) => new UpdateFailed("Couldn't replace the installed VaultAgent.", { cause: e });
    if (platform !== 'windows') {
        try {
            renameSync(staged, binary);
        } catch (e) {
            throw fail(e);
        }
        return;
    }
    // A running .exe cannot be replaced or deleted, but it can be renamed.
    const aside = join(dirname(binary), `vaultagent.previous-${process.pid}.exe`);
    try {
        renameSync(binary, aside);
    } catch (e) {
        throw fail(e);
    }
    try {
        renameSync(staged, binary);
    } catch (e) {
        try {
            renameSync(aside, binary);
        } catch (e2) {
            logError('update: could not put the old binary back', e2);
            // Nothing is at `binary` now: the staged copy is the only working one
            // left on disk, so it must survive the caller's cleanup.
            throw new SwapStranded("Couldn't replace the installed VaultAgent. Download the installer and run it to repair it.", { cause: e });
        }
        throw fail(e);
    }
}

class SwapStranded extends UpdateFailed {}

const WINDOWS_UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{6B0C3F0E-8F2A-4E57-9D1B-5A4C7E2B9F31}_is1';

async function updateWindowsDisplayVersion(version: string): Promise<void> {
    if ((await runCapture(['reg.exe', 'query', WINDOWS_UNINSTALL_KEY, '/v', 'DisplayVersion'], { timeoutMs: 10_000 })).code !== 0) return;
    const r = await runCapture(['reg.exe', 'add', WINDOWS_UNINSTALL_KEY, '/v', 'DisplayVersion', '/d', version, '/f'], { timeoutMs: 10_000 });
    if (r.code !== 0) logError(`update: could not record the new version in Apps & Features (${r.code})`);
}

function underSystemdService(): boolean {
    try {
        return readFileSync('/proc/self/cgroup', 'utf8').split('\n').some(l => l.endsWith(`/${SYSTEMD_UNIT}`));
    } catch {
        return false;
    }
}

export function restartHelper(platform: HelperPlatform, layout: InstallLayout): never {
    if (platform === 'macos' && process.env.XPC_SERVICE_NAME === LAUNCHD_LABEL) process.exit(RESTART_EXIT_CODE);
    if (platform === 'linux' && underSystemdService()) process.exit(RESTART_EXIT_CODE);
    if (platform === 'windows' && !/["%]/.test(layout.binary)) {
        detachedCmd(`ping -n 3 127.0.0.1 >nul & schtasks /Run /TN ${WINDOWS_TASK} >nul 2>&1 || start "" "${layout.binary}" serve`);
        process.exit(0);
    }
    detached([layout.binary, 'serve']);
    process.exit(0);
}

export function cleanupLeftovers(appDir: string): void {
    let names: string[];
    try {
        names = readdirSync(appDir);
    } catch {
        return;
    }
    for (const n of names) {
        if (!/^vaultagent\.(update|previous)-\d+(\.exe)?$/.test(n)) continue;
        try {
            rmSync(join(appDir, n), { force: true });
        } catch { /* still locked: the next start tries again */ }
    }
}

export interface UpdaterDeps {
    platform: HelperPlatform;
    layout: InstallLayout;
    currentVersion: string;
    releasesBase: string;
    activeRuns: () => number;
    stopServer: () => void;
    arch?: string;
    execPath?: string;
    fetchImpl?: FetchImpl;
    probe?: (path: string, version: string) => Promise<void>;
    restart?: () => void;
    runDrainMs?: number;
}

export interface Updater {
    readonly busy: boolean;
    check(force: boolean): Promise<UpdateCheck>;
    update(onProgress: (p: UpdateProgress) => void): Promise<{ from: string; to: string }>;
    restart(): void;
}

function samePath(a: string, b: string): boolean {
    try {
        return realpathSync(a) === realpathSync(b);
    } catch {
        return false;
    }
}

export function createUpdater(deps: UpdaterDeps): Updater {
    const { platform, layout, currentVersion, releasesBase } = deps;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const probe = deps.probe ?? probeStaged;
    const asset = updateAssetName(platform, deps.arch ?? process.arch);
    let busy = false;
    let cached: { at: number; result: UpdateCheck } | null = null;
    let checking: Promise<UpdateCheck> | null = null;

    const remember = (result: UpdateCheck) => {
        cached = { at: Date.now(), result };
        return result;
    };
    const fromManifest = (m: Manifest): UpdateCheck => {
        if (!asset || !m.assets[asset]) {
            return { current: currentVersion, latest: m.version, available: false, installed: true, error: 'The latest release has no build for this computer.' };
        }
        return { current: currentVersion, latest: m.version, available: compareVersions(m.version, currentVersion) > 0, installed: true };
    };

    async function check(force: boolean): Promise<UpdateCheck> {
        if (!samePath(deps.execPath ?? process.execPath, layout.binary)) {
            return { current: currentVersion, latest: null, available: false, installed: false };
        }
        if (!force && cached && Date.now() - cached.at < (cached.result.error ? CHECK_FAIL_TTL_MS : CHECK_OK_TTL_MS)) return cached.result;
        checking ??= fetchManifest(releasesBase, fetchImpl).then(
            m => remember(fromManifest(m)),
            e => {
                if (!(e instanceof UpdateFailed)) logError('update check failed', e);
                return remember({ current: currentVersion, latest: null, available: false, installed: true, error: e instanceof UpdateFailed ? e.message : "Couldn't check for updates." });
            },
        ).finally(() => {
            checking = null;
        });
        return checking;
    }

    async function update(onProgress: (p: UpdateProgress) => void): Promise<{ from: string; to: string }> {
        if (busy) throw new UpdateRefused('busy', 'VaultAgent is already updating.');
        busy = true;
        let swapped = false;
        const staged = join(layout.appDir, `vaultagent.update-${process.pid}${platform === 'windows' ? '.exe' : ''}`);
        try {
            for (const until = Date.now() + (deps.runDrainMs ?? RUN_DRAIN_MS); deps.activeRuns() > 0 && Date.now() < until;) await Bun.sleep(100);
            if (deps.activeRuns() > 0) throw new UpdateRefused('busy', 'A reply is still being written in another window. Update when it has finished.');
            if (!asset) throw new UpdateRefused('unsupported', 'There is no VaultAgent build to update to for this computer.');
            if (!samePath(deps.execPath ?? process.execPath, layout.binary)) {
                throw new UpdateRefused('unsupported', "This VaultAgent isn't running from its installed location, so it can't update itself.");
            }

            onProgress({ phase: 'checking' });
            const manifest = await fetchManifest(releasesBase, fetchImpl);
            remember(fromManifest(manifest));
            if (compareVersions(manifest.version, currentVersion) <= 0) {
                throw new UpdateRefused('not-found', `VaultAgent ${currentVersion} is already the latest version.`);
            }
            const entry = manifest.assets[asset];
            if (!entry) throw new UpdateRefused('not-found', 'The latest release has no build for this computer.');

            onProgress({ phase: 'downloading', received: 0, total: entry.size });
            await downloadVerified(assetUrl(releasesBase, manifest.version, asset), entry, staged,
                (received, total) => onProgress({ phase: 'downloading', received, total }), fetchImpl);

            onProgress({ phase: 'verifying' });
            if (platform !== 'windows') chmodSync(staged, 0o755);
            await probe(staged, manifest.version);

            onProgress({ phase: 'installing' });
            swapInto(staged, layout.binary, platform);
            swapped = true;
            cached = null;
            if (platform === 'windows') await updateWindowsDisplayVersion(manifest.version).catch(e => logError('update: Apps & Features version', e));
            return { from: currentVersion, to: manifest.version };
        } catch (e) {
            if (!(e instanceof SwapStranded)) rmSync(staged, { force: true });
            if (e instanceof UpdateRefused) throw e;
            if (e instanceof UpdateFailed) {
                logError(`update failed: ${e.message}`, e.cause);
                throw e;
            }
            logError('update failed', e);
            throw new UpdateFailed("Couldn't update VaultAgent.", { cause: e });
        } finally {
            // After the swap it stays busy: this process is about to restart, and must
            // neither start a run nor a second update on the binary it no longer is.
            if (!swapped) busy = false;
        }
    }

    return {
        get busy() {
            return busy;
        },
        check,
        update,
        restart() {
            try {
                deps.stopServer();
                if (deps.restart) deps.restart();
                else restartHelper(platform, layout);
            } catch (e) {
                logError('update: restart failed', e);
                if (!deps.restart) process.exit(RESTART_EXIT_CODE);
            }
        },
    };
}
