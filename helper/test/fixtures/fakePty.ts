// A PtyBackend with no process behind it, driven by the test.

import type { TerminalBackend, TerminalExit } from '../../../shared/vaultAgentProtocol.ts';
import type { PtyBackend, PtyCallbacks, PtyProcess, PtySpawnOptions } from '../../src/terminal/types.ts';

export class FakePty implements PtyProcess {
    readonly written: string[] = [];
    kills = 0;
    size: { cols: number; rows: number };
    private exited = false;

    constructor(readonly pid: number, readonly options: PtySpawnOptions, private readonly callbacks: PtyCallbacks) {
        this.size = { cols: options.cols, rows: options.rows };
    }

    write(data: string | Uint8Array): void {
        this.written.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
    }

    resize(cols: number, rows: number): void {
        this.size = { cols, rows };
    }

    kill(): void {
        this.kills++;
        // A real PTY reports the hang-up as an exit.
        this.end({ code: null, signal: 'SIGHUP' });
    }

    /** The shell prints. */
    emit(data: string | Uint8Array): void {
        if (this.exited) throw new Error('already exited');
        this.callbacks.onData(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    }

    end(exit: TerminalExit): void {
        if (this.exited) return;
        this.exited = true;
        this.callbacks.onExit(exit);
    }
}

export interface FakeBackend extends PtyBackend {
    readonly spawned: FakePty[];
    failNext: Error | null;
    kind: TerminalBackend;
}

export function fakeBackend(kind: TerminalBackend = 'inprocess'): FakeBackend {
    const backend: FakeBackend = {
        kind,
        spawned: [],
        failNext: null,
        async spawn(options, callbacks) {
            if (backend.failNext) {
                const e = backend.failNext;
                backend.failNext = null;
                throw e;
            }
            const pty = new FakePty(1000 + backend.spawned.length, options, callbacks);
            backend.spawned.push(pty);
            return pty;
        },
    };
    return backend;
}
