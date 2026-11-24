// The PtyBackend that talks to the frozen `vaultagent-pty` host (macOS, installed
// helpers), one unix-socket connection per shell. Why a separate process at all:
// helper/ptyhost/ptyhost.c. The wire format is documented there; this is its
// client — binary frames `[u8 type][u32 BE length][payload]`, no JSON.

import { constants } from 'node:os';
import type { Socket } from 'bun';
import type { TerminalExit } from '../../../shared/vaultAgentProtocol.ts';
import type { PtyBackend, PtyCallbacks, PtyProcess, PtySpawnOptions } from './types.ts';

const C_SPAWN = 1, C_INPUT = 2, C_RESIZE = 3, C_KILL = 4;
const H_SPAWNED = 1, H_OUTPUT = 2, H_EXIT = 3, H_ERROR = 4;

/** The host's own bound on a frame; a bigger one is a protocol error there. */
const MAX_FRAME = 4 * 1024 * 1024;
/** A host that does not close after a kill frame within this is cut off. Its
 *  own grace is 2 s (SIGHUP, then SIGKILL on the group). */
const KILL_DEADLINE_MS = 4000;

const SIGNAL_NAMES = new Map<number, string>(Object.entries(constants.signals).map(([name, n]) => [n, name]));

function frame(type: number, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(5 + payload.length);
    out[0] = type;
    new DataView(out.buffer).setUint32(1, payload.length);
    out.set(payload, 5);
    return out;
}

function spawnPayload(o: PtySpawnOptions): Uint8Array {
    const argv = [o.argv0 ?? o.file, ...o.args];
    const env = Object.entries(o.env).map(([k, v]) => `${k}=${v}`);
    const strings = [o.cwd, o.file, ...argv, ...env];
    // A NUL would end a string early on the host and shift every later one.
    if (strings.some(s => s.includes('\0'))) throw new Error('a NUL byte cannot be passed to the PTY host');
    const enc = new TextEncoder();
    const parts = strings.map(s => enc.encode(`${s}\0`));
    const head = new Uint8Array(12);
    const dv = new DataView(head.buffer);
    dv.setUint16(0, o.cols);
    dv.setUint16(2, o.rows);
    dv.setUint32(4, argv.length);
    dv.setUint32(8, env.length);
    const out = new Uint8Array(12 + parts.reduce((n, p) => n + p.length, 0));
    out.set(head);
    let at = 12;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

export function ptyHostBackend(socketPath: string): PtyBackend {
    return {
        kind: 'ptyhost',
        async spawn(options, callbacks) {
            return await connectSession(socketPath, options, callbacks);
        },
    };
}

function connectSession(socketPath: string, options: PtySpawnOptions, cb: PtyCallbacks): Promise<PtyProcess> {
    const spawnFrame = frame(C_SPAWN, spawnPayload(options));
    return new Promise<PtyProcess>((resolve, reject) => {
        let sock: Socket | null = null;
        let rx: Uint8Array = new Uint8Array(0);
        let tx: Uint8Array | null = null;   // what the socket would not take yet
        let pid = 0;
        let spawned = false;
        let exited = false;
        let killed = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = (exit: TerminalExit) => {
            if (exited) return;
            exited = true;
            clearTimeout(killTimer);
            cb.onExit(exit);
        };
        const fail = (message: string) => {
            if (!spawned) reject(new Error(message));
            sock?.terminate();
        };

        /** Write `data`, keeping what the socket refuses for `drain`. */
        const send = (data: Uint8Array) => {
            if (!sock || exited) return;
            if (tx) {
                const merged = new Uint8Array(tx.length + data.length);
                merged.set(tx);
                merged.set(data, tx.length);
                tx = merged;
                return;
            }
            const n = sock.write(data);
            if (n < data.length) tx = data.subarray(Math.max(n, 0));
        };

        const onFrame = (type: number, payload: Uint8Array) => {
            const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            if (type === H_SPAWNED && payload.length === 4 && !spawned) {
                pid = dv.getUint32(0);
                spawned = true;
                resolve({
                    pid,
                    write(data) {
                        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
                        if (!killed && bytes.length) send(frame(C_INPUT, bytes));
                    },
                    resize(cols, rows) {
                        if (killed) return;
                        const p = new Uint8Array(4);
                        const pv = new DataView(p.buffer);
                        pv.setUint16(0, cols);
                        pv.setUint16(2, rows);
                        send(frame(C_RESIZE, p));
                    },
                    kill() {
                        if (killed || exited) return;
                        killed = true;
                        send(frame(C_KILL, new Uint8Array(0)));
                        sock?.end();
                        // Our own end() closes the socket, so `close` reports the end at once
                        // (measured: 0–1 ms) — not when the shell is gone. The host does the
                        // hang-up, 2 s grace and SIGKILL of the group on its own, socket or not.
                        // This timer is only the backstop for an end() that never completes.
                        killTimer = setTimeout(() => sock?.terminate(), KILL_DEADLINE_MS);
                    },
                });
            } else if (type === H_OUTPUT && spawned && !killed) {
                if (payload.length) cb.onData(payload.slice());   // a copy: `payload` is a view into the receive buffer
            } else if (type === H_EXIT && payload.length === 8 && spawned) {
                const code = dv.getInt32(0);
                const signal = dv.getInt32(4);
                finish(signal ? { code: null, signal: SIGNAL_NAMES.get(signal) ?? `SIG${signal}` } : { code, signal: null });
                sock?.end();
            } else if (type === H_ERROR) {
                fail(new TextDecoder().decode(payload) || 'the PTY host refused the session');
            } else {
                fail('unexpected frame from the PTY host');
            }
        };

        const onData = (chunk: Uint8Array) => {
            if (rx.length) {
                const merged = new Uint8Array(rx.length + chunk.length);
                merged.set(rx);
                merged.set(chunk, rx.length);
                rx = merged;
            } else {
                rx = chunk;
            }
            let off = 0;
            while (rx.length - off >= 5) {
                const len = new DataView(rx.buffer, rx.byteOffset + off + 1, 4).getUint32(0);
                if (len > MAX_FRAME) return fail('oversized frame from the PTY host');
                if (rx.length - off < 5 + len) break;
                onFrame(rx[off], rx.subarray(off + 5, off + 5 + len));
                off += 5 + len;
            }
            // Copy the tail: the chunk Bun handed us is only valid inside this callback.
            rx = rx.length === off ? new Uint8Array(0) : rx.slice(off);
        };

        Bun.connect({
            unix: socketPath,
            socket: {
                open(s) {
                    sock = s;
                    send(spawnFrame);
                },
                data(_s, chunk) {
                    onData(chunk);
                },
                drain() {
                    if (!sock || !tx) return;
                    const pending = tx;
                    tx = null;
                    const n = sock.write(pending);
                    if (n < pending.length) tx = pending.subarray(Math.max(n, 0));
                },
                close() {
                    if (!spawned) reject(new Error('the PTY host closed the connection'));
                    // No exit frame: a kill (ours) or a host that died. Either way the shell is gone.
                    finish({ code: null, signal: killed ? 'SIGHUP' : null });
                },
                error(_s, e) {
                    if (!spawned) reject(e);
                },
                connectError(_s, e) {
                    reject(e);
                },
            },
        }).catch(reject);
    });
}

/**
 * Whether a PTY host answers on `socketPath`: connect, send a kill frame (which a
 * host with no session answers by simply ending the connection) and wait for the
 * close. A connect alone would also succeed against a hung accept loop (the
 * kernel queues it); a stale socket file refuses it.
 */
export async function probePtyHost(socketPath: string, timeoutMs = 1500): Promise<boolean> {
    return await new Promise<boolean>(resolve => {
        let sock: Socket | null = null;
        let done = false;
        const settle = (ok: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            sock?.terminate();
            resolve(ok);
        };
        const timer = setTimeout(() => settle(false), timeoutMs);
        Bun.connect({
            unix: socketPath,
            socket: {
                open(s) {
                    sock = s;
                    s.write(frame(C_KILL, new Uint8Array(0)));
                },
                data() {},
                close() {
                    settle(true);
                },
                error() {
                    settle(false);
                },
                connectError() {
                    settle(false);
                },
            },
        }).catch(() => settle(false));
    });
}
