import { join } from 'node:path';
import type { HelperPlatform, TerminalBackend, TerminalExit } from '../../../shared/vaultAgentProtocol.ts';
import type { InstallLayout } from '../install/layout.ts';
import { logError } from '../log.ts';
import { probePtyHost, ptyHostBackend } from './ptyHostBackend.ts';
import type { PtyBackend, PtyCallbacks, PtyProcess, PtySpawnOptions } from './types.ts';

const KILL_GRACE_MS = 2000;
const DRAIN_QUIET_MS = 150;

function groupAlive(pid: number): boolean {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (e) {
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
