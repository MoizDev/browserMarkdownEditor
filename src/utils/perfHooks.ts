// Measurement hooks of contract C9: benchmark builds only. Every call site is
// inside `if (__BME_BENCH__)`, so production and development builds drop this
// module entirely; the production-bundle scan looks for PERF_PLANT to prove it.
// It measures and reports. It asserts nothing and changes no behaviour.

export const PERF_PLANT = 'bme-perf-hooks-plant-7f3a';

type PerfRoot = Record<string, unknown> & { readonly plant?: string };

/** `window.__perf`, created on first use; each stream hangs its own key on it. */
export function perfRoot(): PerfRoot {
    const w = window as unknown as { __perf?: PerfRoot };
    w.__perf ??= { plant: PERF_PLANT };
    return w.__perf;
}

/**
 * One operation the app started, or the completion of its trash copy, so a run
 * can match observed directory creation, `createWritable` and `removeEntry` to a
 * sanctioned caller (X-FUNNEL, X-NODESTROY).
 */
export interface VaultReport {
    seq: number;
    t: number;                  // performance.now() when the operation started
    op: 'write' | 'trash' | 'trash-done' | 'move' | 'retire' | 'restore' | 'empty-trash';
    path: string;               // vault-root-relative (utils/paths.ts), the entry acted on
    to?: string;                // known destination; trash names arrive on trash-done
    opens?: number;             // trash-done: seq of the operation's opening report
    caller: string;             // which sanctioned path started it, e.g. 'flushTab', 'rotate', 'trash'
}

interface PerfVault extends EventTarget { reports(): VaultReport[] }

let seq = 0;
const log: VaultReport[] = [];

/** `window.__perf.vault`: an EventTarget (one event per report, type = op) plus the whole log. */
export function perfVault(): PerfVault {
    const root = perfRoot();
    if (!root.vault) {
        const target = new EventTarget() as PerfVault;
        target.reports = () => log.slice();
        root.vault = target;
    }
    return root.vault as PerfVault;
}

/** Publish an opening or trash-copy completion; return this record's seq for pairing. */
export function reportVault(report: Omit<VaultReport, 'seq' | 't'>): number {
    const full: VaultReport = { ...report, seq: ++seq, t: performance.now() };
    log.push(full);
    perfVault().dispatchEvent(new CustomEvent(full.op, { detail: full }));
    return full.seq;
}
