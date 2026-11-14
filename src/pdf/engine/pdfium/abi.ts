import { PdfEngineError } from '../types';

export interface PdfiumStructLayout {
    readonly size: number;
    readonly offsets: Readonly<Record<string, number>>;
}
export interface PdfiumAbi {
    readonly structs: Readonly<Record<string, PdfiumStructLayout>>;
}

type Expected = { alias: string; size: number; fields: Readonly<Record<string, number>>; callbacks?: Readonly<Record<string, string>> };
// These offsets are from the pinned public-header WASM32 compiler dump. The
// descriptor is fetched and authenticated with the engine, then checked before
// any native call; a changed header cannot silently corrupt callback structs.
const EXPECTED: Readonly<Record<string, Expected>> = {
    FPDF_LIBRARY_CONFIG: { alias: 'libraryConfig', size: 36, fields: { version: 0, m_pUserFontPaths: 4, m_pIsolate: 8,
        m_v8EmbedderSlot: 12, m_pPlatform: 16, m_RendererType: 20, m_FontLibraryType: 24,
        m_BrotliEnabled: 28, m_IsolatePerDocument: 32 } },
    FPDF_FILEACCESS: { alias: 'fileAccess', size: 12, fields: { m_FileLen: 0, m_GetBlock: 4, m_Param: 8 },
        callbacks: { m_GetBlock: 'int (*)(void *, unsigned long, unsigned char *, unsigned long)' } },
    FPDF_FORMFILLINFO: { alias: 'formFillInfo', size: 140, fields: { version: 0, Release: 4, FFI_GetPage: 36,
        FFI_GetCurrentPage: 40, FFI_GetRotation: 44, m_pJsPlatform: 64, xfa_disabled: 68 },
        callbacks: { FFI_GetPage: 'FPDF_PAGE (*)(struct _FPDF_FORMFILLINFO *, FPDF_DOCUMENT, int)' } },
    FPDF_SYSFONTINFO: { alias: 'systemFontInfo', size: 36, fields: { version: 0, Release: 4, EnumFonts: 8, MapFont: 12,
        GetFont: 16, GetFontData: 20, GetFaceName: 24, GetFontCharset: 28, DeleteFont: 32 } },
    IFSDK_PAUSE: { alias: 'pause', size: 12, fields: { version: 0, NeedToPauseNow: 4, user: 8 },
        callbacks: { NeedToPauseNow: 'FPDF_BOOL (*)(struct _IFSDK_PAUSE *)' } },
    FPDF_FILEWRITE: { alias: 'fileWrite', size: 8, fields: { version: 0, WriteBlock: 4 },
        callbacks: { WriteBlock: 'int (*)(struct FPDF_FILEWRITE_ *, const void *, unsigned long)' } },
    FS_MATRIX: { alias: 'matrix', size: 24, fields: { a: 0, b: 4, c: 8, d: 12, e: 16, f: 20 } },
    FS_RECTF: { alias: 'rect', size: 16, fields: { left: 0, top: 4, right: 8, bottom: 12 } },
    FS_SIZEF: { alias: 'size', size: 8, fields: { width: 0, height: 4 } },
    FS_QUADPOINTSF: { alias: 'quad', size: 32, fields: { x1: 0, y1: 4, x2: 8, y2: 12, x3: 16, y3: 20, x4: 24, y4: 28 } },
};

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PdfEngineError('EngineBroken', 'Invalid PDFium ABI descriptor');
    return value as Record<string, unknown>;
}

/** Accept only the compiler-declared callback and value layouts this adapter implements. */
export function validatePdfiumAbi(value: unknown): PdfiumAbi {
    const descriptor = record(value);
    if (descriptor.schemaVersion !== 1 || descriptor.pointerBytes !== 4 || descriptor.unsignedLongBytes !== 4) {
        throw new PdfEngineError('EngineBroken', 'Unsupported PDFium ABI');
    }
    const input = record(descriptor.records);
    const structs: Record<string, PdfiumStructLayout> = Object.create(null) as Record<string, PdfiumStructLayout>;
    for (const [name, expected] of Object.entries(EXPECTED)) {
        const layout = record(input[name]);
        const fields = record(layout.fields);
        if (layout.size !== expected.size || layout.align !== 4) throw new PdfEngineError('EngineBroken', `Unsupported PDFium ABI layout: ${name}`);
        const offsets: Record<string, number> = Object.create(null) as Record<string, number>;
        for (const [field, offset] of Object.entries(expected.fields)) {
            if (record(fields[field]).offset !== offset) throw new PdfEngineError('EngineBroken', `Unsupported PDFium ABI field: ${name}.${field}`);
            offsets[field] = offset;
        }
        for (const [field, type] of Object.entries(expected.callbacks ?? {})) {
            if (record(fields[field]).type !== type) throw new PdfEngineError('EngineBroken', `Unsupported PDFium callback ABI: ${name}.${field}`);
        }
        structs[expected.alias] = Object.freeze({ size: expected.size, offsets: Object.freeze(offsets) });
    }
    return Object.freeze({ structs: Object.freeze(structs) });
}
