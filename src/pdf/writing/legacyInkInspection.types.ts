import type { PdfWriteMarkCheck } from '../../utils/pdfWriteMark';

export type PdfLegacyInspection =
    | { kind: 'legacy'; pristine: Blob; pristineFingerprint: string; outerFingerprint: string; snapshot: Blob; writeMark: PdfWriteMarkCheck }
    | { kind: 'not-legacy' }
    | { kind: 'read-only'; reason: 'invalid-source' | 'encrypted' | 'signed' | 'unreadable' | 'ambiguous' | 'unsupported' };
