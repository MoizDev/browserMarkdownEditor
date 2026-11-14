import { readNative } from '../format/read';
import type { ByteSource, NativeReadResult, ReadDraft } from '../format/readTypes';
import { SampleStore } from '../ink/samples';
import type { BoardDoc, BoardKind } from '../model/doc';
import type { SampleLease } from '../model/samples';
import { listAgentSheets, type AgentGeometry, type ShapePage, type ShapeQuery } from './shapes';

export interface ClosedBoard {
    readonly doc: BoardDoc;
    readonly samples: SampleStore;
    readonly readOnly: boolean;
    readonly issues: NativeReadResult['issues'];
    /** Releases all read leases after the projection/capture is finished. */
    dispose(): void;
}
export type ClosedBoardRead =
    | { readonly format: 'other' | 'empty' }
    | { readonly format: 'native'; readonly board: ClosedBoard };
export interface ClosedBoardOptions {
    readonly kind: BoardKind;
    readonly byteLength?: number;
    readonly pdfPages?: readonly (readonly [number, number])[];
    readonly signal?: AbortSignal;
    /** C5 repairs/validates the ordered draft before constructing its indexed doc. */
    admit(draft: ReadDraft, samples: SampleStore): BoardDoc;
}

// F-AGENT-001/WB-D11: the host selects this only when there is no live session.
// The same projection used by the live session consumes the returned doc/store.
export async function readClosedBoard(source: ByteSource, options: ClosedBoardOptions): Promise<ClosedBoardRead> {
    const samples = new SampleStore(), leases: SampleLease[] = [];
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const lease of leases) lease.release();
        leases.length = 0;
    };
    try {
        if (options.signal?.aborted) throw new Error('Board read cancelled');
        const result = await readNative(source, {
            byteLength: options.byteLength, expectedKind: options.kind, pdfPages: options.pdfPages, signal: options.signal,
            admitEncoded: (pts, header) => {
                const lease = samples.admitEncoded(pts, header);
                leases.push(lease);
                return lease.ref;
            },
        });
        if (options.signal?.aborted) throw new Error('Board read cancelled');
        if (result.format !== 'native') {
            dispose();
            return { format: result.format };
        }
        // Once native is detected, an incomplete or unadmittable draft is not a
        // legacy file. In particular, no fallback parser may overwrite its bytes.
        if (!result.draft || !result.complete) throw new Error(result.issues[0]?.reason ?? 'Native board could not be read completely');
        const doc = options.admit(result.draft, samples);
        if (options.signal?.aborted) throw new Error('Board read cancelled');
        return { format: 'native', board: { doc, samples, readOnly: result.readOnly, issues: result.issues, dispose } };
    } catch (error) {
        dispose();
        throw error;
    }
}

export interface ClosedShapeOptions extends ClosedBoardOptions {
    readonly query?: ShapeQuery;
    /** App-owned monotonic generation of the exact disk baseline, not doc.rev. */
    readonly diskRevision: number;
    isCurrent(): boolean;
    /** Same authoritative, offscreen-capable projection used by live sessions. */
    project(doc: BoardDoc, samples: SampleStore): Promise<{ readonly geometry: AgentGeometry; dispose(): void }>;
}

export async function readClosedShapePage(source: ByteSource, options: ClosedShapeOptions): Promise<ShapePage | null> {
    const guard = () => {
        if (options.signal?.aborted || !options.isCurrent()) throw new Error('Board read cancelled or superseded');
    };
    guard();
    const read = await readClosedBoard(source, options);
    if (read.format !== 'native') { guard(); return null; }
    try {
        guard();
        const projection = await options.project(read.board.doc, read.board.samples);
        try {
            guard();
            return listAgentSheets(read.board.doc, projection.geometry, options.query, options.diskRevision);
        } finally { projection.dispose(); }
    } finally { read.board.dispose(); }
}
