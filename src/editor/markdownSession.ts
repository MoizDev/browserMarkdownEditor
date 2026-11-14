import { isolateHistory } from '@codemirror/commands';
import { StateEffect, type EditorState, type Extension, type Text, type TransactionSpec } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import { docString } from './docCache';
import { externalReload, minimalChange } from './externalReload';
import { assetReferences } from '../utils/assets';
import type { MarkdownSessionAdapter, MarkdownSessionUpdate } from './markdownSession.types';
import type { ContentSource, DeferredSource, SourceOwner, SourceReportOptions } from '../utils/documentBuffers';

const sourceDocs = new WeakMap<DeferredSource, Text>();
export function markdownSourceDocument(source: ContentSource | undefined): Text | undefined {
    return source && typeof source !== 'string' ? sourceDocs.get(source) : undefined;
}

/** The adapter owns the immutable document and undo history, including while viewless. */
export function createMarkdownSession(owner: SourceOwner, initial: EditorState,
    latestSource: () => ContentSource | undefined): MarkdownSessionAdapter {
    let state = initial, revision = 0, configured = false, disposed = false;
    let initialSource = latestSource(), initialDoc: Text | undefined = initial.doc;
    let view: EditorView | undefined, pinned: DeferredSource | undefined;
    let onUpdate: ((update: MarkdownSessionUpdate) => void) | undefined;
    const listeners = new Set<(source: DeferredSource, options?: SourceReportOptions) => void>();
    const source = (): DeferredSource => {
        if (pinned) return pinned;
        const doc = state.doc, capturedRevision = revision;
        pinned = Object.freeze({ kind: 'deferred' as const, owner, revision: capturedRevision, read: () => docString(doc) });
        sourceDocs.set(pinned, doc);
        return pinned;
    };
    const observe = (update: MarkdownSessionUpdate) => {
        if (disposed) return;
        state = update.state;
        if (update.docChanged) {
            if (revision === Number.MAX_SAFE_INTEGER) throw new RangeError('Markdown revision exhausted');
            revision++;
            pinned = undefined;
            const captured = source();
            const fromDisk = update.transactions.some(transaction => transaction.annotation(externalReload));
            for (const listener of [...listeners]) listener(captured, fromDisk ? { fromDisk: true } : undefined);
        }
        onUpdate?.(update);
    };
    const dispatch = (...specs: TransactionSpec[]) => {
        if (disposed) return;
        if (view) { view.dispatch(...specs); return; }
        const transaction = state.update(...specs);
        observe({ state: transaction.state, startState: transaction.startState,
            transactions: [transaction], changes: transaction.changes, docChanged: transaction.docChanged });
    };
    return {
        owner,
        get state() { return state; },
        configure(extensions: Extension, listener?: (update: MarkdownSessionUpdate) => void) {
            if (disposed) throw new Error('Markdown session has been released');
            onUpdate = listener;
            if (configured) return;
            configured = true;
            state = state.update({ effects: StateEffect.appendConfig.of(extensions) }).state;
            if (view) view.setState(state);
        },
        attach(next: EditorView) {
            if (disposed) throw new Error('Markdown session has been released');
            if (view && view !== next) throw new Error('A Markdown document already has an attached view');
            view = next;
            if (next.state !== state) next.setState(state);
            return () => { if (view === next) { state = next.state; view = undefined; } };
        },
        observe(update: ViewUpdate) { if (update.view === view) observe(update); },
        dispatch,
        journalDelta() {
            const text = docString(state.doc);
            return { payload: Object.freeze({ kind: 'markdown', text }), copy: text, mediaRefs: [...assetReferences(text)] };
        },
        recover(payload) {
            if (!payload || typeof payload !== 'object' || !('kind' in payload) || payload.kind !== 'markdown'
                || !('text' in payload) || typeof payload.text !== 'string') {
                throw new Error('Invalid Markdown recovery payload');
            }
            const change = minimalChange(docString(state.doc), payload.text);
            if (change) dispatch({ changes: change, userEvent: 'input.recover', annotations: isolateHistory.of('full') });
        },
        hasPendingEdits() {
            if (disposed) return false;
            const current = latestSource();
            if (current === initialSource && state.doc === initialDoc) return false;
            initialSource = undefined;
            initialDoc = undefined;
            return markdownSourceDocument(current) !== state.doc;
        },
        checkpoint: source,
        acknowledge() {},
        onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        dispose() { disposed = true; view = undefined; onUpdate = undefined; listeners.clear(); initialSource = undefined; initialDoc = undefined; },
    };
}
