import type { NotebookPaper } from '../../utils/paper';
import type { ChangeGeometry } from '../change/coordinates';
import { addPage, changePaper, deleteLastPage, lastPageContents, reorderPage, StructureRefused } from '../commands/pagesAndSheets';
import type { Node } from '../model/nodes';
import type { BoardSession } from '../session/BoardSession';

export interface NotebookControllerOptions {
    readonly session: BoardSession;
    readonly signal: AbortSignal;
    readonly geometry: () => ChangeGeometry;
    readonly currentPage: () => number;
    readonly selectPage: (page: number) => void;
    readonly confirmDelete: (contents: readonly Node[]) => Promise<boolean>;
}

/** Physical-page edits share admission, history and confirmation with the live session. */
export function createNotebookController({ session, signal, geometry, currentPage, selectPage, confirmDelete }: NotebookControllerOptions) {
    const queue = <T>(task: () => T) => session.enqueueAfterGesture(signal, task);
    return {
        add(): Promise<void> {
            return queue(() => { addPage(session.doc, session).release(); });
        },
        paper(next: Readonly<NotebookPaper>): Promise<void> {
            const host = session.doc.host;
            if (host.kind !== 'notebook') return Promise.reject(new StructureRefused('Not a notebook'));
            const before = host.paper;
            const patch = {
                ...(next.size !== before.size ? { size: next.size } : {}),
                ...(next.orientation !== before.orientation ? { orientation: next.orientation } : {}),
                ...(next.ruling !== before.ruling ? { ruling: next.ruling } : {}),
                ...(next.spacing !== before.spacing ? { spacing: next.spacing } : {}),
                ...(next.margin !== before.margin ? { margin: next.margin } : {}),
            };
            return queue(() => {
                const doc = session.doc;
                if (doc.host.kind !== 'notebook') throw new StructureRefused('Not a notebook');
                if (Object.keys(patch).length) changePaper(doc, session, { ...doc.host.paper, ...patch }).release();
            });
        },
        reorder(from: number, to: number): Promise<void> {
            return queue(() => {
                const page = currentPage();
                reorderPage(session.doc, session, from, to)?.release();
                if (from === to) return;
                const moved = page === from ? to : from < to && page > from && page <= to ? page - 1
                    : from > to && page >= to && page < from ? page + 1 : page;
                if (moved !== page) selectPage(moved);
            });
        },
        async removeLast(): Promise<void> {
            const doc = session.doc, contents = lastPageContents(doc), revision = doc.rev;
            if (!await confirmDelete(contents) || signal.aborted) return;
            await queue(() => {
                const latest = session.doc;
                if (latest.rev !== revision) throw new StructureRefused('Board changed; confirm deletion again');
                if (latest.host.kind !== 'notebook') throw new StructureRefused('Not a notebook');
                const last = latest.host.paper.pageCount - 1;
                deleteLastPage(latest, session, geometry()).release();
                if (currentPage() >= last) selectPage(last - 1);
            });
        },
    };
}
