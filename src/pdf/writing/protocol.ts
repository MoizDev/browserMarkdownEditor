import type { PageGeometry, PageDisplayList } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import type { PdfDocKey } from '../worker/protocol';

/** C2/C5 worker payloads only. Handles, live board sessions and callbacks stay on the host. */
export interface WriterSource {
    token: RenderToken;
    /** Canonical key uses bytesGeneration, not the rename-bumped reader token. */
    docKey: PdfDocKey;
    pristine: Blob;
    pristineFingerprint: string;
    outer: Blob;
    outerFingerprint: string;
    /** Stable id supplied by the board format owner. */
    formatId: string;
    /** Issued only by the exhaustive attachment reader after validating both
     * snapshots. Missing proof takes the preservation converter, never a guess. */
    attachmentProof?: { pristineFingerprint: string; outerFingerprint: string; canonical: true; unknownCount: 0 };
    geometryEngine: { id: string; build: string; generation: number };
}
export type WriterFailureCode = 'encrypted' | 'signed' | 'newer-format' | 'unrecoverable-attachments' | 'resource-limit' | 'cancelled' | 'failure';
export interface WriterInspection {
    pageCount: number;
    geometries: PageGeometry[];
    encrypted: boolean;
    signed: boolean;
    /** The writer must preserve this inventory, including duplicate names. */
    attachments: AttachmentDescriptor[];
}
export interface AttachmentMetadata {
    description?: string;
    mimeType?: string;
    relationship?: 'Source' | 'Data' | 'Alternative' | 'Supplement' | 'Unspecified';
    created?: string;
    modified?: string;
}
export interface AttachmentDescriptor {
    name: string;
    sha256: string;
    metadata?: AttachmentMetadata;
}
export interface AttachmentInput extends AttachmentDescriptor {
    bytes: Blob;
    role: 'pristine' | 'editable' | 'media' | 'fence' | 'notebook-source' | 'write-mark' | 'unknown';
    /** The owning format supplies this stable identifier, never an inferred one. */
    format?: string;
}
export interface EmittedInk {
    schema: 1;
    pdf: Blob;
    pages: Array<{ sourcePage: number; inkPage: number; width: number; height: number; hash: string }>;
}
export interface FrozenPage {
    sourcePage: number;
    width: number;
    height: number;
    displayList: PageDisplayList;
}
export interface GeneratedPage {
    width: number;
    height: number;
    displayList: PageDisplayList;
    paper?: PageDisplayList;
}
export interface StagedWriterResult {
    bytes: ArrayBuffer;
    revision: number;
    writeId: string;
    sourceFingerprint: string;
    verification: { pageCount: number; attachmentCount: number; writeMark: 'verified' };
}

/** Each save gets a separate mutable writer session; a session id is not a native pointer. */
/** Why the writer would not turn a PDF's pages; App words each one for the person. */
export type RotationRefusal = 'signed' | 'encrypted' | 'annotated' | 'notebook-source' | 'missing-attachment' | 'unsafe-policy'
    | 'unsupported-format' | 'unsupported-rotation';

export interface WriterOperations {
    'writer.prepareSource': {
        args: { source: WriterSource };
        result: { writerSession: string; sourceFingerprint: string; inspection: WriterInspection };
    };
    'writer.emitInk': {
        args: { revision: number; displayListSchema: 1; pages: FrozenPage[] };
        result: EmittedInk;
    };
    'writer.stageAnnotated': {
        args: { writerSession: string; revision: number; ink: EmittedInk; geometries: PageGeometry[]; reservedNames: string[] };
        result: { stageId: string; sourceFingerprint: string; geometryEngine: WriterSource['geometryEngine'] };
    };
    'writer.finishAnnotated': {
        args: { stageId: string; revision: number; attachments: AttachmentInput[]; writeId: string };
        result: StagedWriterResult;
    };
    'writer.buildNotebook': {
        args: { revision: number; notebookSource: { path: string }; writeId: string } &
            ({ kind?: 'display'; displayListSchema: 1; pages: GeneratedPage[] } |
                { kind: 'pre-emitted'; pdf: Blob; pages: Array<{ width: number; height: number }> });
        result: Omit<StagedWriterResult, 'sourceFingerprint' | 'verification'> & { verification: { pageCount: number; attachmentCount: number } };
    };
    'writer.prepareUnsignedCopy': {
        args: { source: Blob };
        result: { bytes: ArrayBuffer; originalSha: string; attachmentName: string };
    };
    'writer.verifyUnsignedCopy': {
        args: { source: Blob; bytes: ArrayBuffer; attachmentName: string };
        result: { bytes: ArrayBuffer; originalSha: string; outputSha: string };
    };
    'writer.verifyNotebookOutput': {
        args: { bytes: ArrayBuffer; notebookSource: { path: string } };
        result: { bytes: ArrayBuffer; sha256: string; path: string; geometries: PageGeometry[] };
    };
    /** Plans an incremental /Rotate update (rotationUpdate.ts): the appendix to write after `base` source bytes. */
    'writer.rotate': {
        args: { source: Blob; turns: { all: number; pages: Array<[number, number]> } };
        result: { kind: 'refused'; cause: RotationRefusal } | { kind: 'unchanged' }
            | { kind: 'update'; appendix: ArrayBuffer; base: number; pageCount: number; before: number[]; rotations: number[] };
    };
    /** A fresh writer proves `bytes` (the source's first `base` bytes plus the appendix) before App writes it. */
    'writer.verifyRotation': {
        args: { source: Blob; bytes: ArrayBuffer; base: number; rotations: number[] };
        result: { bytes: ArrayBuffer; pageCount: number };
    };
    'writer.inspect': {
        args: { source: WriterSource; includeAttachments: boolean; signaturePolicy: 'refuse' | 'inspect' };
        result: WriterInspection;
    };
    'writer.release': { args: { writerSession: string }; result: Record<string, never> };
}
