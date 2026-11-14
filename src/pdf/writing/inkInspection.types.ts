export type PdfInkInspectionFailure = 'invalid-source' | 'encrypted' | 'signed' | 'unreadable' | 'ambiguous' |
    'unsupported-format' | 'missing-attachment' | 'invalid-marker' | 'invalid-write-mark' | 'nested-source' | 'resource-limit' | 'unsafe-policy';
export const PDF_INK_INSPECTION_PHASES = ['source-read', 'outer-parse', 'outer-policy', 'inventory', 'notebook-pointer',
    'pristine-parse', 'pristine-policy', 'board-read', 'board-identity', 'inspection-id'] as const;
export type PdfInkInspectionPhase = typeof PDF_INK_INSPECTION_PHASES[number];
export const PDF_INK_INSPECTION_ERROR_CLASSES = ['type-error', 'range-error', 'dom-error', 'error', 'other'] as const;
export type PdfInkInspectionErrorClass = typeof PDF_INK_INSPECTION_ERROR_CLASSES[number];
export interface PdfInkMediaDescriptor { name: string; size: null; sha256: string }
export type PdfInkInspection =
    | { kind: 'plain'; id: string; outerFingerprint: string; pristine: Blob; pristineFingerprint: string; board: null;
        media: []; formatId: 'board'; writeSafety: { kind: 'safe' } }
    | { kind: 'native'; id: string; outerFingerprint: string; pristine: Blob; pristineFingerprint: string; board: Blob;
        writeId: string; media: PdfInkMediaDescriptor[]; formatId: 'board'; writeSafety: { kind: 'safe' } }
    | { kind: 'read-only'; reason: PdfInkInspectionFailure }
    | { kind: 'read-only'; reason: 'inspection-failed'; phase: PdfInkInspectionPhase; errorClass: PdfInkInspectionErrorClass }
    | { kind: 'read-only'; reason: 'notebook-source'; outerFingerprint: string; notebookSource: { path: string; exportedAt?: number } };
