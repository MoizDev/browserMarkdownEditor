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
    place(x: number, y: number): { readonly parent: ParentId; readonly page: number; readonly x: number; readonly y: number; readonly before?: readonly Op[] };
    zoom(): number;
    dynamicSize(): boolean;
    lineHeight(): number | null;
}
export interface TextEditingManagerPorts {
    readonly session: EditableSessionPort;
    createText(x: number, y: number, width: number | null, seed?: string): { readonly node: TextNode; readonly transaction: Transaction };
    select(node: NodeId): void;
    binding(node: NodeId, key: 'text' | 'label' | 'name', selection: EditSelection, creationToken?: number): TextEditBindingOptions;
    error(error: unknown): void;
}
export interface TextInputBridge {
    type(text: string): boolean;
    enter(): boolean;
    doubleClick(clientX: number, clientY: number): boolean;
    pointer(sample: RealSample, modifiers: Modifiers, event: PointerEvent, clicks?: number): PointerRoute<unknown> | null;
    cancelPending(): boolean;
    flush(): void;
}
export type TextInputHit = { readonly node: NodeId } | 'blank' | null;
export interface TextInputRoutingPorts {
    readonly manager: TextEditingManager;
    selected(): NodeId | null;
    locate(clientX: number, clientY: number, signal: AbortSignal): TextInputHit | Promise<TextInputHit>;
    captureHit(): () => boolean;
    isCurrent(): boolean;
    error(error: unknown): void;
    containsActive(clientX: number, clientY: number): boolean;
    openedByClick?(): boolean;
    hitHandle(clientX: number, clientY: number): 'anchor' | 'focus' | null;
    clientToWorld(clientX: number, clientY: number): { readonly x: number; readonly y: number };
    worldToClient(x: number, y: number): { readonly x: number; readonly y: number };
}
export interface TextEditingManager {
    readonly current: TextEditBinding | null;
    start(node: NodeId, selection?: EditSelection): boolean;
    create(x: number, y: number, width: number | null, seed?: string): NodeId | null;
    type(node: NodeId, text: string): boolean;
    refresh(): void;
    close(commitComposition?: boolean): void;
    dispose(): void;
}
