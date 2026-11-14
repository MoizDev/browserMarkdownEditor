import type { PageGeometry } from '../../platform/types';
import { parseJson } from '../../whiteboard/format/jsonRead';
import type { HostBlock } from '../../whiteboard/model/doc';
import { createPdfReplyValidators } from '../pool/validation';
import type { WriterSource } from '../writing/protocol';
import { newPdfWriteId } from '../writing/writeIdentity';

type PdfHost = Extract<HostBlock, { kind: 'pdf-ink' }>;

/** Preview metadata is deliberately outside the saveable PDF host schema. */
export function createPdfInkPreviewHost(basis: {
    pristineFingerprint: string;
    geometryEngine: WriterSource['geometryEngine'];
    pages: readonly Readonly<PageGeometry>[];
    isCurrent(): boolean;
}): PdfHost {
    if (!basis.isCurrent() || !/^[0-9a-f]{64}$/.test(basis.pristineFingerprint) || !Array.isArray(basis.pages) ||
        !basis.pages.length || basis.pages.length > 65_536) throw new Error('A current legacy PDF candidate is required');
    const engine = basis.geometryEngine;
    if (!engine || typeof engine.id !== 'string' || !engine.id || engine.id.length > 128 ||
        typeof engine.build !== 'string' || !engine.build || engine.build.length > 256 ||
        !Number.isSafeInteger(engine.generation) || engine.generation < 0) throw new Error('Invalid legacy PDF geometry engine');
    const validate = createPdfReplyValidators().geometry;
    const pages = basis.pages.map((page, index) => validate(page, index));
    if (!basis.isCurrent()) throw new DOMException('Legacy PDF candidate changed', 'AbortError');
    const pdf = parseJson(JSON.stringify({ schema: 1, sourceFingerprint: basis.pristineFingerprint,
        geometryEngine: { id: engine.id, build: engine.build, generation: engine.generation },
        pages, writeId: newPdfWriteId(), preview: true })).raw();
    return { kind: 'pdf-ink', pdf, pages: pages.map(page => [page.width, page.height] as const), ext: null };
}
