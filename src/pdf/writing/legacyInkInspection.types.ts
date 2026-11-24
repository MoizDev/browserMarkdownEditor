import type { PdfWriteMarkCheck } from '../../utils/pdfWriteMark';
import type { PdfWriteSafety } from '../../utils/pdfRole';

export type PdfLegacyInspection =
    | { kind: 'legacy'; pristine: Blob; pristineFingerprint: string; outerFingerprint: string; snapshot: Blob; writeMark: PdfWriteMarkCheck; writeSafety: Extract<PdfWriteSafety, { kind: 'safe' }> }
    | { kind: 'not-legacy' }
    | { kind: 'read-only'; reason: 'invalid-source' | 'encrypted' | 'signed' | 'unreadable' | 'ambiguous' | 'unsupported' };
