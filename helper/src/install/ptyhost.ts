// Installing the frozen PTY host (macOS): the bytes embedded in this helper are
// written to <appDir>/vaultagent-pty and run as their OWN LaunchAgent, so macOS
// privacy grants (Documents, Desktop, iCloud Drive, Full Disk Access) attach to a
// binary that no helper update ever changes — see helper/ptyhost/ptyhost.c.
//
// Called from `install` and at the start of every installed `serve`, which is how a
// helper that self-updated from before the terminal existed gets the host without
// running an installer. Everything here is idempotent: identical bytes and an
// already-loaded job change nothing, because each change costs the user their
// running shells (and a different binary, their grants).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logError } from '../log.ts';
import ptyHostFile from '../../ptyhost/vaultagent-pty' with { type: 'file' };
import { bootoutAndWait, bootstrapWithRetry, isLoaded, launchctl, type Launchctl } from './launchctl.ts';
import { PTYHOST_LABEL, ptyHostPlist, type InstallLayout } from './layout.ts';

export interface EnsureOptions {
    /** Load the job into launchd. False for `--root` layouts and the pkg's `--no-launchctl`. Default true. */
    register?: boolean;
    /** Tests inject a stub: nothing in a test may touch the real launchd. */
    launchctl?: Launchctl;
    /** Tests inject other bytes; the default is the embedded host. */
    bytes?: Uint8Array;
    /** Pause between bootstrap retries (default 1 s); tests shorten it. */
    retryMs?: number;
}

export interface EnsureResult {
    /** The binary or the plist was written (as opposed to already identical). */
    wrote: boolean;
    /** launchd was told to (re)load the job. */
    bootstrapped: boolean;
}

/** macOS sockaddr_un.sun_path holds 104 bytes including the NUL. */
const MAX_SOCKET_PATH = 103;

function sameBytes(path: string, bytes: Uint8Array): boolean {
    try {
        return Buffer.compare(readFileSync(path), bytes) === 0;
    } catch {
        return false;
    }
}

/** Temp + rename: a running host keeps its (now unlinked) inode, and the path is never half-written. */
function writeAtomic(path: string, data: string | Uint8Array, mode: number): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.new-${process.pid}`;
    writeFileSync(tmp, data, { mode });
    renameSync(tmp, path);
}

/**
 * Put the host in place (only when missing or different) and make sure its
 * LaunchAgent is registered and loaded. A no-op off macOS. Never throws: without
 * the host the terminal still works through the in-process PTY, just without
 * privacy grants that survive updates, so a failure here is logged, not fatal.
 */
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
        // Only a registered host binds the socket (a --root layout may sit in a long temp path).
        if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) throw new Error(`socket path too long for a unix socket: ${socket}`);

        const run = opts.launchctl ?? launchctl;
        const loaded = await isLoaded(PTYHOST_LABEL, run);
        if (loaded && !result.wrote) return result;
        // Replaced under a running host, or never loaded. Booting out ends the shells it
        // holds, which only happens on a deliberate host change.
        if (loaded) await bootoutAndWait(PTYHOST_LABEL, run);
        const code = await bootstrapWithRetry(plist, run, opts.retryMs);
        // A concurrent start (the helper's `serve` and its `install`) may have won the bootstrap.
        if (code !== 0 && !(await isLoaded(PTYHOST_LABEL, run))) throw new Error(`launchctl bootstrap failed (${code})`);
        result.bootstrapped = true;
    } catch (e) {
        logError('PTY host setup failed', e);
    }
    return result;
}

/** Uninstall: boot the host out and delete its plist (the binary and socket go with appDir). */
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
