// install / uninstall for the three OSes. Everything is per-user and
// user-owned, so the helper can remove itself from the panel without a password.
//
// `root` (tests, CI smoke): files are laid out under that folder and nothing is
// registered with the OS — no launchctl, schtasks or systemctl.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { HelperPlatform } from '../../../shared/vaultAgentProtocol.ts';
import { logError } from '../log.ts';
import { detached, detachedCmd, runCapture } from '../proc.ts';
import {
    LAUNCHD_LABEL, SYSTEMD_UNIT, WINDOWS_TASK, autostartDesktop, installLayout, launchdPlist, systemdUnit, windowsTaskXml,
    type InstallLayout,
} from './layout.ts';

export interface InstallOptions {
    platform: HelperPlatform;
    root?: string;
    /** The executable to copy in (default: this process's). */
    sourceBinary?: string;
    /** macOS pkg postinstall: it bootstraps the agent itself, as root, into the user's GUI domain. */
    skipLaunchctl?: boolean;
}

function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o644): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, data, { mode });
    renameSync(tmp, path);
}

/** Copy via temp + rename: replacing a running executable in place can crash it (macOS maps it). */
function placeBinary(src: string, dest: string): void {
    if (resolve(src) === resolve(dest)) return;
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.new-${process.pid}`;
    copyFileSync(src, tmp);
    chmodSync(tmp, 0o755);
    if (process.platform === 'win32' && existsSync(dest)) {
        try {
            unlinkSync(dest);
        } catch { /* locked: the rename below reports it */ }
    }
    renameSync(tmp, dest);
}

function uid(): number {
    return typeof process.getuid === 'function' ? process.getuid() : 0;
}

async function launchctl(...args: string[]) {
    return runCapture(['/bin/launchctl', ...args], { timeoutMs: 15_000 });
}

/** Unload the login item and wait (≤5 s) until launchd no longer knows it. */
async function bootoutAndWait(): Promise<void> {
    const target = `gui/${uid()}/${LAUNCHD_LABEL}`;
    await launchctl('bootout', target);
    for (let i = 0; i < 25; i++) {
        if ((await launchctl('print', target)).code !== 0) return;
        await Bun.sleep(200);
    }
}

async function systemctl(...args: string[]) {
    return runCapture(['systemctl', '--user', ...args], { timeoutMs: 20_000 });
}

async function schtasks(...args: string[]) {
    return runCapture(['schtasks.exe', ...args], { timeoutMs: 20_000 });
}

function windowsUserId(): string {
    const user = process.env.USERNAME ?? '';
    const domain = process.env.USERDOMAIN ?? '';
    return domain ? `${domain}\\${user}` : user;
}

/**
 * Linux without systemd: a helper started detached (XDG fallback) has no service
 * to stop, so find it by its executable — which reads `<path> (deleted)` once a
 * reinstall has renamed a new binary over it — and ask it to exit.
 */
function stopDetachedHelpers(binary: string): void {
    if (process.platform !== 'linux') return;
    let pids: string[];
    try {
        pids = readdirSync('/proc').filter(n => /^\d+$/.test(n) && Number(n) !== process.pid);
    } catch {
        return;
    }
    for (const pid of pids) {
        let exe: string;
        try {
            exe = readlinkSync(`/proc/${pid}/exe`);
        } catch {
            continue; // another user's process, or already gone
        }
        if (exe !== binary && exe !== `${binary} (deleted)`) continue;
        try {
            process.kill(Number(pid), 'SIGTERM');
        } catch { /* gone */ }
    }
}

export async function install(opts: InstallOptions): Promise<InstallLayout> {
    const l = installLayout(opts.platform, opts.root);
    const register = !opts.root;
    placeBinary(opts.sourceBinary ?? process.execPath, l.binary);
    mkdirSync(dirname(l.logFile), { recursive: true });

    if (l.platform === 'macos') {
        writeFileAtomic(l.registrationFile!, launchdPlist(l));
        if (register && !opts.skipLaunchctl) {
            // bootout first: a reinstall replaces the running old version.
            await bootoutAndWait();
            // A bootstrap right behind a bootout can still fail with "5:
            // Input/output error" while launchd finishes tearing the old job down.
            let r = await launchctl('bootstrap', `gui/${uid()}`, l.registrationFile!);
            for (let i = 0; r.code !== 0 && i < 4; i++) {
                await Bun.sleep(1000);
                r = await launchctl('bootstrap', `gui/${uid()}`, l.registrationFile!);
            }
            if (r.code !== 0) throw new Error(`launchctl bootstrap failed (${r.code})`);
        }
    } else if (l.platform === 'windows') {
        if (register) {
            const xmlPath = join(tmpdir(), `vaultagent-task-${process.pid}.xml`);
            // schtasks reads task XML as UTF-16 (LE, with BOM).
            writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(windowsTaskXml(l, windowsUserId()), 'utf16le')]));
            try {
                const r = await schtasks('/Create', '/TN', WINDOWS_TASK, '/XML', xmlPath, '/F');
                if (r.code !== 0) throw new Error(`schtasks /Create failed (${r.code})`);
            } finally {
                rmSync(xmlPath, { force: true });
            }
            await schtasks('/Run', '/TN', WINDOWS_TASK);
        }
    } else {
        writeFileAtomic(l.registrationFile!, systemdUnit(l));
        let viaSystemd = false;
        if (register) {
            const reload = await systemctl('daemon-reload');
            if (reload.code === 0) {
                const en = await systemctl('enable', SYSTEMD_UNIT);
                const re = await systemctl('restart', SYSTEMD_UNIT);
                viaSystemd = en.code === 0 && re.code === 0;
            }
        }
        if (!viaSystemd) {
            // No systemd user session (some desktops, WSL, containers): XDG autostart.
            writeFileAtomic(l.autostartFile!, autostartDesktop(l));
            if (register) {
                // A reinstall: the old helper would keep its port and the new one take the next.
                stopDetachedHelpers(l.binary);
                detached([l.binary, 'serve']);
            }
        } else if (existsSync(l.autostartFile!)) {
            rmSync(l.autostartFile!, { force: true });
        }
    }
    return l;
}

function removeFiles(l: InstallLayout): void {
    for (const p of [l.registrationFile, l.autostartFile, l.logFile, `${l.logFile}.1`]) {
        if (p) rmSync(p, { force: true });
    }
    if (l.platform === 'linux') rmSync(dirname(l.logFile), { recursive: true, force: true });
    try {
        rmSync(l.appDir, { recursive: true, force: true });
    } catch {
        // Windows cannot delete a running .exe; uninstall() schedules that folder's removal.
    }
}

/**
 * Remove registration, binary and logs. `~/.bme-agent-sessions` is kept (the
 * CLIs' own sessions are recorded against those folders). When this process IS
 * the registered service, the step that stops it comes last.
 */
export async function uninstall(opts: { platform: HelperPlatform; root?: string }): Promise<void> {
    const l = installLayout(opts.platform, opts.root);
    const register = !opts.root;
    if (l.platform === 'macos') {
        removeFiles(l);
        // launchd would restart a KeepAlive job whose plist still exists; the files go first.
        if (register) await launchctl('bootout', `gui/${uid()}/${LAUNCHD_LABEL}`);
        return;
    }
    if (l.platform === 'linux') {
        if (register) await systemctl('disable', SYSTEMD_UNIT);
        removeFiles(l);
        if (register) {
            stopDetachedHelpers(l.binary); // the XDG-autostart case; never this process
            await systemctl('daemon-reload');
            await systemctl('stop', SYSTEMD_UNIT); // stops us, if we are it
        }
        return;
    }
    // Windows: the Inno Setup uninstaller owns the files and the Apps & Features entry.
    const uninstaller = join(l.appDir, 'unins000.exe');
    if (register && existsSync(uninstaller)) {
        detached([uninstaller, '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
        return;
    }
    if (register) await uninstallService();
    removeFiles(l);
    if (register && existsSync(l.appDir) && !/["%]/.test(l.appDir)) {
        // Our own .exe is still running; delete the folder once we are gone. `ping`
        // as the delay, not `timeout`: with no console (stdio 'ignore') `timeout`
        // fails at once ("Input redirection is not supported") and the rmdir ran
        // while the .exe was still locked.
        detachedCmd(`ping -n 4 127.0.0.1 >nul & rmdir /s /q "${l.appDir}"`);
    }
}

/** Windows: what the Inno uninstaller runs before deleting files — drop the task, stop the other helpers. */
export async function uninstallService(): Promise<void> {
    await schtasks('/End', '/TN', WINDOWS_TASK);
    await schtasks('/Delete', '/TN', WINDOWS_TASK, '/F');
    await runCapture(['taskkill.exe', '/F', '/IM', 'vaultagent.exe', '/FI', `PID ne ${process.pid}`], { timeoutMs: 15_000 });
}

/** The panel's "Uninstall": remove everything, then exit. */
export async function selfUninstall(platform: HelperPlatform): Promise<never> {
    try {
        await uninstall({ platform });
    } catch (e) {
        logError('self-uninstall failed', e);
    }
    process.exit(0);
}
