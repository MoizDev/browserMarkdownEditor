// The PTY backends and the choice between them.
//
//   inProcessBackend   Bun's own PTY (`Bun.spawn(argv, { terminal })`: openpty on
//                      POSIX, ConPTY on Windows). A single binary, no native addon.
//   ptyHostBackend     (ptyHostBackend.ts) macOS installed helpers only: the shell is
//                      a child of the frozen `vaultagent-pty` LaunchAgent, so the
//                      privacy grants (Documents, Desktop, Full Disk Access) belong
//                      to a binary that never changes across VaultAgent updates.
//
// Measured against Bun 1.4.2 (macOS):
//   • the child is a session + group leader with a controlling tty: Ctrl-C, Ctrl-Z,
//     `fg` and resize behave as in a terminal app;
//   • TERM comes from `env` (`terminal.name` only configures the PTY itself);
//   • `terminal.closed` stays false after the shell exits, so we close it ourselves;
//   • zsh ignores SIGTERM; `terminal.close()` hangs the session up (SIGHUP), which it obeys;
//   • `proc.exited` can settle before the last `data` callbacks have been delivered.

import { join } from 'node:path';
import type { HelperPlatform, TerminalBackend, TerminalExit } from '../../../shared/vaultAgentProtocol.ts';
import type { InstallLayout } from '../install/layout.ts';
import { logError } from '../log.ts';
import { probePtyHost, ptyHostBackend } from './ptyHostBackend.ts';
import type { PtyBackend, PtyCallbacks, PtyProcess, PtySpawnOptions } from './types.ts';

/** How long a hung-up shell gets before its process group is SIGKILLed. */
const KILL_GRACE_MS = 2000;
/** After the shell exits, the PTY's last bytes may still be in flight. */
const DRAIN_QUIET_MS = 150;

function groupAlive(pid: number): boolean {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (e) {
        // EPERM = a group we may not signal exists; only ESRCH means gone.
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

export function inProcessBackend(): PtyBackend {
    return {
        kind: 'inprocess',
        async spawn(options: PtySpawnOptions, callbacks: PtyCallbacks): Promise<PtyProcess> {
            let exited = false;
            let ptyEof: (() => void) | null = null;
            const eof = new Promise<void>(resolve => (ptyEof = resolve));
            const proc = Bun.spawn([options.file, ...options.args], {
                cwd: options.cwd,
                env: options.env,
                argv0: options.argv0,
                windowsHide: true,
                terminal: {
                    cols: options.cols,
                    rows: options.rows,
                    data: (_t, data) => {
                        if (!exited) callbacks.onData(data);
                    },
                    exit: () => ptyEof?.(),
                },
            });
            const terminal = proc.terminal;
            if (!terminal) throw new Error('this Bun has no PTY support');
            let killed = false;
            let closed = false;
            const closeTerminal = () => {
                if (closed) return;
                closed = true;
                try {
                    terminal.close();
                } catch { /* already closed */ }
            };

            void proc.exited.then(async code => {
                // Deliver the PTY's remaining output before reporting the end: either it
                // reports EOF, or (a background job still holds the slave open, so EOF never
                // comes) it has been quiet for a moment.
                await Promise.race([eof, Bun.sleep(DRAIN_QUIET_MS)]);
                exited = true;
                closeTerminal();
                const exit: TerminalExit = { code: proc.signalCode ? null : code, signal: proc.signalCode ?? null };
                callbacks.onExit(exit);
            });

            return {
                pid: proc.pid,
                write(data) {
                    if (closed) return;
                    try {
                        terminal.write(data);
                    } catch (e) {
                        logError('terminal write failed', e);
                    }
                },
                resize(cols, rows) {
                    if (closed) return;
                    try {
                        terminal.resize(cols, rows);
                    } catch (e) {
                        logError('terminal resize failed', e);
                    }
                },
                kill() {
                    if (killed || exited) {
                        closeTerminal();
                        return;
                    }
                    killed = true;
                    const hangUp = () => {
                        closeTerminal();
                        if (process.platform === 'win32') return;
                        // Only while the shell still runs: after it is gone its pid may be
                        // anyone's again. A shell is a group leader, and its job-control
                        // children get their own groups, so this reaches the shell itself.
                        const timer = setTimeout(() => {
                            if (proc.exitCode !== null || proc.signalCode !== null) return;
                            try {
                                if (groupAlive(proc.pid)) process.kill(-proc.pid, 'SIGKILL');
                                else proc.kill('SIGKILL');
                            } catch { /* gone */ }
                        }, KILL_GRACE_MS);
                        timer.unref?.();
                        void proc.exited.then(() => clearTimeout(timer));
                    };
                    if (process.platform !== 'win32') {
                        hangUp();
                        return;
                    }
                    // ConPTY: closing the pseudo console first can hang before Windows 11 24H2
                    // while a child still runs, so kill the tree, then close.
                    try {
                        const tk = Bun.spawn(['taskkill', '/PID', String(proc.pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore', windowsHide: true });
                        void tk.exited.then(closeTerminal, closeTerminal);
                    } catch {
                        closeTerminal();
                    }
                },
            };
        },
    };
}

export function ptyHostSocketPath(layout: InstallLayout): string {
    return layout.ptyHostSocket ?? join(layout.appDir, 'pty.sock');
}

export function ptyHostBinaryPath(layout: InstallLayout): string {
    return layout.ptyHostBinary ?? join(layout.appDir, 'vaultagent-pty');
}

export interface BackendDeps {
    inProcess: () => PtyBackend;
    host: (socketPath: string) => PtyBackend;
    probe: (socketPath: string, timeoutMs?: number) => Promise<boolean>;
}

const REAL_DEPS: BackendDeps = { inProcess: inProcessBackend, host: ptyHostBackend, probe: probePtyHost };

/**
 * The PTY every new terminal gets. The PTY host on macOS installed helpers — chosen
 * per spawn, not once at start: its LaunchAgent may still be starting when the
 * helper is, and it may be restarted later — and Bun's in-process PTY everywhere
 * else, and whenever the host does not answer (logged once per outage: macOS
 * privacy grants then belong to the helper, so they do not persist across updates).
 */
export function chooseBackend(platform: HelperPlatform, layout: InstallLayout, installed: boolean, deps: BackendDeps = REAL_DEPS): PtyBackend {
    const inProcess = deps.inProcess();
    if (platform !== 'macos' || !installed) return inProcess;
    const socket = ptyHostSocketPath(layout);
    const host = deps.host(socket);
    let current: PtyBackend = host;
    let reported = false;
    return {
        get kind(): TerminalBackend {
            return current.kind;
        },
        async spawn(options, callbacks) {
            if (await deps.probe(socket, 1500)) {
                reported = false;
                current = host;
                return host.spawn(options, callbacks);
            }
            if (!reported) {
                reported = true;
                logError('the PTY host is not answering; terminals use the in-process PTY, whose macOS privacy grants do not survive updates');
            }
            current = inProcess;
            return inProcess.spawn(options, callbacks);
        },
    };
}
