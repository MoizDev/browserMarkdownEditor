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
    /** The height of one empty line at the current font and size, in layout units, or null before its faces have loaded. */
    lineHeight(): number | null;
}
export interface TextEditingManagerPorts {
    readonly session: EditableSessionPort;
    /** Produce a normal create transaction, including host page growth/anchoring if needed. */
    createText(x: number, y: number, width: number | null, seed?: string): { readonly node: TextNode; readonly transaction: Transaction };
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
    /** Close on click-away or return a gesture owner for selection inside the edited text. `clicks` is the press's place in a
     * run of clicks (2 for a double-click), counted by the board: a pointerdown's own `detail` is always 0. */
    pointer(sample: RealSample, modifiers: Modifiers, event: PointerEvent, clicks?: number): PointerRoute<unknown> | null;
    /** Invalidate a deferred hit without closing an existing editor. */
    cancelPending(): boolean;
    flush(): void;
}
/** A double-click's target. Editing it selects all its text (catalogue S§12), so no caret offset is resolved. */
export type TextInputHit = { readonly node: NodeId } | 'blank' | null;
export interface TextInputRoutingPorts {
    readonly manager: TextEditingManager;
    selected(): NodeId | null;
    /** null means a non-text hit; 'blank' permits double-click creation. */
    locate(clientX: number, clientY: number, signal: AbortSignal): TextInputHit | Promise<TextInputHit>;
    /** Capture document/session, layout and camera generations BEFORE requesting a hit. */
    captureHit(): () => boolean;
    isCurrent(): boolean;
    error(error: unknown): void;
    containsActive(clientX: number, clientY: number): boolean;
    /** The open edit was started by a click on the selected text a moment ago and still has the caret that click put: a second
     * click now completes a double-click on that text, which edits all of its words (catalogue S§12). */
    openedByClick?(): boolean;
    hitHandle(clientX: number, clientY: number): 'anchor' | 'focus' | null;
    clientToWorld(clientX: number, clientY: number): { readonly x: number; readonly y: number };
    worldToClient(x: number, y: number): { readonly x: number; readonly y: number };
}
export interface TextEditingManager {
    readonly current: TextEditBinding | null;
    /** Double click/Enter on a selected text, sticky, figure, connector, or frame title. */
    start(node: NodeId, selection?: EditSelection): boolean;
    /** Text tool click/column drag; returns the new node id if created. */
    /** `seed` is the new text's first words; they are selected, so typing replaces them. */
    create(x: number, y: number, width: number | null, seed?: string): NodeId | null;
    /** A printable key on a selected supported node starts editing and types it. */
    type(node: NodeId, text: string): boolean;
    refresh(): void;
    /** A pane hide or detach commits a live IME composition before releasing its input host. */
    close(commitComposition?: boolean): void;
    dispose(): void;
}
