import type { PageGeometry } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import type { PdfPool } from '../pool/types';
import type { WriterSource } from '../writing/protocol';
import type { TypedPdfWriter } from '../writing/writerClient';
import type { PdfInkBackdrop, PdfInkBackdropOptions } from './inkBackdrop.types';

export interface PdfInkAcquisitionOptions {
    outer: Blob;
    token: RenderToken;
    isCurrent(): boolean;
    signal?: AbortSignal;
    pool?: PdfPool;
}

export type PdfEditableInkSource = {
    source: WriterSource;
    readonly writeSafety: { readonly kind: 'safe' };
    pages: readonly Readonly<PageGeometry>[];
    readMedia(name: string, signal?: AbortSignal): Promise<Blob>;
    openWriter(signal?: AbortSignal): Promise<TypedPdfWriter>;
    createBackdrop(options: Omit<PdfInkBackdropOptions, 'pool' | 'source' | 'isCurrent'>): Promise<PdfInkBackdrop>;
    isCurrent(): boolean;
    release(): Promise<void>;
} & ({ kind: 'plain'; board: null } | { kind: 'native'; board: Blob; writeId: string });

export interface PdfReadOnlyInkSource {
    kind: 'read-only';
    reason: string;
    /** Verified against the actual outer snapshot; never an editing capability. */
    notebookSource?: { readonly path: string; readonly exportedAt?: number };
    outerFingerprint?: string;
    isCurrent?(): boolean;
    release(): Promise<void>;
}

export type PdfInkAcquisition = PdfEditableInkSource | PdfReadOnlyInkSource;
