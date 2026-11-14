import { NATIVE_VERSION } from '../format/schema';
import { parseJson } from '../format/jsonRead';
import type { RawJson } from '../model/json';
import type { SavedView } from '../format/encode';
import type { BoardDocInput, BoardKind, HostBlock, Sheet } from '../model/doc';
import type { Node } from '../model/nodes';
import type { SampleStore } from '../ink/samples';
import type { SampleLease } from '../model/samples';
import { basicLegacyGeometry } from './basicGeometry';
import type { RootMapper } from './repair';
import { ReportBuilder, type ImportReport } from './report';
import { repairLegacySheets } from './sheets';
import { createPagePreparation, type PageSource } from './pages';
import { legacyWorldBounds, type LegacyGeometry, type LegacyTextLayout } from './worldBounds';
import { readLegacyRecords, type LegacyRecordOptions } from './records/read';
import type { ImportedMedia } from './records/media';
import { readLegacyUi, readLegacyView } from './records/view';

export interface LegacyImportOptions<T> extends Omit<LegacyRecordOptions, 'preparePages'> {
    readonly host: HostBlock;
    readonly repairRoot: RootMapper;
    readonly pageSource?: PageSource;
    readonly textLayout: LegacyTextLayout;
    readonly geometry: LegacyGeometry;
    readonly repair: (nodes: readonly Node[], sheets: readonly Sheet[], kind: BoardKind,
        root: RootMapper, report: ReportBuilder) => readonly Node[];
    readonly admit: (input: BoardDocInput, samples: SampleStore) => T;
    readonly releaseAdmitted: (value: T) => void;
}
export interface LegacyImportResult<T> {
    readonly source: string;
    readonly board: T | null;
    readonly media: readonly ImportedMedia[];
    readonly report: ImportReport;
    readonly readOnly: boolean;
    readonly converted: false;
    readonly savedView?: SavedView;
    dispose(): void;
}

// I-1: the original text and admitted media remain in memory; this function has no file capability.
export async function importLegacy<T>(text: string, options: LegacyImportOptions<T>): Promise<LegacyImportResult<T>> {
    const report = new ReportBuilder();
    let draft: Awaited<ReturnType<typeof readLegacyRecords>> = null;
    try {
        if (options.kind !== 'whiteboard' && options.pageSource?.kind !== options.kind) {
            throw new Error('Paged import requires matching host geometry');
        }
        const preparePages: LegacyRecordOptions['preparePages'] = options.pageSource
            ? createPagePreparation(options.pageSource, (nodes, sheets) => legacyWorldBounds(nodes,
                new Set(sheets.map(sheet => sheet.id)), options.textLayout, basicLegacyGeometry(options.samples, options.geometry)))
            : undefined;
        draft = await readLegacyRecords(text, { ...options, preparePages });
    }
    catch (error) {
        options.signal?.throwIfAborted();
        options.assertCurrent();
        report.refuse(null, error instanceof Error ? error.message : 'Import could not be read');
    }
    let board: T | null = null;
    let leases: readonly SampleLease[] = [];
    let media: readonly ImportedMedia[] = [];
    let savedView: SavedView | undefined;
    if (!draft) {
        if (report.finish().unrepresentable.length === 0) report.refuse(null, 'Not a drawing this app can read');
    } else {
        report.include(draft.report); leases = draft.leases; media = draft.media;
        try {
            if (options.host.kind !== options.kind) throw new Error('Host kind does not match imported board');
            const sheets = repairLegacySheets(draft.sheets, report);
            const nodes = options.repair(draft.nodes, sheets, options.kind, options.repairRoot, report);
            const view = readLegacyView(draft.envelope.session);
            savedView = view.camera;
            const fields = new Map<string, RawJson>();
            if (Object.keys(draft.envelope.extras).length) fields.set('legacyEnvelope', parseJson(JSON.stringify(draft.envelope.extras)).raw());
            if (Object.keys(draft.envelope.documentExtras).length) fields.set('legacyDocument', parseJson(JSON.stringify(draft.envelope.documentExtras)).raw());
            board = options.admit({ kind: options.kind, sheets, nodes,
                media: media.map(item => item.entry), ui: readLegacyUi(draft.envelope.ui), view: view.flags,
                host: options.host, preserved: { version: NATIVE_VERSION, fields,
                    records: draft.preservedRecords, end: null }, preservedMediaRefs: new Map() }, options.samples);
        } catch (error) { report.refuse(null, error instanceof Error ? error.message : 'Import could not be admitted'); }
    }
    try { options.assertCurrent(); }
    catch (error) {
        if (board !== null) options.releaseAdmitted(board);
        for (const lease of leases) lease.release();
        throw error;
    }
    const result = report.finish();
    let disposed = false;
    return { source: text, board, media, report: result, readOnly: !board || result.unrepresentable.length > 0,
        converted: false, savedView,
        dispose() {
            if (disposed) return;
            disposed = true;
            if (board !== null) options.releaseAdmitted(board);
            for (const lease of leases) lease.release();
            leases = [];
        } };
}
