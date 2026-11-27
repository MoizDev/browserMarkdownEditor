import type { EditorState, Extension, TransactionSpec } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { DeferredSource, SourceOwner } from '../utils/documentBuffers';
import type { SessionAdapter } from '../utils/documentSessions';

export type MarkdownSessionUpdate = Pick<ViewUpdate, 'state' | 'startState' | 'transactions' | 'changes' | 'docChanged'>;

export interface MarkdownSessionAdapter extends SessionAdapter {
    readonly owner: SourceOwner;
    readonly state: EditorState;
    configure(extensions: Extension, onUpdate?: (update: MarkdownSessionUpdate) => void): void;
    attach(view: EditorView): () => void;
    observe(update: ViewUpdate): void;
    dispatch(...specs: TransactionSpec[]): void;
    checkpoint(): DeferredSource;
}

export type MarkdownSessionFactory = (owner: SourceOwner) => MarkdownSessionAdapter;

export interface MarkdownSessionHost {
    get(documentId: string): MarkdownSessionAdapter | undefined;
    ensure(documentId: string, create: MarkdownSessionFactory): MarkdownSessionAdapter | undefined;
    dispatch(documentId: string, spec: TransactionSpec): Promise<boolean>;
    pathOf(documentId: string): string | undefined;
    parentHandleOf(documentId: string): FileSystemDirectoryHandle | null;
}
