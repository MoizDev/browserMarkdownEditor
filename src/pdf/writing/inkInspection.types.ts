export type PdfInkInspectionFailure = 'invalid-source' | 'encrypted' | 'signed' | 'unreadable' | 'ambiguous' |
    'unsupported-format' | 'missing-attachment' | 'invalid-marker' | 'invalid-write-mark' | 'nested-source' | 'resource-limit';
export interface PdfInkMediaDescriptor { name: string; size: null; sha256: string }
export type PdfInkInspection =
    | { kind: 'plain'; id: string; outerFingerprint: string; pristine: Blob; pristineFingerprint: string; board: null;
        media: []; formatId: 'board' }
    | { kind: 'native'; id: string; outerFingerprint: string; pristine: Blob; pristineFingerprint: string; board: Blob;
        writeId: string; media: PdfInkMediaDescriptor[]; formatId: 'board' }
    | { kind: 'read-only'; reason: PdfInkInspectionFailure }
    | { kind: 'read-only'; reason: 'notebook-source'; outerFingerprint: string; notebookSource: { path: string; exportedAt?: number } };
