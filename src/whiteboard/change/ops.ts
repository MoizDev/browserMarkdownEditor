import type { NotebookPaper } from '../../utils/paper';
import type { Sheet } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import type { JsonObject } from '../model/json';
import type { MediaEntry, MediaId } from '../model/media';
import type { Node, NodeRecord } from '../model/nodes';
import type { NextStyles, ToolId } from '../model/styles';
import type { RichFragment } from '../text/richText';

// change-and-history.md §2.1, H-1/H-2: immutable identity and preserved data are not setters.
type SetOpFor<N extends Node> = N extends Node ? {
    [K in Exclude<keyof N, 'id' | 'kind' | 'ext' | 'raw'>]: {
        readonly t: 'set';
        readonly id: NodeId;
        readonly key: K;
        readonly value: N[K];
    }
}[Exclude<keyof N, 'id' | 'kind' | 'ext' | 'raw'>] : never;
export type NodeSetOp = SetOpFor<Exclude<Node, { readonly kind: 'opaque' }>>;
export type NodePropKey = NodeSetOp['key'];
export type PropValue = NodeSetOp['value'];

export interface BoardProps {
    readonly 'host.paper': Readonly<NotebookPaper>;
    readonly 'host.pdf': JsonObject; // R-W5: writer bookkeeping, history-silent and non-dirtying.
    readonly 'ui.tool': ToolId;
    readonly 'ui.next': NextStyles;
    readonly 'ui.penWidth': number;
    readonly 'view.grid': boolean;
    readonly 'view.focusMode': boolean;
    readonly 'view.toolLock': boolean;
    readonly 'view.transparent': boolean;
    readonly 'view.debugMode': boolean;
}
export type BoardKey = keyof BoardProps;
export type BoardValue = BoardProps[BoardKey];
export type BoardOp = {
    [K in BoardKey]: { readonly t: 'board'; readonly key: K; readonly value: BoardProps[K] }
}[BoardKey];

export type Op =
    | { readonly t: 'create'; readonly node: NodeRecord }
    | { readonly t: 'delete'; readonly id: NodeId }
    | NodeSetOp
    | { readonly t: 'splice'; readonly id: NodeId; readonly key: 'text' | 'label'; readonly from: number; readonly to: number; readonly insert: RichFragment }
    | { readonly t: 'sheet'; readonly op: 'create'; readonly sheet: Sheet }
    | { readonly t: 'sheet'; readonly op: 'delete'; readonly id: SheetId }
    | { readonly t: 'sheet'; readonly op: 'set'; readonly id: SheetId; readonly key: 'name' | 'order'; readonly value: string }
    | BoardOp
    | { readonly t: 'media'; readonly op: 'add'; readonly entry: MediaEntry }
    | { readonly t: 'media'; readonly op: 'drop'; readonly id: MediaId };

export type TransactionOrigin = 'tool' | 'agent' | 'paste' | 'undo' | 'redo' | 'host';
export interface Transaction {
    readonly ops: readonly Op[];
    readonly origin: TransactionOrigin;
    readonly label: string;
}

export interface TouchedSet {
    readonly nodes: ReadonlySet<NodeId>;
    readonly sheets: ReadonlySet<SheetId>;
    readonly board: ReadonlySet<BoardKey>;
    readonly media: ReadonlySet<MediaId>;
}
export interface Applied {
    readonly forward: readonly Op[];
    readonly inverse: readonly Op[];
    readonly touched: TouchedSet;
    readonly dirtying: boolean;
    readonly recorded: boolean;
}

// H-3: a builder's savepoints are private to that builder and expire on commit/abort.
export interface TxBuilder {
    savepoint(): number;
    rollbackTo(savepoint: number): void;
    push(op: Op): void;
    commit(): Applied;
    abort(): void;
}
