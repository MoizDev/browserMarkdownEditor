import type { TerminalBackend, TerminalExit } from '../../../shared/vaultAgentProtocol.ts';

export interface PtySpawnOptions {
    file: string;
    args: string[];
    argv0?: string;
    env: Record<string, string>;
    cwd: string;
    cols: number;
    rows: number;
}

export interface PtyCallbacks {
    onData(bytes: Uint8Array): void;
    onExit(exit: TerminalExit): void;
}

export interface PtyProcess {
    readonly pid: number;
    write(data: string | Uint8Array): void;
    resize(cols: number, rows: number): void;
    kill(): void;
}

export interface PtyBackend {
    readonly kind: TerminalBackend;
    spawn(options: PtySpawnOptions, callbacks: PtyCallbacks): Promise<PtyProcess>;
}
