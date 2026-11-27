export const PERF_PLANT = 'bme-perf-hooks-plant-7f3a';

type PerfRoot = Record<string, unknown> & { readonly plant?: string };

export function perfRoot(): PerfRoot {
    const w = window as unknown as { __perf?: PerfRoot };
    w.__perf ??= { plant: PERF_PLANT };
    return w.__perf;
}

export interface VaultReport {
    seq: number;
    t: number;
    op: 'write' | 'trash' | 'trash-done' | 'move' | 'retire' | 'restore' | 'empty-trash';
    path: string;
    to?: string;
    opens?: number;
    caller: string;
}

interface PerfVault extends EventTarget { reports(): VaultReport[] }

let seq = 0;
const log: VaultReport[] = [];

export function perfVault(): PerfVault {
    const root = perfRoot();
    if (!root.vault) {
        const target = new EventTarget() as PerfVault;
        target.reports = () => log.slice();
        root.vault = target;
    }
    return root.vault as PerfVault;
}

export function reportVault(report: Omit<VaultReport, 'seq' | 't'>): number {
    const full: VaultReport = { ...report, seq: ++seq, t: performance.now() };
    log.push(full);
    perfVault().dispatchEvent(new CustomEvent(full.op, { detail: full }));
    return full.seq;
}
