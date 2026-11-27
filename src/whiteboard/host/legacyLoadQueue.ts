export const LEGACY_LOAD_MAX_BYTES = 256 * 1024 * 1024;

export type LegacyLoadPhase = 'waiting' | 'loading';

interface Waiter { readonly key: string; readonly order: number; readonly urgent: boolean; start(): void }

const waiting = new Set<Waiter>();
const phases = new Map<string, Map<object, LegacyLoadPhase>>();
const listeners = new Set<() => void>();
const shown = new Map<string, number>();
let running = 0, serial = 0;

function setPhase(key: string, token: object, phase: LegacyLoadPhase | null): void {
    let entries = phases.get(key);
    if (phase) { if (!entries) phases.set(key, entries = new Map()); entries.set(token, phase); }
    else if (entries) { entries.delete(token); if (!entries.size) phases.delete(key); }
    for (const listener of [...listeners]) listener();
}

function pump(): void {
    const rank = (waiter: Waiter) => waiter.urgent || (shown.get(waiter.key) ?? 0) > 0 ? 0 : 1;
    while (running < 1 && waiting.size) {
        let next: Waiter | undefined;
        for (const waiter of waiting) {
            if (!next || rank(waiter) < rank(next) || (rank(waiter) === rank(next) && waiter.order < next.order)) next = waiter;
        }
        waiting.delete(next!);
        running++;
        next!.start();
    }
}

export function showLegacyLoadTarget(key: string): () => void {
    shown.set(key, (shown.get(key) ?? 0) + 1);
    let live = true;
    return () => {
        if (!live) return;
        live = false;
        const left = (shown.get(key) ?? 1) - 1;
        if (left > 0) shown.set(key, left); else shown.delete(key);
    };
}

export function legacyLoadPhase(key: string): LegacyLoadPhase | null {
    const entries = phases.get(key);
    if (!entries) return null;
    for (const phase of entries.values()) if (phase === 'loading') return phase;
    return 'waiting';
}

export function subscribeLegacyLoadPhase(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export async function admitLegacyLoad(options: { key: string; bytes?: number; signal: AbortSignal; urgent?: boolean }): Promise<() => void> {
    const { key, signal } = options;
    signal.throwIfAborted();
    if (options.bytes !== undefined && options.bytes > LEGACY_LOAD_MAX_BYTES) {
        const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
        throw new RangeError(`This file is ${mb(options.bytes)} MB; a file from an older version of the app opens only up to ${mb(LEGACY_LOAD_MAX_BYTES)} MB.`);
    }
    const token = {};
    setPhase(key, token, 'waiting');
    try {
        await new Promise<void>((resolve, reject) => {
            const waiter: Waiter = { key, order: ++serial, urgent: options.urgent === true, start: () => { signal.removeEventListener('abort', abort); resolve(); } };
            function abort() { waiting.delete(waiter); reject(signal.reason ?? new DOMException('Legacy load cancelled', 'AbortError')); }
            signal.addEventListener('abort', abort, { once: true });
            waiting.add(waiter);
            pump();
        });
    } catch (error) { setPhase(key, token, null); throw error; }
    setPhase(key, token, 'loading');
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        signal.removeEventListener('abort', release);
        running--;
        setPhase(key, token, null);
        pump();
    };
    signal.addEventListener('abort', release, { once: true });
    return release;
}
