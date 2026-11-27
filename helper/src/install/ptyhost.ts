import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logError } from '../log.ts';
import ptyHostFile from '../../ptyhost/vaultagent-pty' with { type: 'file' };
import { bootoutAndWait, bootstrapWithRetry, isLoaded, launchctl, type Launchctl } from './launchctl.ts';
import { PTYHOST_LABEL, ptyHostPlist, type InstallLayout } from './layout.ts';

export interface EnsureOptions {
    register?: boolean;
    launchctl?: Launchctl;
    bytes?: Uint8Array;
    retryMs?: number;
}

export interface EnsureResult {
    wrote: boolean;
    bootstrapped: boolean;
}

const MAX_SOCKET_PATH = 103;

function sameBytes(path: string, bytes: Uint8Array): boolean {
    try {
        return Buffer.compare(readFileSync(path), bytes) === 0;
    } catch {
        return false;
    }
}

function writeAtomic(path: string, data: string | Uint8Array, mode: number): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.new-${process.pid}`;
    writeFileSync(tmp, data, { mode });
    renameSync(tmp, path);
}

export async function ensurePtyHost(layout: InstallLayout, opts: EnsureOptions = {}): Promise<EnsureResult> {
    const result: EnsureResult = { wrote: false, bootstrapped: false };
    const { ptyHostBinary: binary, ptyHostSocket: socket, ptyHostRegistration: plist } = layout;
    if (layout.platform !== 'macos' || !binary || !socket || !plist) return result;
    try {
        const bytes = opts.bytes ?? new Uint8Array(await Bun.file(ptyHostFile).arrayBuffer());
        const binaryChanged = !sameBytes(binary, bytes);
        if (binaryChanged) writeAtomic(binary, bytes, 0o755);
        const plistText = ptyHostPlist(layout);
        const plistChanged = !existsSync(plist) || readFileSync(plist, 'utf8') !== plistText;
        if (plistChanged) writeAtomic(plist, plistText, 0o644);
        result.wrote = binaryChanged || plistChanged;
        if (opts.register === false) return result;
        if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) throw new Error(`socket path too long for a unix socket: ${socket}`);

        const run = opts.launchctl ?? launchctl;
        const loaded = await isLoaded(PTYHOST_LABEL, run);
        if (loaded && !result.wrote) return result;
        if (loaded) await bootoutAndWait(PTYHOST_LABEL, run);
        const code = await bootstrapWithRetry(plist, run, opts.retryMs);
        if (code !== 0 && !(await isLoaded(PTYHOST_LABEL, run))) throw new Error(`launchctl bootstrap failed (${code})`);
        result.bootstrapped = true;
    } catch (e) {
        logError('PTY host setup failed', e);
    }
    return result;
}

export async function removePtyHost(layout: InstallLayout, run: Launchctl = launchctl): Promise<void> {
    if (layout.platform !== 'macos' || !layout.ptyHostRegistration) return;
    // The plist first: launchd would restart a KeepAlive job whose plist still exists.
    rmSync(layout.ptyHostRegistration, { force: true });
    try {
        await bootoutAndWait(PTYHOST_LABEL, run);
    } catch (e) {
        logError('PTY host bootout failed', e);
    }
}
