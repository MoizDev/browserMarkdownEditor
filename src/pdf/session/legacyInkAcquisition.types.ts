import type { PageGeometry } from '../../platform/types';
import type { TrashItem } from '../../types';
import type { PdfWriteMarkCheck } from '../../utils/pdfWriteMark';
import type { PdfWriteSafety } from '../../utils/pdfRole';
import type { WriterSource } from '../writing/protocol';
import type { TypedPdfWriter } from '../writing/writerClient';
import type { PdfEditableInkSource, PdfInkAcquisitionOptions } from './inkAcquisition.types';
import type { HostBlock } from '../../whiteboard/model/doc';
import type { PdfInkBackdrop, PdfInkBackdropOptions } from './inkBackdrop.types';

export type PdfLegacyInkAcquisitionOptions = PdfInkAcquisitionOptions;
export interface PdfLegacyPrepareOptions {
    assertRenderable(): void;
    confirmForeignMark(mark: Extract<PdfWriteMarkCheck, { kind: 'foreign' }>, signal: AbortSignal): Promise<boolean>;
    keepConversionBackup(outer: Blob, sha: string, signal: AbortSignal): Promise<TrashItem>;
}
export interface PdfLegacyConversionReady {
    readonly kind: 'legacy-conversion';
    readonly writeSafety: Readonly<Extract<PdfWriteSafety, { kind: 'safe' }>>;
    readonly source: WriterSource;
    readonly snapshot: Blob;
    readonly pages: readonly Readonly<PageGeometry>[];
    readonly writeMark: PdfWriteMarkCheck;
    readonly legacyOriginalSha256: string;
    readonly backup: TrashItem;
    openWriter(signal?: AbortSignal): Promise<TypedPdfWriter>;
    createBackdrop(options: Omit<PdfInkBackdropOptions, 'pool' | 'source' | 'isCurrent'>): Promise<PdfInkBackdrop>;
    isCurrent(): boolean;
    release(): Promise<void>;
}
export interface PdfLegacyInkCandidate {
    readonly kind: 'conversion-required';
    readonly writeSafety: Readonly<Extract<PdfWriteSafety, { kind: 'safe' }>>;
    readonly snapshot: Blob;
    readonly pages: readonly Readonly<PageGeometry>[];
    readonly writeMark: PdfWriteMarkCheck;
    readonly legacyOriginalSha256: string;
    createPreviewHost(): Extract<HostBlock, { kind: 'pdf-ink' }>;
    prepare(options: PdfLegacyPrepareOptions): Promise<PdfLegacyConversionReady>;
    isCurrent(): boolean;
    release(): Promise<void>;
}
export interface PdfConvertedInkSource {
    readonly kind: 'legacy-converted';
    readonly source: WriterSource;
    readonly pages: readonly Readonly<PageGeometry>[];
    readonly board: Blob;
    readonly writeSafety: Readonly<Extract<PdfWriteSafety, { kind: 'safe' }>>;
    readonly legacyOriginalSha256: string;
    readonly legacySnapshot: Blob;
    readonly legacyMigration: Readonly<{ writeId: string; previousFrames: readonly Readonly<{ width: number; height: number }>[] }>;
    readMedia(name: string, signal?: AbortSignal): Promise<Blob>;
    openWriter(signal?: AbortSignal): Promise<TypedPdfWriter>;
    createBackdrop(options: Omit<PdfInkBackdropOptions, 'pool' | 'source' | 'isCurrent'>): Promise<PdfInkBackdrop>;
    isCurrent(): boolean;
    release(): Promise<void>;
}
export type PdfRuntimeInkSource = PdfEditableInkSource | PdfConvertedInkSource;

export type PdfLegacyInkAcquisition = PdfLegacyInkCandidate | { kind: 'not-legacy'; release(): Promise<void> } |
    { kind: 'read-only'; reason: string; release(): Promise<void> };
