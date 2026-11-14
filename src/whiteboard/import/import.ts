import { NATIVE_VERSION } from '../format/schema';
import type { SavedView } from '../format/encode';
import type { HostBlock } from '../model/doc';
import type { SampleLease } from '../model/samples';
import { admitImportedBoard, type ImportedBoard } from './admit';
import { repairLegacyTree, type RootMapper } from './repair';
import { ReportBuilder, type ImportReport } from './report';
import { repairLegacySheets } from './sheets';
import { readLegacyRecords, type LegacyRecordOptions } from './records/read';
import type { ImportedMedia } from './records/media';
import { readLegacyUi, readLegacyView } from './records/view';

export interface LegacyImportOptions extends LegacyRecordOptions {
    readonly host: HostBlock;
    readonly repairRoot: RootMapper;
}
export interface LegacyImportResult {
    readonly source: string;
    readonly board: ImportedBoard | null;
    readonly media: readonly ImportedMedia[];
    readonly report: ImportReport;
    readonly readOnly: boolean;
    readonly converted: false;
    readonly savedView?: SavedView;
    dispose(): void;
}

// I-1: the original text and admitted media remain in memory; this function has no file capability.
export async function importLegacy(text: string, options: LegacyImportOptions): Promise<LegacyImportResult> {
    const report = new ReportBuilder();
    let draft: Awaited<ReturnType<typeof readLegacyRecords>> = null;
    try { draft = await readLegacyRecords(text, options); }
    catch (error) {
        options.signal?.throwIfAborted();
        report.refuse(null, error instanceof Error ? error.message : 'Import could not be read');
    }
    let board: ImportedBoard | null = null;
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
            const nodes = repairLegacyTree(draft.nodes, sheets, options.kind, options.repairRoot, report);
            const view = readLegacyView(draft.envelope.session);
            savedView = view.camera;
            board = admitImportedBoard({ kind: options.kind, sheets, nodes,
                media: media.map(item => item.entry), ui: readLegacyUi(draft.envelope.ui), view: view.flags,
                host: options.host, preserved: { version: NATIVE_VERSION, fields: new Map(),
                    records: draft.preservedRecords, end: null }, preservedMediaRefs: new Map() }, options.samples);
        } catch (error) { report.refuse(null, error instanceof Error ? error.message : 'Import could not be admitted'); }
    }
    const result = report.finish();
    let disposed = false;
    return { source: text, board, media, report: result, readOnly: !board || result.unrepresentable.length > 0,
        converted: false, savedView,
        dispose() {
            if (disposed) return;
            disposed = true;
            board?.apply.dispose();
            for (const lease of leases) lease.release();
            leases = [];
        } };
}
