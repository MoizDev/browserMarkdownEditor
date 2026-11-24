// Self-update: the panel's one-click "Update VaultAgent".
//
// The browser can neither run a program nor read a GitHub release asset (CORS),
// so the helper does the work itself, as the user, in its own per-user folder.
// What it reads is fixed at build time (RELEASES_BASE_URL, never from the wire):
//
//   <base>/latest/download/vaultagent-release.json      {app, version, assets: {<name>: {sha256, size}}}
//   <base>/download/vaultagent-v<version>/<asset>      the raw binary for this OS/arch
//
// The asset comes from the VERSIONED url: "latest" can move between the two fetches.
//
// Nothing on disk changes until the new binary has proven itself, so any failure
// before the swap leaves the running helper, its binary and its socket untouched:
//   1. manifest (size-capped, validated) — refuse unless it is newer;
//   2. stream the asset into `<appDir>/vaultagent.update-<pid>` (same folder: the
//      swap is one rename), sha256 + size checked as it arrives;
//   3. `<staged> --version` must print the manifest's version, and `<staged> serve
//      --no-register` must bind a port and answer /health with it;
//   4. swap: POSIX `rename` (a new inode — the running process keeps the old one,
//      and macOS's code-signing cache SIGKILLs a binary overwritten in place);
//      Windows renames the running .exe aside first (allowed while it runs);
//   5. respond, then restart into the new binary under the OS's service manager.
// Leftovers (`vaultagent.update-*`, `vaultagent.previous-*`) go at the next start.
//
// Trust: HTTPS to GitHub is the root, as for the manual download. The sha256
// guards against truncation and corruption, not against a compromised repo.

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

/** EX_TEMPFAIL: a non-zero exit, so launchd (KeepAlive SuccessfulExit=false) and
 *  systemd (Restart=on-failure) start the service again — from the new binary. */
export const RESTART_EXIT_CODE = 75;

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_ASSET_BYTES = 300 * 1024 * 1024;
const DOWNLOAD_IDLE_MS = 60_000;
const MANIFEST_TIMEOUT_MS = 20_000;
const CHECK_OK_TTL_MS = 10 * 60_000;
const CHECK_FAIL_TTL_MS = 30_000;
/** The panel stops its own reply just before it asks; give that run a moment to wind down. */
const RUN_DRAIN_MS = 5000;

export interface ReleaseAsset { sha256: string; size: number }
export interface Manifest { app: typeof HELPER_APP_ID; version: string; assets: Record<string, ReleaseAsset> }
export interface UpdateProgress { phase: UpdatePhase; received?: number; total?: number }

/** A refusal the panel shows as is, with the protocol's error code. */
export class UpdateRefused extends Error {
    constructor(public code: 'busy' | 'unsupported' | 'not-found', message: string) {
        super(message);
        this.name = 'UpdateRefused';
    }
}

/** A failed attempt whose message is written for the user. */
export class UpdateFailed extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'UpdateFailed';
    }
}

export function updateAssetName(platform: HelperPlatform, arch: string): string | null {
    if (platform === 'macos') return arch === 'arm64' ? 'vaultagent-macos-arm64' : arch === 'x64' ? 'vaultagent-macos-x64' : null;
    // Windows on Arm runs the x64 build emulated, as the installer does.
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

/**
 * Stream `url` into `dest`, hashing as it arrives; `dest` exists afterwards only
 * if size and sha256 both match. Progress at most every 200 ms.
 */
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

/**
 * Prove the staged binary runs here before anything is replaced: `--version`
 * prints exactly `version`, and `serve --no-register` binds a port (the next free
 * one: the running helper keeps its own) and answers /health as that version.
 */
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
            // It exited on its own: the one failure worth naming is every helper port being taken.
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

/** Put the staged binary where the installed one is. Throws with nothing changed. */
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

/** A Windows swap that could neither finish nor be undone (see swapInto). */
class SwapStranded extends UpdateFailed {}

/** Inno Setup's Apps & Features entry (AppId in VaultAgent.iss), when the installer made one. */
const WINDOWS_UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{6B0C3F0E-8F2A-4E57-9D1B-5A4C7E2B9F31}_is1';

async function updateWindowsDisplayVersion(version: string): Promise<void> {
    if ((await runCapture(['reg.exe', 'query', WINDOWS_UNINSTALL_KEY, '/v', 'DisplayVersion'], { timeoutMs: 10_000 })).code !== 0) return;
    const r = await runCapture(['reg.exe', 'add', WINDOWS_UNINSTALL_KEY, '/v', 'DisplayVersion', '/d', version, '/f'], { timeoutMs: 10_000 });
    if (r.code !== 0) logError(`update: could not record the new version in Apps & Features (${r.code})`);
}

/** Is this process the systemd user service (not a terminal run that merely inherited a service's env)? */
function underSystemdService(): boolean {
    try {
        return readFileSync('/proc/self/cgroup', 'utf8').split('\n').some(l => l.endsWith(`/${SYSTEMD_UNIT}`));
    } catch {
        return false;
    }
}

/** Exit and come back as the (now new) installed binary, under the same service manager. Never returns. */
export function restartHelper(platform: HelperPlatform, layout: InstallLayout): never {
    if (platform === 'macos' && process.env.XPC_SERVICE_NAME === LAUNCHD_LABEL) process.exit(RESTART_EXIT_CODE);
    if (platform === 'linux' && underSystemdService()) process.exit(RESTART_EXIT_CODE);
    if (platform === 'windows' && !/["%]/.test(layout.binary)) {
        // Through the logon task, so it stays Task Scheduler's (MultipleInstancesPolicy
        // IgnoreNew: only once this instance has gone); the direct start covers a
        // missing task. `ping` is the delay: `timeout` fails with no console.
        detachedCmd(`ping -n 3 127.0.0.1 >nul & schtasks /Run /TN ${WINDOWS_TASK} >nul 2>&1 || start "" "${layout.binary}" serve`);
        process.exit(0);
    }
    // A helper started by hand, the Linux XDG-autostart fallback: no service to do it.
    // The server has already stopped, so the new process can take the same port.
    detached([layout.binary, 'serve']);
    process.exit(0);
}

/** Best effort, at start: what an earlier update left behind (a crash mid-download, Windows' renamed .exe). */
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
    /** Runs in flight on every connection: an update would end them. */
    activeRuns: () => number;
    /** Frees the port before the new binary starts. */
    stopServer: () => void;
    arch?: string;
    /** The running executable (default `process.execPath`). */
    execPath?: string;
    fetchImpl?: FetchImpl;
    probe?: (path: string, version: string) => Promise<void>;
    restart?: () => void;
    /** How long to wait for in-flight runs to end (tests shorten it). */
    runDrainMs?: number;
}

export interface Updater {
    /** An update is in flight — or done, and the helper is about to restart. */
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
        // update() refuses such a copy, so offering it an update would only ever fail.
        if (!samePath(deps.execPath ?? process.execPath, layout.binary)) {
            return { current: currentVersion, latest: null, available: false, installed: false };
        }
        if (!force && cached && Date.now() - cached.at < (cached.result.error ? CHECK_FAIL_TTL_MS : CHECK_OK_TTL_MS)) return cached.result;
        // One request to GitHub however many tabs ask at once.
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
            // Only the installed copy may replace itself: a helper run from a download
            // folder would otherwise overwrite the installed one behind the service's back.
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
                // Our own message, plus the cause's name/code (never a body or a path's contents).
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
                // The port is gone either way: exiting non-zero at least hands the
                // helper back to its service manager rather than idling deaf and busy.
                logError('update: restart failed', e);
                if (!deps.restart) process.exit(RESTART_EXIT_CODE);
            }
        },
    };
}
