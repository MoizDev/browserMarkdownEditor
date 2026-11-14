import type { Applied, Transaction } from '../../change/ops';
import type { HistoryController } from '../../change/historyTypes';
import type { BoardDoc } from '../../model/doc';
import type { Node } from '../../model/nodes';
import type { NodeId } from '../../model/ids';
import type { ChangeNotice } from '../../session/BoardSession';
import type { FaceTable, TextLayoutEngine, TextLayoutRequest, TextPaint } from '../paint';
import type { RichText } from '../richText';
import type { EditSelection } from './host';
import type { EditLayout, EditSessionServices, TextEditSession } from './session';

export interface EditableSessionPort {
    readonly doc: BoardDoc;
    readonly history: HistoryController;
    apply(transaction: Transaction): Applied;
    subscribe(listener: (notice: ChangeNotice) => void): () => void;
    beginGesture(): () => void;
    setComposition(active: boolean): void;
}
export type TextEditViewServices = Omit<EditSessionServices,
    'history' | 'apply' | 'readText' | 'plainText' | 'marksAt' | 'fragment' | 'format' | 'link' | 'enter' | 'blocks'
    | 'alive' | 'layout' | 'composition' | 'inList' | 'isStandaloneText'>;
export interface TextEditBindingOptions {
    readonly container: HTMLElement;
    readonly label: string;
    readonly node: NodeId;
    /** Frame titles use the model's plain name; all other hosts use rich text. */
    readonly key: 'text' | 'label' | 'name';
    readonly initialSelection: EditSelection;
    readonly mac: boolean;
    readonly session: EditableSessionPort;
    readonly layoutEngine: TextLayoutEngine;
    readonly view: TextEditViewServices;
    /** Uses the very same resolved style, sizing and local box as the scene's paint. */
    request(node: Readonly<Node>, text: RichText, overlayRevision: number): TextLayoutRequest;
    transforms(): Pick<EditLayout, 'localToClient' | 'clientToLocal'>;
    /** During composition the scene paints this overlay, never a DOM text copy. */
    paintChanged(paint: TextPaint, faces: FaceTable): void;
    clearPaint(): void;
    /** Add geometry/growY follow-ons to the same user transaction, before apply. */
    prepareTransaction(transaction: Transaction): Transaction;
}
export interface TextEditBinding {
    readonly editor: TextEditSession;
    /** Re-read layout after a camera, font, view, or geometry change. */
    refresh(): void;
    /** Typing on a selected node starts an ordinary typing burst, not a paste. */
    insertText(text: string): void;
    close(commitComposition?: boolean): void;
}
