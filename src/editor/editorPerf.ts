import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { perfRoot } from '../utils/perfHooks';

let latestState: EditorState | null = null;

const editor = {
    transactions: 0,
    windows: 0,
    windowChars: 0,
    fullRenders: { create: 0, mode: 0, coverage: 0, revGap: 0, error: 0 },
    l1Ms: null,
    l3Ms: { total: 0, samples: [] as number[] },
    widgetsBuilt: 0,
    slicedChars: 0,
    get parse() {
        try {
            return latestState
                ? { treeLength: syntaxTree(latestState).length, idle: syntaxTreeAvailable(latestState, latestState.doc.length) }
                : { treeLength: 0, idle: false };
        } catch {
            return { treeLength: 0, idle: false };
        }
    },
    reset() {
        editor.transactions = editor.windows = editor.windowChars = editor.widgetsBuilt = editor.slicedChars = 0;
        for (const reason of ['create', 'mode', 'coverage', 'revGap', 'error'] as const) editor.fullRenders[reason] = 0;
        editor.l3Ms.total = 0;
        editor.l3Ms.samples.length = 0;
    },
};

function publish(): void {
    perfRoot().editor = editor;
}

/** Every caller is guarded by __BME_BENCH__; failures never enter the editor. */
export function markEditorModeRender(): void { /* The field counts the mode transaction itself. */ }

export function countEditorTransaction(state: EditorState): void {
    try {
        latestState = state;
        editor.transactions++;
        publish();
    } catch { /* Measurement cannot interrupt a transaction. */ }
}

export function countEditorWidget(): void {
    try {
        editor.widgetsBuilt++;
        publish();
    } catch { /* Measurement cannot interrupt widget construction. */ }
}

/** Time only the existing pass; preserve its result, exceptions and widget identities. */
export function measureEditorRender<T>(state: EditorState, reason: 'create' | 'mode' | 'coverage' | 'revGap' | 'error' | null,
    windowChars: number, render: () => T): T {
    let started: number | undefined;
    try {
        latestState = state;
        if (reason) editor.fullRenders[reason]++;
        editor.windows++;
        editor.windowChars += windowChars;
        publish();
        started = performance.now();
    } catch { /* Measurement cannot prevent a decoration pass. */ }
    const result = render();
    try {
        if (started !== undefined) {
            const elapsed = performance.now() - started;
            editor.l3Ms.total += elapsed;
            editor.l3Ms.samples.push(elapsed);
        }
    } catch { /* Measurement cannot change a decoration result. */ }
    return result;
}
