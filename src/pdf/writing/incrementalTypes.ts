import type { PdfGroupOpen, PdfImageItem, PdfPathOpen } from '../../whiteboard/export/incrementalPdf';
import type { PathCommand } from '../../platform/types';

export interface IncrementalEmittedPdf {
    readonly revision: number;
    readonly bytes: Uint8Array;
    readonly hashes: readonly string[];
    readonly pages: readonly { index: number; width: number; height: number }[];
}
export type IncrementalOperation =
    | { kind: 'open'; revision: number; pageCount: number }
    | { kind: 'beginPage'; page: { index: number; width: number; height: number } }
    | { kind: 'beginGroup'; group: PdfGroupOpen }
    | { kind: 'endGroup' }
    | { kind: 'beginPath'; path: PdfPathOpen }
    | { kind: 'pathCommands'; commands: readonly PathCommand[] }
    | { kind: 'endPath' }
    | { kind: 'image'; item: PdfImageItem }
    | { kind: 'endPage' }
    | { kind: 'finish' };
