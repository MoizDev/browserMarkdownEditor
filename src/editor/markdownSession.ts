import { EditorState, StateEffect, type Extension, type Text, type TransactionSpec } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import { docString } from './docCache';
import { externalReload } from './externalReload';
import type { MarkdownSessionAdapter, MarkdownSessionUpdate } from './markdownSession.types';
import type { DeferredSource, SourceOwner, SourceReportOptions } from '../utils/documentBuffers';

/** The adapter holds the immutable document and its undo history while no pane exists. */
export function createMarkdownSession(owner: SourceOwner, initial: EditorState,
    isReported: (doc: Text) => boolean): MarkdownSessionAdapter {
    let state = initial;
    let revision = 0;
    let configured = false;
    let view: EditorView | undefined;
    let onUpdate: ((update: MarkdownSessionUpdate) => void) | undefined;
    const listeners = new Set<(source: DeferredSource, options?: SourceReportOptions) => void>();
    const source = (): DeferredSource => {
        const doc = state.doc, capturedRevision = revision;
        return Object.freeze({ kind: 'deferred' as const, owner, revision: capturedRevision, read: () => docString(doc) });
    };
    const observe = (update: MarkdownSessionUpdate) => {
        state = update.state;
        if (update.docChanged) {
            revision++;
            const captured = source();
            const fromDisk = update.transactions.some(transaction => transaction.annotation(externalReload));
            for (const listener of [...listeners]) listener(captured, fromDisk ? { fromDisk: true } : undefined);
        }
        onUpdate?.(update);
    };
    return {
        owner,
        get state() { return state; },
        configure(extensions: Extension, listener?: (update: MarkdownSessionUpdate) => void) {
            onUpdate = listener;
            if (configured) return;
            configured = true;
            const transaction = state.update({ effects: StateEffect.appendConfig.of(extensions) });
            state = transaction.state;
            if (view) view.setState(state);
        },
        attach(next: EditorView) {
            if (view && view !== next) throw new Error('A Markdown document already has an attached view');
            view = next;
            if (next.state !== state) next.setState(state);
            return () => { if (view === next) { state = next.state; view = undefined; } };
        },
        observe(update: ViewUpdate) { observe(update); },
        dispatch(...specs: TransactionSpec[]) {
            if (view) { view.dispatch(...specs); return; }
            const transaction = state.update(...specs);
            observe({ state: transaction.state, startState: transaction.startState,
                transactions: [transaction], changes: transaction.changes, docChanged: transaction.docChanged });
        },
        hasPendingEdits: () => !isReported(state.doc),
        checkpoint: source,
        acknowledge() {},
        onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
}
