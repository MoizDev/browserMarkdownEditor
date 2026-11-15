import { openContextMenu, type ContextMenuEntry } from '../../utils/contextMenu';
import { createPageMoveBackend } from '../../whiteboard/commands/moveSelectionPage';
import { ungroupEligibility } from '../../whiteboard/commands/selection';
import type { BoardLanguageState } from '../../whiteboard/chrome/language';
import { translateBoard } from '../../whiteboard/chrome/language';
import type { BoardPreferenceState } from '../../whiteboard/chrome/preferences';
import type { BoardRuntime } from '../../whiteboard/host/runtime';
import type { NativeEmbedController } from '../../whiteboard/host/nativeEmbeds';
import type { KeyboardContextRequest } from '../../whiteboard/viewer/keyboardContext';
import { contextEntries, type BoardCommand, type BoardCommandSource } from './chrome/boardCommands';
import { localizeBoardChrome } from './chrome/localize';
import { mediaRows, type MediaRowOptions, type MediaRowSelection } from './nativeMediaRows';

export interface MediaMenuSource extends Omit<MediaRowOptions, 'current' | 'notice' | 'text'> {
    readonly selection: (writable: boolean) => MediaRowSelection | null;
}

/** Every context row belongs to the actual selection and revision which raised the menu. */
export function createNativeBoardContextMenu(options: {
    readonly runtime: BoardRuntime;
    readonly commands: BoardCommandSource;
    readonly language: BoardLanguageState;
    readonly preferences: BoardPreferenceState;
    readonly embed: () => NativeEmbedController | null;
    /** The picture or card rows for this view; edit mode's menu is the only one a right-click opens. */
    readonly media: () => MediaMenuSource | null;
    readonly current: () => boolean;
    readonly canWrite: () => boolean;
    readonly notice: (message: string) => void;
}) {
    const { runtime } = options, session = runtime.session, backend = createPageMoveBackend(runtime);
    const openAt = (point: { x: number; y: number }, opener: HTMLElement, expected?: KeyboardContextRequest['selection']) => {
        if (!options.current()) return;
        const selection = runtime.selection.getSnapshot(), revision = session.doc.rev;
        if (expected && expected !== selection) return;
        const same = () => options.current() && session.doc.rev === revision && runtime.selection.getSnapshot() === selection;
        const safeRun = (id: BoardCommand) => {
            if (!same()) { options.notice('The selection changed; open the menu again.'); return; }
            if (options.commands.state(id).enabled) return options.commands.run(id);
        };
        const lang = options.language.getSnapshot(), t = (key: string, values?: Readonly<Record<string, string | number>>) => translateBoard(lang.table, key, values);
        const labels = localizeBoardChrome(t), selected = selection.selected;
        const preferences = options.preferences.getSnapshot(), embed = options.embed();
        const node = selected.length === 1 ? session.doc.nodes.get(selected[0]) : undefined;
        const extra: ContextMenuEntry[] = [];
        if (embed && node?.kind === 'embed') {
            const state = embed.state(node.id);
            extra.push({ kind: 'command', id: 'embed-load', label: state === 'loaded' ? 'Unload embed' : state === 'loading' ? 'Loading embed…' : 'Load embed',
                disabled: state === 'loading', run() {
                    if (!same()) { options.notice('The selection changed; open the menu again.'); return; }
                    const pending = state === 'loaded' ? embed.unload(node.id) : embed.load(node.id);
                    void pending.catch(error => options.notice(error instanceof Error ? error.message : String(error)));
                } });
        }
        const mediaSource = options.media();
        const picture = mediaSource ? mediaSource.selection(options.canWrite()) : null;
        if (picture && mediaSource) {
            const rows = mediaRows(picture, { ...mediaSource, current: same, notice: options.notice,
                text: (key, fallback) => lang.table.strings[key] !== undefined ? t(key) : fallback });
            if (rows.length) extra.push({ kind: 'separator', id: 'media-separator' }, ...rows);
        }
        const pages = backend.targets().map(page => ({ id: page.id, label: page.label,
            enabled: page.enabled && options.canWrite(), ...(!page.enabled || !options.canWrite() ? { reason: page.reason ?? 'Board view is read-only' } : {}) }));
        const source = { ...options.commands, run: safeRun, sectionLabel: labels.contextSectionLabel,
            selectedCount: selected.length, canUngroup: ungroupEligibility(session.doc, selected, selection).enabled,
            debugMode: preferences.view.debugMode, transparent: preferences.view.transparent,
            transparentLabel: labels.text('transparent'), ...(!options.canWrite() ? { transparentDisabledReason: 'Board view is read-only' } : {}),
            noPagesReason: 'No eligible pages', pages, extraEntries: extra,
            toggleTransparent() {
                if (!same() || !options.canWrite()) throw new Error('The board view or selection changed');
                options.preferences.setView('transparent', !options.preferences.getSnapshot().view.transparent);
            },
            moveToPage(id: string) {
                if (!same() || !options.canWrite()) throw new Error('The board view or selection changed');
                backend.moveToPage(id);
            } };
        openContextMenu({ x: point.x, y: point.y, label: 'Board', opener,
            lang: lang.locale, dir: lang.table.dir, entries: contextEntries(source) });
    };
    return {
        pointer(event: MouseEvent) {
            event.preventDefault();
            const opener = event.currentTarget instanceof HTMLElement ? event.currentTarget : document.activeElement;
            if (opener instanceof HTMLElement) openAt({ x: event.clientX, y: event.clientY }, opener);
        },
        keyboard(request: KeyboardContextRequest) { openAt(request.client, request.opener, request.selection); },
    };
}
