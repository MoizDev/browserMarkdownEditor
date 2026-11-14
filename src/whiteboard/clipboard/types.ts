import type { NodeId, ParentId, SheetId } from '../model/ids';
import type { RichFragment } from '../text/richText';
import type { ClipboardBounds } from './snapshot';

/** An event is sampled synchronously; no DataTransfer object survives its event. */
export interface ClipboardFile {
    readonly blob: Blob;
    readonly name: string;
    readonly directory: boolean;
}
export interface ClipboardInput {
    readonly html: string | null;
    readonly text: string | null;
    readonly svg: string | null;
    readonly uriList: string | null;
    readonly files: readonly ClipboardFile[];
    readonly privatePng: Blob | null;
}
export interface ClipboardPoint { readonly x: number; readonly y: number }
export interface ClipboardTarget {
    readonly session: string;
    readonly vaultEpoch: number;
    readonly generation: number;
    readonly sheet: SheetId;
    readonly viewport: ClipboardBounds;
    readonly pointer: ClipboardPoint | null;
    readonly selectedFrame: NodeId | null;
    readonly pasteAtCursor: boolean;
}
export type ClipboardIntent = 'paste' | 'paste-inverted' | 'paste-plain' | 'paste-plain-inverted' | 'drop' | 'duplicate';
export interface ClipboardPlacement {
    readonly parent: ParentId;
    readonly x: number;
    readonly y: number;
    readonly preserveSourcePosition: boolean;
}
export type ClipboardClassification =
    | { readonly kind: 'private'; readonly encoded: string }
    | { readonly kind: 'private-png'; readonly blob: Blob }
    | { readonly kind: 'files'; readonly files: readonly ClipboardFile[] }
    | { readonly kind: 'legacy'; readonly envelope: string }
    | { readonly kind: 'excalidraw'; readonly text: string }
    | { readonly kind: 'native-records'; readonly text: string }
    | { readonly kind: 'svg'; readonly text: string }
    | { readonly kind: 'url'; readonly url: string }
    | { readonly kind: 'html'; readonly html: string }
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'empty' };
export interface ClipboardTextEditor {
    copySelection(): RichFragment;
    replaceSelection(fragment: RichFragment): void;
    deleteSelection(): void;
}
