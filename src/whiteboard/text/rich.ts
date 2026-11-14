import type { Block, Marks, RichFragment, RichSpliceResult, RichText } from './richText';
import type { RichSpliceOperation, RichTransactionResult } from './richTransaction';
import type { TextAffinity } from './rangeMap';
import type { PlainTextOptions } from './plainText';

export type RichMark = 'b' | 'i' | 'u' | 's' | 'code' | 'hl';
export interface RichSelection { readonly anchor: number; readonly focus: number }
export interface RichEdit { readonly from: number; readonly to: number; readonly insert: RichFragment; readonly selection: RichSelection; readonly replaceBlocks?: true }
export type { Block, BlockCarrier, Marks, RichFragment, RichSpliceResult, RichText, Run } from './richText';
export { plain, fromPlain, fromPlainCooperative, marksAt, linkRangeAt, insertionFragment, toggleMark, applyLink, enter, blocks, projectionLength, richTextOperations } from './richOperations';
export { normalizePlainInsertion, normalizePlainInsertionCooperative } from './plainText';
export type { PlainTextOptions } from './plainText';
export { repairLegacyCharacters, repairLegacyCharactersCooperative } from './repair';
export type { RepairedText } from './repair';
export { GraphemeNavigator } from './graphemes';
export { RichSelectionOperations } from './selectionOps';
export type { LogicalMotion } from './selectionOps';
export { TextProjectionReader } from './projectionReader';
export type { ProjectionWindow, ProjectionReadOptions } from './projectionReader';
export { coalesceCarriersCooperative } from './carriers';
export { normalizeRichText, normalizeRichTextCooperative, sliceRichText, sliceRichTextCooperative, spliceRichText } from './richText';
export { convertLegacyRichText, convertLegacyRichTextCooperative, convertLegacyRichSpan, convertLegacyRichSpanCooperative } from './importRich';
export { mapTextOffset, mapTextSelection, mapTextSelectionThrough, normalizeTextSelection, mapTextSelectionTo,
    mapRichTextChange, mapRichTextChangeCooperative } from './rangeMap';
export type { TextAffinity, TextSpliceMap, MappedRichTextChange } from './rangeMap';
export { deriveRichTextChange, deriveRichTextChangeCooperative } from './richDiff';
export type { RichTextChange, RichTextDiffOptions } from './richDiff';
export { applyRichTransaction, validateRichFragment, validateRichFragmentCooperative, richTransactionLength } from './richTransaction';
export type { RichSpliceOperation, RichTransactionResult } from './richTransaction';
export { snapshotRichFragmentCooperative } from './fragmentSnapshot';
export type { FragmentSnapshotOptions } from './fragmentSnapshot';

/** TX-2 operations use UTF-16 offsets in the newline-separated projection. */
export interface RichTextOperations {
    plain(value: RichText): string;
    fromPlain(value: string): RichText;
    fromPlainCooperative(value: string, options: PlainTextOptions): Promise<RichText>;
    normalize(value: RichText): RichText;
    normalizeCooperative(value: RichText, options: PlainTextOptions): Promise<RichText>;
    splice(value: RichText, from: number, to: number, insert: RichFragment, wholeBlocks?: boolean): RichSpliceResult;
    transaction(value: RichText, operations: readonly RichSpliceOperation[], selection: RichSelection, affinity?: TextAffinity): RichTransactionResult;
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
