import type { NotebookPaper } from '../../utils/paper';
import type { SheetId } from '../model/ids';
import type { SelectionSnapshot } from '../selection';
import { createStructureCommands, type StructureCommandsOptions } from './structureCommands';

export interface StructureControlsOptions extends Omit<StructureCommandsOptions, 'geometry'> {
    readonly newSheetName: () => string;
    /** The attached view may be less privileged than its shared document session. */
    readonly canWrite?: () => boolean;
    /** Current zero-based physical page and the view's real navigation operation. */
    readonly readPage: () => number;
    readonly jump: (page: number) => void;
}

/** A thin view of the live document; all mutations stay in the session command backend. */
export function createStructureControls(options: StructureControlsOptions) {
    const { runtime } = options, session = runtime.session, doc = session.doc;
    const commands = createStructureCommands({ ...options, geometry: runtime.render.changeGeometry,
        current: () => options.current() && (options.canWrite?.() ?? true) && !session.isGestureActive });
    const live = () => {
        if (!options.current()) throw new DOMException('Board session ended', 'AbortError');
    };
    const editable = () => {
        live();
        if (session.isReadOnly || options.canWrite?.() === false) throw new Error(session.readOnlyReason ?? 'Board view is read-only');
        if (session.isGestureActive) throw new Error('Finish the current gesture first');
    };
    let cached: { revision: number; selection: SelectionSnapshot; value: {
        readonly sheets: readonly { readonly id: SheetId; readonly name: string }[];
        readonly current: SheetId; readonly canCreate: boolean;
    } } | undefined;
    const snapshot = () => {
        live();
        const selection = runtime.selection.getSnapshot();
        if (cached?.revision === doc.rev && cached.selection === selection) return cached.value;
        const value = Object.freeze({ sheets: Object.freeze(doc.sheetOrder.map(sheet => Object.freeze({ id: sheet.id, name: sheet.name }))),
            current: selection.sheet, canCreate: doc.sheetOrder.length < 40 });
        cached = { revision: doc.rev, selection, value };
        return value;
    };
    const paper = (): Readonly<NotebookPaper> => {
        live();
        if (doc.host.kind !== 'notebook') throw new Error('Physical pages are only available in a notebook');
        return Object.freeze({ ...doc.host.paper });
    };
    const clampPage = () => {
        const count = paper().pageCount, page = options.readPage();
        if (!Number.isInteger(page)) throw new Error('Current page is unavailable');
        const clamped = Math.max(0, Math.min(count - 1, page));
        if (clamped !== page) options.jump(clamped);
    };
    return {
        snapshot,
        selectSheet(id: SheetId) {
            live();
            if (!doc.sheets.has(id)) throw new Error('Sheet no longer exists');
            runtime.selection.setSheet(id);
        },
        createSheet() {
            editable();
            const id = commands.addSheet(options.newSheetName());
            if (id && options.current() && doc.sheets.has(id)) runtime.selection.setSheet(id);
            return id;
        },
        duplicateSheet(id: SheetId) {
            editable();
            const created = commands.duplicateSheet(id);
            if (created && options.current() && doc.sheets.has(created)) runtime.selection.setSheet(created);
            return created;
        },
        renameSheet(id: SheetId, name: string) { editable(); return commands.renameSheet(id, name); },
        moveSheet(id: SheetId, destination: number) { editable(); return commands.reorderSheet(id, destination); },
        async deleteSheet(id: SheetId) { editable(); return commands.deleteSheet(id); },
        paper,
        readPage() { live(); return options.readPage(); },
        jump(page: number) {
            const count = paper().pageCount;
            if (!Number.isInteger(page) || page < 0 || page >= count) throw new RangeError('Invalid notebook page');
            options.jump(page);
        },
        changePaper(next: Readonly<NotebookPaper>) {
            editable();
            if (next.pageCount !== paper().pageCount) throw new Error('Use the page controls to change the page count');
            const changed = commands.changePaper(next);
            if (changed && options.current()) clampPage();
            return changed;
        },
        addPage() {
            editable();
            const changed = commands.addPage();
            if (changed && options.current()) clampPage();
            return changed;
        },
        /** The viewer follows its page through a move: the page that was current stays current. */
        reorderPage(from: number, to: number) {
            editable();
            const page = options.readPage();
            const changed = commands.reorderPage(from, to);
            if (changed && options.current()) {
                const moved = page === from ? to : from < to && page > from && page <= to ? page - 1
                    : from > to && page >= to && page < from ? page + 1 : page;
                if (moved !== page) options.jump(moved);
            }
            return changed;
        },
        async deleteLastPage() {
            editable();
            const last = paper().pageCount - 1;
            const changed = await commands.deleteLastPage(last);
            if (changed && options.current()) clampPage();
            return changed;
        },
    };
}
