import type { PageGeometry } from '../../platform/types';
import type { DocInfo, PdfAttachmentInfo, RawOutlineNode } from '../engine/types';
import type { RawPdfLink } from '../pdfLinkModel';
import type { PageTileArgs, PageTileResult } from '../worker/protocol';

/** The contained engine is untrusted; validators rebuild data before it enters a session. */
export interface PdfReplyValidators {
    document(value: unknown): DocInfo;
    geometry(value: unknown, expectedPage: number): PageGeometry;
    tile(value: unknown, expected: PageTileArgs): PageTileResult;
    links(value: unknown, page: Readonly<PageGeometry>, pageCount: number): RawPdfLink[];
    outline(value: unknown, pageCount: number): RawOutlineNode[];
    attachments(value: unknown): PdfAttachmentInfo[];
    attachmentBytes(value: unknown, maxBytes: number): ArrayBuffer;
}
