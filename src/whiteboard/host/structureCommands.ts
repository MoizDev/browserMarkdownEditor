import type { NotebookPaper } from '../../utils/paper';
import type { ChangeGeometry } from '../change/coordinates';
import type { Applied } from '../change/ops';
import * as commands from '../commands/pagesAndSheets';
import { childrenOf } from '../model/doc';
import { newSheetId, type SheetId } from '../model/ids';
import type { BoardRuntime } from './runtime';
import type { Node } from '../model/nodes';

export interface StructureCommandsOptions {
    readonly runtime: BoardRuntime;
    readonly geometry: ChangeGeometry;
    current(): boolean;
    confirm(question: { title: string; body: string; confirmLabel: string; danger?: boolean }): Promise<boolean>;
    onError(error: unknown): void;
}

/** Structural commands act on the App-owned session, never a view-local document. */
export function createStructureCommands(options: StructureCommandsOptions) {
    const board = options.runtime.session, doc = board.doc;
    const guard = () => {
        if (!options.current()) throw new DOMException('Board session ended', 'AbortError');
        if (board.isReadOnly) throw new Error(board.readOnlyReason ?? 'Board is read-only');
    };
    const apply = (receipt: Applied | undefined): boolean => {
        if (!receipt) return false;
        receipt.release();
        return true;
    };
    const report = (error: unknown) => { if (!(error instanceof DOMException && error.name === 'AbortError')) options.onError(error); };
    const run = (action: () => Applied | undefined): boolean => {
        try { guard(); return apply(action()); } catch (error) { report(error); return false; }
    };
    const sheetExists = (id: SheetId) => {
        if (!doc.sheets.has(id)) throw new commands.StructureRefused('Sheet no longer exists');
    };
    return {
        addSheet(name: string): SheetId | undefined {
            try {
                guard();
                const id = newSheetId(doc);
                apply(commands.addSheet(doc, board, id, name));
                return id;
            } catch (error) { report(error); return undefined; }
        },
        duplicateSheet(source: SheetId, name?: string): SheetId | undefined {
            try {
                guard(); sheetExists(source);
                const id = newSheetId(doc);
                apply(commands.duplicateSheet(doc, board, source, id, name));
                return id;
            } catch (error) { report(error); return undefined; }
        },
        renameSheet(id: SheetId, name: string): boolean {
            return run(() => { sheetExists(id); return commands.renameSheet(board, id, name); });
        },
        reorderSheet(id: SheetId, destination: number): boolean {
            return run(() => { sheetExists(id); return commands.reorderSheet(doc, board, id, destination); });
        },
        async deleteSheet(id: SheetId): Promise<boolean> {
            try {
                guard(); sheetExists(id);
                if (doc.sheets.size <= 1) throw new commands.StructureRefused('A board must keep one sheet');
                const revision = doc.rev, sheet = doc.sheets.get(id)!;
                const contents = commands.deletionContents(doc, childrenOf(doc, id).map(node => node.id));
                const detail = commands.describePageContents(contents);
                if (!await options.confirm({ title: 'Delete sheet?', body: detail
                    ? `Delete “${sheet.name}” and its ${detail}?` : `Delete the empty sheet “${sheet.name}”?`,
                confirmLabel: 'Delete sheet', danger: true })) return false;
                guard(); sheetExists(id);
                if (doc.rev !== revision) throw new DOMException('Board changed while confirming', 'AbortError');
                return apply(commands.deleteSheet(doc, board, id));
            } catch (error) { report(error); return false; }
        },
        changePaper(paper: Readonly<NotebookPaper>): boolean { return run(() => commands.changePaper(doc, board, paper)); },
        reorderPage(from: number, to: number): boolean { return run(() => commands.reorderPage(doc, board, from, to)); },
        addPage(): boolean { return run(() => commands.addPage(doc, board)); },
        async deleteLastPage(expectedPage: number): Promise<boolean> {
            try {
                guard();
                if (doc.host.kind !== 'notebook' || !Number.isInteger(expectedPage) || expectedPage !== doc.host.paper.pageCount - 1) {
                    throw new commands.StructureRefused('The last page changed');
                }
                const revision = doc.rev, removable = commands.lastPageContents(doc);
                const contents: Node[] = [];
                const visit = (node: Node) => { contents.push(node); for (const child of childrenOf(doc, node.id)) visit(child); };
                for (const id of doc.byPage.get(expectedPage) ?? []) {
                    const node = doc.nodes.get(id);
                    if (!node) throw new commands.StructureRefused('Content no longer exists');
                    visit(node);
                }
                const detail = commands.describePageContents(contents);
                const kept = contents.length - removable.length;
                // An empty page goes without a question; a page with content names exactly what it will delete (WB-D29).
                if (detail && !await options.confirm({ title: `Delete page ${expectedPage + 1}?`,
                    body: `It has ${detail} on it, which will be deleted with it.${kept ? ` ${kept} locked or unsupported item${kept === 1 ? ' is' : 's are'} kept.` : ''}`,
                    confirmLabel: 'Delete page', danger: true })) return false;
                guard();
                if (doc.rev !== revision || doc.host.kind !== 'notebook' || doc.host.paper.pageCount - 1 !== expectedPage) {
                    throw new DOMException('Board changed while confirming', 'AbortError');
                }
                return apply(commands.deleteLastPage(doc, board, options.geometry));
            } catch (error) { report(error); return false; }
        },
    };
}
