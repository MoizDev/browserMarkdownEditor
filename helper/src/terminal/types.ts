// The seam between the terminal session manager and whatever actually owns the
// PTY. Two implementations exist (backend.ts): Bun's in-process PTY, and — on
// installed macOS helpers — the frozen `vaultagent-pty` host reached over a unix
// socket, so the macOS privacy grants the user gives belong to a binary that
// never changes across VaultAgent updates (see helper/ptyhost/ptyhost.c).
//
// The manager (session lifetime, headless mirror, flow control) is identical on
// top of either; tests inject a fake.

import type { TerminalBackend, TerminalExit } from '../../../shared/vaultAgentProtocol.ts';

export interface PtySpawnOptions {
    /** Absolute path of the program to exec. */
    file: string;
    /** Arguments after argv[0]. */
    args: string[];
    /** argv[0] as the program sees it — `-zsh` marks a login shell the
     *  traditional way. Defaults to `file`. */
    argv0?: string;
    /** The COMPLETE environment of the child (nothing is inherited on top). */
    env: Record<string, string>;
    cwd: string;
    cols: number;
    rows: number;
}

export interface PtyCallbacks {
    /** Raw output bytes, in order. Never called after `onExit`. */
    onData(bytes: Uint8Array): void;
    /** Exactly once, after the last `onData`. */
    onExit(exit: TerminalExit): void;
}

export interface PtyProcess {
    readonly pid: number;
    write(data: string | Uint8Array): void;
    resize(cols: number, rows: number): void;
    /** Hang up the PTY (SIGHUP to the session), and SIGKILL the process group
     *  if it is still there after a short grace. Idempotent; `onExit` still
     *  fires (if it has not already). */
    kill(): void;
}

export interface PtyBackend {
    readonly kind: TerminalBackend;
    /** Rejects if the process could not be started. */
    spawn(options: PtySpawnOptions, callbacks: PtyCallbacks): Promise<PtyProcess>;
}
