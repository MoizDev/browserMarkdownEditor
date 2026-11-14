import type { Transaction } from '../../change/ops';
import type { TextNode } from '../../model/nodes';
import type { NodeId, ParentId } from '../../model/ids';
import type { BoardDoc } from '../../model/doc';
import type { Op } from '../../change/ops';
import type { EditSelection } from './host';
import type { EditableSessionPort, TextEditBinding, TextEditBindingOptions } from './bindingTypes';
import type { Modifiers, RealSample } from '../../input/tool';
import type { PointerRoute } from '../../input/pointerRouter';

export interface TextCreationPorts {
    readonly doc: BoardDoc;
    /** Converts board-world coordinates into the active parent's local/page coordinates. */
    place(x: number, y: number): { readonly parent: ParentId; readonly page: number; readonly x: number; readonly y: number; readonly before?: readonly Op[] };
    zoom(): number;
    dynamicSize(): boolean;
}
export interface TextEditingManagerPorts {
    readonly session: EditableSessionPort;
    /** Produce a normal create transaction, including host page growth/anchoring if needed. */
    createText(x: number, y: number, width: number | null): { readonly node: TextNode; readonly transaction: Transaction };
    select(node: NodeId): void;
    /** Returns pane-owned transforms, renderer paint, clipboard/menu and chrome callbacks. */
    binding(node: NodeId, key: 'text' | 'label' | 'name', selection: EditSelection, creationToken?: number): TextEditBindingOptions;
    error(error: unknown): void;
}
/** Pane input bridge; hit testing and selected-node lookup stay in the viewer. */
export interface TextInputBridge {
    type(text: string): boolean;
    enter(): boolean;
    doubleClick(clientX: number, clientY: number): boolean;
    /** Close on click-away or return a gesture owner for selection inside the edited text. */
    pointer(sample: RealSample, modifiers: Modifiers, event: PointerEvent): PointerRoute<unknown> | null;
    flush(): void;
}
export interface TextInputRoutingPorts {
    readonly manager: TextEditingManager;
    selected(): NodeId | null;
    /** null means a non-text hit; 'blank' permits double-click creation. */
    locate(clientX: number, clientY: number): { readonly node: NodeId; readonly offset: number } | 'blank' | null;
    containsActive(clientX: number, clientY: number): boolean;
    clientToWorld(clientX: number, clientY: number): { readonly x: number; readonly y: number };
    worldToClient(x: number, y: number): { readonly x: number; readonly y: number };
}
export interface TextEditingManager {
    readonly current: TextEditBinding | null;
    /** Double click/Enter on a selected text, sticky, figure, connector, or frame title. */
    start(node: NodeId, selection?: EditSelection): boolean;
    /** Text tool click/column drag; returns the new node id if created. */
    create(x: number, y: number, width: number | null): NodeId | null;
    /** A printable key on a selected supported node starts editing and types it. */
    type(node: NodeId, text: string): boolean;
    refresh(): void;
    /** A pane hide or detach commits a live IME composition before releasing its input host. */
    close(commitComposition?: boolean): void;
    dispose(): void;
}
