import { addSheet, deleteSheet, deletionContents, duplicateSheet, renameSheet, reorderSheet, StructureRefused } from '../commands/pagesAndSheets';
import { childrenOf } from '../model/doc';
import { newSheetId, sheetId, type SheetId } from '../model/ids';
import type { Node } from '../model/nodes';
import type { BoardSession } from '../session/BoardSession';

export interface SheetControllerOptions {
    readonly session: BoardSession;
    /** Bound to the view lease; abort on detach so a queued edit cannot target a vanished view. */
    readonly signal: AbortSignal;
    readonly current: () => SheetId;
    readonly select: (id: SheetId) => void;
    readonly newName: (number: number) => string;
    readonly copyName: (name: string) => string;
    readonly confirmDelete: (name: string, contents: readonly Node[]) => Promise<boolean>;
}

/** Sheet changes share the session's gesture queue and one atomic transaction each. */
export function createSheetController({ session, signal, current, select, newName, copyName, confirmDelete }: SheetControllerOptions) {
    const queue = <T>(task: () => T) => session.enqueueAfterGesture(signal, task);
    return {
        select(id: string) {
            const sheet = sheetId(id);
            if (session.doc.sheets.has(sheet) && !signal.aborted) select(sheet);
        },
        hasContent(id: string): boolean {
            return childrenOf(session.doc, sheetId(id)).length > 0;
        },
        create(): Promise<void> {
            return queue(() => {
                const doc = session.doc, id = newSheetId(doc);
                addSheet(doc, session, id, newName(doc.sheetOrder.length + 1).slice(0, 200)).release();
                select(id);
            });
        },
        rename(id: string, name: string): Promise<void> {
            return queue(() => { renameSheet(session, sheetId(id), name).release(); });
        },
        duplicate(id: string): Promise<void> {
            return queue(() => {
                const doc = session.doc, source = sheetId(id), original = doc.sheets.get(source);
                if (!original) throw new StructureRefused('Sheet no longer exists');
                const copy = newSheetId(doc);
                duplicateSheet(doc, session, source, copy, copyName(original.name).slice(0, 200)).release();
                select(copy);
            });
        },
        move(id: string, destination: number): Promise<void> {
            return queue(() => { reorderSheet(session.doc, session, sheetId(id), destination)?.release(); });
        },
        async remove(id: string): Promise<void> {
            const sheet = sheetId(id), doc = session.doc, entry = doc.sheets.get(sheet);
            if (!entry) throw new StructureRefused('Sheet no longer exists');
            if (doc.sheets.size <= 1) throw new StructureRefused('A board must keep one sheet');
            const contents = deletionContents(doc, childrenOf(doc, sheet).map(node => node.id));
            const revision = doc.rev;
            if (!await confirmDelete(entry.name, contents) || signal.aborted) return;
            await queue(() => {
                const latest = session.doc;
                if (latest.rev !== revision) throw new StructureRefused('Board changed; confirm deletion again');
                const index = latest.sheetOrder.findIndex(item => item.id === sheet);
                if (index < 0) throw new StructureRefused('Sheet no longer exists');
                const fallback = latest.sheetOrder[index + 1] ?? latest.sheetOrder[index - 1];
                const wasCurrent = current() === sheet;
                deleteSheet(latest, session, sheet).release();
                if (wasCurrent && fallback) select(fallback.id);
            });
        },
    };
}
