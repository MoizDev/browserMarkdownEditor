// What the vault's startup is doing right now, for the loading screen and the console.
//
// Measured: every step of reopening the last vault awaits a browser call with no deadline (IndexedDB, a permission
// query, enumerating each folder of the tree), and a call that never settles — a folder on a cloud drive that is not
// downloaded, a network share or a sleeping disk, another tab holding the browser's storage — left "Loading vault..."
// up for good, with nothing on screen or in the console to say which. FileSystemContext reports each step here; the
// loading screen reads it to name the step after a few seconds and offer a way on, and it is logged ONCE, so a
// screenshot or a console paste from someone stuck identifies the call.
//
// A plain mutable store polled by its one reader (the screen ticks anyway, to show elapsed time), because the walk
// reports every folder it opens and a listener per report would be thousands of wake-ups on a big vault.

export type StartupStep = 'recent-vaults' | 'stored-vault' | 'permission' | 'record' | 'walk';

export interface StartupSnapshot {
    readonly step: StartupStep;
    /** ms the current step has been running. */
    readonly stepMs: number;
    readonly vault: string | null;
    readonly foldersRead: number;
    readonly filesFound: number;
    /** The folder that has gone longest without answering — since it began listing, or since the last entry it
     *  yielded — vault-relative ('' is the vault's own top level). */
    readonly waitingOn: string | null;
    readonly waitingMs: number;
}

/** What a walk reports per folder: the folder starts listing, yields each entry, then finishes with this many files. */
export interface WalkProgress {
    begin(path: string): void;
    /** The folder answered with another entry. A big or slow folder that keeps answering is not one that has stopped:
     *  timed from `begin` alone, a folder of a few thousand files on a slow disk read as "not answering". */
    seen(path: string): void;
    end(path: string, files: number): void;
}

/** When the screen starts naming the step and offering a way on. */
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

/** A startup (the mount's reopen of the last vault, or "Restore 'X'") begins; replaces any earlier one. */
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

/** The current startup's walk reporter, or undefined when no startup is running (an ordinary refresh). */
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
