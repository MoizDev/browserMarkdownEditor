import type { NotebookPaper } from '../../utils/paper';
import type { BoardKind, Sheet } from '../model/doc';
import type { NodeId, SheetId } from '../model/ids';
import type { ExtBag, RawJson } from '../model/json';
import type { SampleRef } from '../model/samples';
import type { MediaEntry, MediaId } from '../model/media';
import type { Node, NodeRecord } from '../model/nodes';
import type { NextStyles, ToolId } from '../model/styles';
import type { RichFragment } from '../text/richText';

// change-and-history.md §2.1, H-1/H-2: immutable identity and preserved data are not setters.
// R-W23: explicit sets invalidate the native-token ext.raw entries named by
// model/fileFields.ts; CH-1 captures/restores ext in the transaction and its inverse.
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
    readonly 'host.pdf': RawJson; // R-W5/R-W19: opaque writer bookkeeping, history-silent and non-dirtying.
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

export type ContentOp =
    | { readonly t: 'create'; readonly node: NodeRecord }
    | { readonly t: 'delete'; readonly id: NodeId }
    | NodeSetOp
    | { readonly t: 'splice'; readonly id: NodeId; readonly key: 'text' | 'label'; readonly from: number; readonly to: number; readonly insert: RichFragment; readonly replaceBlocks?: true; readonly wholeBlocks?: true }
    | { readonly t: 'sheet'; readonly op: 'create'; readonly sheet: Sheet }
    | { readonly t: 'sheet'; readonly op: 'delete'; readonly id: SheetId }
    | { readonly t: 'sheet'; readonly op: 'set'; readonly id: SheetId; readonly key: 'name' | 'order'; readonly value: string }
    | BoardOp
    | { readonly t: 'media'; readonly op: 'add'; readonly entry: MediaEntry }
    | { readonly t: 'media'; readonly op: 'drop'; readonly id: MediaId; readonly restoreMissing?: true };

// R-W26: inspectable inverse data, not a string-property escape for tools/readers.
// Only apply constructs these when capturing an inverse; undo/redo replay them.
export type ExtTarget = 'node' | 'sheet' | 'media' | 'pen' | 'view' | 'paper' | 'host';
export interface ExtOp {
    readonly t: 'ext';
    readonly target: ExtTarget;
    readonly id?: string;
    readonly value: ExtBag | null;
}
export type Op = ContentOp | ExtOp;

export type TransactionOrigin = 'tool' | 'agent' | 'paste' | 'undo' | 'redo' | 'host' | 'revert';
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
export interface AppliedLease { release(): void }

export interface Applied {
    readonly forward: readonly Op[];
    readonly inverse: readonly Op[];
    /** Index-aligned inverse groups; concatenating them in reverse yields inverse. */
    readonly inverseGroups: readonly (readonly Op[])[];
    readonly touched: TouchedSet;
    readonly dirtying: boolean;
    readonly recorded: boolean;
    readonly sampleRefs: readonly SampleRef[];
    // C4 owns one receipt lease; a consumer retaining the receipt keeps another.
    // Releasing the last lease releases its immutable forward/inverse samples.
    retain(): AppliedLease;
    release(): void;
}

export interface OpSink { push(op: Op): void }
// H-3: a builder's savepoints are private to that builder and expire on commit/abort.
export interface TxBuilder extends OpSink {
    savepoint(): number;
    rollbackTo(savepoint: number): void;
    commit(): Applied;
    abort(): void;
}
export type CommandBuilder = Omit<TxBuilder, 'commit'>;

// change-and-history.md §2.2, H-4/H-6: the one policy table. Scene masks describe
// derived work; they do not grant another writer or put any derived data in undo.
export const SceneImpact = {
    none: 0, paint: 1, bounds: 2, children: 4, text: 8, descendants: 16,
    attachments: 32, ancestors: 64, sheets: 128, pages: 256, chrome: 512, geometry: 1024,
} as const;
export interface OpPolicy {
    readonly history: boolean;
    readonly dirty: 'always' | 'except-pdf' | 'never';
    readonly scene: number;
}
const NODE: OpPolicy = { history: true, dirty: 'always', scene: SceneImpact.paint };
const GEOMETRY: OpPolicy = { history: true, dirty: 'always', scene: SceneImpact.paint | SceneImpact.geometry
    | SceneImpact.bounds | SceneImpact.descendants | SceneImpact.attachments | SceneImpact.ancestors };
const TEXT: OpPolicy = { history: true, dirty: 'always', scene: SceneImpact.paint | SceneImpact.text
    | SceneImpact.bounds | SceneImpact.attachments | SceneImpact.ancestors };
const LAYOUT: OpPolicy = { history: true, dirty: 'always', scene: GEOMETRY.scene | SceneImpact.text };
const REPARENT: OpPolicy = { history: true, dirty: 'always', scene: GEOMETRY.scene | SceneImpact.children };
const ORDER: OpPolicy = { history: true, dirty: 'always', scene: SceneImpact.paint | SceneImpact.children | SceneImpact.ancestors };
const LOCK: OpPolicy = { history: true, dirty: 'always', scene: SceneImpact.chrome };
const OPACITY: OpPolicy = { history: true, dirty: 'always', scene: SceneImpact.paint | SceneImpact.descendants };
const PEN: OpPolicy = { history: false, dirty: 'except-pdf', scene: SceneImpact.chrome };
const TOOL: OpPolicy = { history: false, dirty: 'never', scene: SceneImpact.chrome };
const NONE: OpPolicy = { history: false, dirty: 'never', scene: SceneImpact.none };
const PAPER: OpPolicy = { history: true, dirty: 'always', scene: SceneImpact.pages | SceneImpact.bounds | SceneImpact.chrome };
const SHEET: OpPolicy = { history: true, dirty: 'always', scene: SceneImpact.sheets | SceneImpact.chrome };
const MEDIA: OpPolicy = { history: true, dirty: 'always', scene: SceneImpact.none };
const METADATA: OpPolicy = { history: true, dirty: 'always', scene: SceneImpact.none };
const PEN_METADATA: OpPolicy = { history: false, dirty: 'except-pdf', scene: SceneImpact.none };
const CREATE_DELETE: OpPolicy = { history: true, dirty: 'always', scene: SceneImpact.paint | SceneImpact.geometry
    | SceneImpact.bounds | SceneImpact.ancestors | SceneImpact.attachments | SceneImpact.children };

export const NODE_OP_POLICIES = {
    parent: REPARENT, order: ORDER, page: GEOMETRY, x: GEOMETRY, y: GEOMETRY, rotation: GEOMETRY,
    locked: LOCK, opacity: OPACITY, tool: GEOMETRY, samples: GEOMETRY, pressure: GEOMETRY,
    widthModel: GEOMETRY, geomVersion: GEOMETRY, fairTol: GEOMETRY, closed: GEOMETRY, width: GEOMETRY,
    sx: GEOMETRY, sy: GEOMETRY, color: NODE, fill: GEOMETRY, dash: GEOMETRY, complete: GEOMETRY,
    shape: GEOMETRY, w: LAYOUT, h: LAYOUT, growY: LAYOUT, labelColor: NODE, size: TEXT, font: TEXT,
    align: TEXT, valign: TEXT, label: TEXT, labelScale: LAYOUT, flipX: GEOMETRY, flipY: GEOMETRY,
    url: NODE, text: TEXT, autoSize: TEXT, scale: LAYOUT, fit: LAYOUT, route: GEOMETRY, start: GEOMETRY,
    end: GEOMETRY, bend: GEOMETRY, elbowMid: GEOMETRY, headStart: GEOMETRY, headEnd: GEOMETRY,
    labelAt: TEXT, points: GEOMETRY, spline: GEOMETRY, name: TEXT, media: NODE, crop: GEOMETRY,
    alt: NODE, inverted: NODE, playing: NODE, time: NODE, autoplay: NODE, preview: TEXT,
} as const satisfies Record<NodePropKey, OpPolicy>;
export const BOARD_OP_POLICIES = {
    'host.paper': PAPER, 'host.pdf': NONE, 'ui.tool': TOOL, 'ui.next': PEN, 'ui.penWidth': PEN,
    'view.grid': PEN, 'view.focusMode': PEN, 'view.toolLock': PEN, 'view.transparent': PEN, 'view.debugMode': PEN,
} as const satisfies Record<BoardKey, OpPolicy>;
export const EXT_OP_POLICIES = {
    node: METADATA, sheet: METADATA, media: METADATA, pen: PEN_METADATA, view: PEN_METADATA, paper: METADATA, host: NONE,
} as const satisfies Record<ExtTarget, OpPolicy>;
export const OP_POLICIES = {
    create: CREATE_DELETE, delete: CREATE_DELETE, splice: TEXT, sheet: SHEET, media: MEDIA,
} as const;

export function policyForOp(op: Op): OpPolicy {
    if (op.t === 'set') return NODE_OP_POLICIES[op.key];
    if (op.t === 'board') return BOARD_OP_POLICIES[op.key];
    if (op.t === 'ext') return EXT_OP_POLICIES[op.target];
    return OP_POLICIES[op.t];
}
export function opDirties(policy: OpPolicy, kind: BoardKind): boolean {
    return policy.dirty === 'always' || (policy.dirty === 'except-pdf' && kind !== 'pdf-ink');
}
