import type { EditorState, Extension, TransactionSpec } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { DeferredSource, SourceOwner } from '../utils/documentBuffers';
import type { SessionAdapter } from '../utils/documentSessions';

export type MarkdownSessionUpdate = Pick<ViewUpdate, 'state' | 'startState' | 'transactions' | 'changes' | 'docChanged'>;

/** One immutable EditorState belongs to the document, never to its current pane. */
export interface MarkdownSessionAdapter extends SessionAdapter {
    readonly owner: SourceOwner;
    readonly state: EditorState;
    /** Installs the visible editor configuration once without dropping a cold edit's history. */
    configure(extensions: Extension, onUpdate?: (update: MarkdownSessionUpdate) => void): void;
    /** Detach unregisters this view only; it never releases the document session. */
    attach(view: EditorView): () => void;
    /** The baked-in view listener forwards updates to this same document owner. */
    observe(update: ViewUpdate): void;
    /** Visible and viewless edits share reporting, revisions and incremental state fields. */
    dispatch(...specs: TransactionSpec[]): void;
    checkpoint(): DeferredSource;
}

export type MarkdownSessionFactory = (owner: SourceOwner) => MarkdownSessionAdapter;

/** App-lifetime callbacks: cached states cannot retain a pane ref, path or handle. */
export interface MarkdownSessionHost {
    get(documentId: string): MarkdownSessionAdapter | undefined;
    ensure(documentId: string, create: MarkdownSessionFactory): MarkdownSessionAdapter | undefined;
    /** A first programmatic edit lazily creates its state; false means the document cannot be edited. */
    dispatch(documentId: string, spec: TransactionSpec): Promise<boolean>;
    pathOf(documentId: string): string | undefined;
    parentHandleOf(documentId: string): FileSystemDirectoryHandle | null;
}
