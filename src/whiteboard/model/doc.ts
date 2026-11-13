import type { NotebookPaper } from '../../utils/paper';
import type { SheetId } from './ids';
import type { JsonObject } from './json';
import type { MediaTable } from './media';
import type { NodeTable } from './nodes';
import type { OrderKey } from './orderKey';
import type { UiBlock } from './styles';

// document-model.md §§1/6, M-1/M-6: pages and paper are host data, never nodes.
export type BoardKind = 'whiteboard' | 'notebook' | 'pdf-ink';
export interface Sheet {
    readonly id: SheetId;
    readonly name: string;
    readonly order: OrderKey;
}
export type SheetTable = ReadonlyMap<SheetId, Sheet>;

export interface ViewFlags {
    readonly grid: boolean;
    readonly focusMode: boolean;
    readonly toolLock: boolean;
    readonly transparent: boolean;
    readonly debugMode: boolean;
}

// R-W5 (contracts C2.2 v4.5): the PDF writer owns this opaque bookkeeping.
export type HostBlock =
    | { readonly kind: 'whiteboard' }
    | { readonly kind: 'notebook'; readonly paper: Readonly<NotebookPaper> }
    | { readonly kind: 'pdf-ink'; readonly pdf: JsonObject; readonly pages: readonly (readonly [number, number])[] };

export type PreservedBlock = JsonObject;

// Consumers read the live tables by reference (M-10). Only the model's apply path
// writes them; readonly reaches nested values so a scene cannot mutate an attachment.
export interface BoardDoc {
    readonly kind: BoardKind;
    readonly sheets: SheetTable;
    readonly nodes: NodeTable;
    readonly media: MediaTable;
    readonly ui: UiBlock;
    readonly view: ViewFlags;
    readonly host: HostBlock;
    readonly preserved: PreservedBlock;
    readonly rev: number; // Session-local; never persisted.
}
