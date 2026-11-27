import { openContextMenu, type ContextMenuEntry } from '../../utils/contextMenu';
import { createBoardSelectionCommands } from '../../whiteboard/commands/selection';
import { createPageMoveBackend } from '../../whiteboard/commands/moveSelectionPage';
import { ungroupEligibility } from '../../whiteboard/commands/selection';
import type { BoardLanguageState } from '../../whiteboard/chrome/language';
import { translateBoard } from '../../whiteboard/chrome/language';
import type { BoardPreferenceState } from '../../whiteboard/chrome/preferences';
import type { BoardRuntime } from '../../whiteboard/host/runtime';
import type { NativeEmbedController } from '../../whiteboard/host/nativeEmbeds';
import type { NodeId } from '../../whiteboard/model/ids';
import type { KeyboardContextRequest } from '../../whiteboard/viewer/keyboardContext';
import type { BoardContextMenuRequest } from '../../whiteboard/viewer/toolServices';
import { contextEntries, type BoardCommand, type BoardCommandSource, type MenuRow } from './chrome/boardCommands';
import { localizeBoardChrome } from './chrome/localize';
import { mediaRows, type MediaRowOptions, type MediaRowSelection } from './nativeMediaRows';
import { NEW_SHEET_NAME } from '../../whiteboard/host/structureControls';

export interface MediaMenuSource extends Omit<MediaRowOptions, 'current' | 'notice' | 'text'> {
    readonly selection: (writable: boolean) => MediaRowSelection | null;
}

export function createNativeBoardContextMenu(options: {
    readonly runtime: BoardRuntime;
    readonly commands: BoardCommandSource;
    readonly language: BoardLanguageState;
    readonly preferences: BoardPreferenceState;
    readonly embed: () => NativeEmbedController | null;
    readonly openLink: (url: string) => void;
    readonly media: () => MediaMenuSource | null;
    readonly current: () => boolean;
    readonly canWrite: () => boolean;
    readonly notice: (message: string) => void;
    readonly zoom: () => number;
}) {
    const { runtime } = options, session = runtime.session, backend = createPageMoveBackend(runtime);
    const locks = createBoardSelectionCommands({ runtime, current: options.current, zoom: options.zoom });
    const entriesAt = (expected?: KeyboardContextRequest['selection'], locked: NodeId | null = null) => {
        if (!options.current()) return null;
        const selection = runtime.selection.getSnapshot(), revision = session.doc.rev;
        if (expected && expected !== selection) return null;
        const same = () => options.current() && session.doc.rev === revision && runtime.selection.getSnapshot() === selection;
        const safeRun = (id: BoardCommand) => {
            if (!same()) { options.notice('The selection changed; open the menu again.'); return; }
            if (options.commands.state(id).enabled) return options.commands.run(id);
        };
        const lang = options.language.getSnapshot(), t = (key: string, values?: Readonly<Record<string, string | number>>) => translateBoard(lang.table, key, values);
        const labels = localizeBoardChrome(t), selected = selection.selected;
        const preferences = options.preferences.getSnapshot(), embed = options.embed();
        const node = selected.length === 1 ? session.doc.nodes.get(selected[0]) : undefined;
        const extra: MenuRow[] = [];
        if (embed && node?.kind === 'embed') {
            const state = embed.state(node.id);
            extra.push({ kind: 'command', id: 'embed-load', label: state === 'loaded' ? 'Unload embed' : state === 'loading' ? 'Loading embed…' : 'Load embed',
                disabled: state === 'loading', run() {
                    if (!same()) { options.notice('The selection changed; open the menu again.'); return; }
                    const pending = state === 'loaded' ? embed.unload(node.id) : embed.load(node.id);
                    void pending.catch(error => options.notice(error instanceof Error ? error.message : String(error)));
                } });
        }
        if (node?.kind === 'linkcard' || node?.kind === 'embed') {
            const url = node.url;
            extra.push({ kind: 'command', id: 'card-open-link', label: 'Open link', run() {
                if (!same()) { options.notice('The selection changed; open the menu again.'); return; }
                try { options.openLink(url); } catch (error) { options.notice(error instanceof Error ? error.message : String(error)); }
            } });
        }
        const mediaSource = options.media();
        const picture = mediaSource ? mediaSource.selection(options.canWrite()) : null;
        if (picture && mediaSource) {
            const rows = mediaRows(picture, { ...mediaSource, current: same, notice: options.notice,
                text: key => t(key) });
            if (rows.length) extra.push({ kind: 'separator', id: 'media-separator' }, ...rows);
        }
        const lockedId = locked !== null && session.doc.nodes.get(locked)?.locked ? locked : null;
        if (lockedId !== null) extra.push({ kind: 'command', id: 'toggle-locked-target', label: labels.commandLabel('toggleLocked'),
            disabled: !options.canWrite(), ...(!options.canWrite() ? { reason: 'Board view is read-only' } : {}), run() {
                if (!options.current() || session.doc.rev !== revision || !options.canWrite()) { options.notice('The board changed; open the menu again.'); return; }
                void locks.toggleLocked([lockedId]).catch(error => options.notice(error instanceof Error ? error.message : String(error)));
            } });
        const pages = backend.targets().map(page => ({ id: page.id, label: page.label,
            enabled: page.enabled && options.canWrite(), ...(!page.enabled || !options.canWrite() ? { reason: page.reason ?? 'Board view is read-only' } : {}) }));
        const newSheetBlock = backend.newSheetBlock();
        const newSheetReason = !options.canWrite() ? 'Board view is read-only' : newSheetBlock === 'sheet-limit' ? 'Maximum pages reached' : newSheetBlock;
        const newPage = { label: labels.text('newSheet'), enabled: newSheetReason === undefined, reason: newSheetReason,
            run() {
                if (!same() || !options.canWrite()) throw new Error('The board view or selection changed');
                backend.moveToNewSheet(NEW_SHEET_NAME);
            } };
        const source = { ...options.commands, run: safeRun, sectionLabel: labels.contextSectionLabel,
            selectedCount: selected.length, textSelected: selected.some(id => session.doc.nodes.get(id)?.kind === 'text'), canUngroup: ungroupEligibility(session.doc, selected, selection).enabled,
            debugMode: preferences.view.debugMode, transparent: preferences.view.transparent,
            transparentLabel: labels.text('transparent'), ...(!options.canWrite() ? { transparentDisabledReason: 'Board view is read-only' } : {}),
            noPagesReason: 'No eligible pages', pages, newPage, extraEntries: extra,
            toggleTransparent() {
                if (!same() || !options.canWrite()) throw new Error('The board view or selection changed');
                options.preferences.setView('transparent', !options.preferences.getSnapshot().view.transparent);
            },
            moveToPage(id: string) {
                if (!same() || !options.canWrite()) throw new Error('The board view or selection changed');
                backend.moveToPage(id);
            } };
        return { lang, entries: contextEntries(source) };
    };
    const openAt = (point: { x: number; y: number }, opener: HTMLElement, expected?: KeyboardContextRequest['selection'], locked: NodeId | null = null) => {
        const built = entriesAt(expected, locked);
        if (built) openContextMenu({ x: point.x, y: point.y, label: 'Board', opener,
            lang: built.lang.locale, dir: built.lang.table.dir, entries: built.entries });
    };
    return {
        pointer(request: BoardContextMenuRequest) { openAt(request.point, request.opener, undefined, request.locked); },
        keyboard(request: KeyboardContextRequest) { openAt(request.client, request.opener, request.selection); },
        selectionEntries(): ContextMenuEntry[] {
            const entries = entriesAt()?.entries ?? [];
            const common = entries.findIndex(entry => entry.kind === 'command' && entry.id === 'cut');
            return common > 0 ? entries.slice(0, common) : [];
        },
    };
}
