import type { Block, Marks, RichFragment, RichSpliceResult, RichText } from './richText';

export type RichMark = 'b' | 'i' | 'u' | 's' | 'code' | 'hl';
export interface RichSelection { readonly anchor: number; readonly focus: number }
export interface RichEdit { readonly from: number; readonly to: number; readonly insert: RichFragment; readonly selection: RichSelection; readonly replaceBlocks?: true }
export type { Block, Marks, RichFragment, RichSpliceResult, RichText, Run } from './richText';

/** TX-2 operations use UTF-16 offsets in the newline-separated projection. */
export interface RichTextOperations {
    plain(value: RichText): string;
    fromPlain(value: string): RichText;
    normalize(value: RichText): RichText;
    splice(value: RichText, from: number, to: number, insert: RichFragment, wholeBlocks?: boolean): RichSpliceResult;
    marksAt(value: RichText, offset: number): Marks;
    insertionFragment(value: RichText, from: number, inserted: string, storedMarks: Marks | null): RichFragment;
    toggleMark(value: RichText, from: number, to: number, mark: RichMark): RichFragment;
    applyLink(value: RichText, from: number, to: number, url: string | null): RichFragment;
    enter(value: RichText, selection: RichSelection): RichEdit;
    blocks(value: RichText, from: number, to: number, kind: Block['kind'] | 'indent' | 'outdent'): RichEdit;
}

export interface RichImportResult {
    readonly text: RichText;
    readonly repairs: readonly string[];
    readonly unrepresentable: readonly string[];
}
/** Legacy values are data, not executable schema objects. */
export type ImportRichText = (value: unknown) => RichImportResult;
