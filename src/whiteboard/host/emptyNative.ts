import { DEFAULT_PAPER, type NotebookPaper } from '../../utils/paper';
import { encodeHeader, encodeHost, encodePaper, encodePen, encodeSheet, encodeView } from '../format/encode';
import { LineTable } from '../format/lineTable';
import { NATIVE_VERSION } from '../format/schema';
import type { WriteResult } from '../format/writeTypes';
import { createBoardDoc, type BoardKind, type HostBlock, type ViewFlags } from '../model/doc';
import { UI_DEFAULTS, VIEW_DEFAULTS } from '../model/defaults';
import { newSheetId } from '../model/ids';
import { keyBetween } from '../model/orderKey';
import type { UiBlock } from '../model/styles';
import { validateLoadedRoot } from '../model/validate';

export interface EmptyNativeOptions {
    readonly paper?: Readonly<NotebookPaper>;
    readonly ui?: Readonly<UiBlock>;
    readonly view?: Readonly<ViewFlags>;
    readonly sheetName?: string;
    /** A PDF ink board never invents a pristine source or physical-page geometry. */
    readonly pdfHost?: Extract<HostBlock, { kind: 'pdf-ink' }>;
}
function value<T>(result: WriteResult<T>): T {
    if (!result.ok) throw new Error(`Cannot create an empty native board: ${result.error.reason}`);
    return result.value;
}
/** New-document route only. Callers must verify the original bytes are empty;
 * parse/validation failures must NEVER be replaced by these defaults. The same
 * format encoders and line assembler as normal saves produce the fence/footer. */
export function createEmptyNativeBytes(kind: BoardKind, options: EmptyNativeOptions = {}): Blob {
    const host: HostBlock = kind === 'whiteboard' ? { kind }
        : kind === 'notebook' ? { kind, paper: { ...options.paper ?? DEFAULT_PAPER }, ext: null }
        : options.pdfHost ?? (() => { throw new Error('Empty PDF ink requires its real PDF host'); })();
    const id = newSheetId({ nodes: new Map(), sheets: new Map() });
    const ui = options.ui ?? UI_DEFAULTS;
    const doc = createBoardDoc({ kind, host, sheets: [{ id, name: options.sheetName ?? 'Page 1', order: keyBetween(null, null), ext: null }],
        ui: { ...ui, next: { ...ui.next } }, view: { ...options.view ?? VIEW_DEFAULTS },
        preserved: { version: NATIVE_VERSION, fields: new Map(), records: [], end: null }, preservedMediaRefs: new Map() });
    const validation = validateLoadedRoot(doc);
    if (!validation.ok) throw new Error(`Cannot create an empty native board: ${validation.reason}`);
    const lines = new LineTable();
    value(lines.setHeader(value(encodeHeader(kind, doc.preserved))));
    for (const record of [encodePen(doc.ui), encodeView(doc.view, { sheet: id, x: 0, y: 0, zoom: 1 }),
        ...(host.kind === 'notebook' ? [encodePaper(host)] : host.kind === 'pdf-ink' ? [encodeHost(host)] : []), encodeSheet(doc.sheetOrder[0])]) {
        value(lines.set(value(record), 0));
    }
    return value(lines.assemble(lines.integrity())).blob;
}
