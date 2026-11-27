export type StartupStep = 'recent-vaults' | 'stored-vault' | 'permission' | 'record' | 'walk';

export interface StartupSnapshot {
    readonly step: StartupStep;
    readonly stepMs: number;
    readonly vault: string | null;
    readonly foldersRead: number;
    readonly filesFound: number;
    readonly waitingOn: string | null;
    readonly waitingMs: number;
}

export interface WalkProgress {
    begin(path: string): void;
    seen(path: string): void;
    end(path: string, files: number): void;
}

export const STARTUP_SLOW_MS = 4000;

interface Run {
    step: StartupStep;
    stepAt: number;
    vault: string | null;
    foldersRead: number;
    filesFound: number;
    pending: Map<string, number>;
    logTimer: ReturnType<typeof setTimeout> | undefined;
}

let run: Run | null = null;

const STEP_TEXT: Record<StartupStep, string> = {
    'recent-vaults': 'reading the recent vault list from browser storage (IndexedDB)',
    'stored-vault': 'reading the last vault from browser storage (IndexedDB)',
    permission: 'asking the browser whether access to the vault folder is still allowed',
    record: 'recording the vault in the recent vault list (browser storage)',
    walk: 'reading the vault’s folder list',
};

export function describeStartup(snapshot: StartupSnapshot): string {
    const parts = [`step "${snapshot.step}": ${STEP_TEXT[snapshot.step]} for ${(snapshot.stepMs / 1000).toFixed(1)} s`];
    if (snapshot.vault) parts.push(`vault "${snapshot.vault}"`);
    if (snapshot.step === 'walk') {
        parts.push(`${snapshot.foldersRead} folders read, ${snapshot.filesFound} files found`);
        if (snapshot.waitingOn !== null) parts.push(`waiting ${(snapshot.waitingMs / 1000).toFixed(1)} s on folder "${snapshot.waitingOn || '/'}"`);
    }
    return parts.join('; ');
}

export function readStartup(): StartupSnapshot | null {
    if (!run) return null;
    const now = performance.now();
    let waitingOn: string | null = null;
    let since = now;
    for (const [path, at] of run.pending) if (at < since) { since = at; waitingOn = path; }
    return {
        step: run.step, stepMs: now - run.stepAt, vault: run.vault,
        foldersRead: run.foldersRead, filesFound: run.filesFound, waitingOn, waitingMs: waitingOn === null ? 0 : now - since,
    };
}

export function beginStartup(step: StartupStep): void {
    finishStartup();
    const current: Run = { step, stepAt: performance.now(), vault: null, foldersRead: 0, filesFound: 0, pending: new Map(), logTimer: undefined };
    current.logTimer = setTimeout(() => {
        const snapshot = run === current ? readStartup() : null;
        if (snapshot) console.warn(`Vault startup is slow — ${describeStartup(snapshot)}.`);
    }, STARTUP_SLOW_MS);
    run = current;
}

export function startupStep(step: StartupStep, vault?: string): void {
    if (!run) return;
    run.step = step;
    run.stepAt = performance.now();
    if (vault !== undefined) run.vault = vault;
}

export function finishStartup(): void {
    if (run?.logTimer !== undefined) clearTimeout(run.logTimer);
    run = null;
}

export function startupWalk(): WalkProgress | undefined {
    const current = run;
    if (!current) return undefined;
    return {
        begin(path) { if (run === current) current.pending.set(path, performance.now()); },
        seen(path) { if (run === current && current.pending.has(path)) current.pending.set(path, performance.now()); },
        end(path, files) {
            if (run !== current) return;
            current.pending.delete(path);
            current.foldersRead++;
            current.filesFound += files;
        },
    };
}
