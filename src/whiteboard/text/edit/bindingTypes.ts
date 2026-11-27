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
    preflight(transaction: Transaction): { readonly ops: Transaction['ops']; release(): void };
    subscribe(listener: (notice: ChangeNotice) => void): () => void;
    beginGesture(): () => void;
    setComposition(active: boolean): void;
}
export type TextEditViewServices = Omit<EditSessionServices,
    'history' | 'apply' | 'prepareCut' | 'readText' | 'plainText' | 'marksAt' | 'fragment' | 'format' | 'link' | 'enter' | 'blocks'
    | 'alive' | 'layout' | 'composition' | 'inList' | 'isStandaloneText'>;
export interface TextEditBindingOptions {
    readonly container: HTMLElement;
    readonly label: string;
    readonly node: NodeId;
    readonly key: 'text' | 'label' | 'name';
    readonly initialSelection: EditSelection;
    readonly mac: boolean;
    readonly session: EditableSessionPort;
    readonly layoutEngine: TextLayoutEngine;
    readonly view: TextEditViewServices;
    request(node: Readonly<Node>, text: RichText, overlayRevision: number): TextLayoutRequest;
    transforms(): Pick<EditLayout, 'localToClient' | 'clientToLocal'>;
    paintChanged(paint: TextPaint, faces: FaceTable): void;
    clearPaint(): void;
    prepareTransaction(transaction: Transaction): Transaction;
}
export interface EditableTextRequestOptions {
    readonly revision: string;
    readonly fontEpoch: number;
    readonly zoom: number;
    readonly connectorLength?: number;
}
export type EditableTextRequest = (node: Readonly<Node>, text: RichText, options: EditableTextRequestOptions) => TextLayoutRequest;
export type TextEditTransactionPreparer = (transaction: Transaction) => Transaction;
export interface TextEditBinding {
    readonly editor: TextEditSession;
    refresh(): void;
    insertText(text: string): void;
    close(commitComposition?: boolean): void;
}
