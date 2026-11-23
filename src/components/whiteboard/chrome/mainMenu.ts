import type { ContextMenuCommand, ContextMenuEntry, ContextMenuSeparator, ContextMenuSubmenu } from '../../../utils/contextMenu';
import { commandRow, type BoardCommandSource, type CommandState } from './boardCommands';

export type MainAction = 'uploadMedia' | 'insertEmbed' | 'unlockAll' | 'convertToBookmark' | 'convertToEmbed'
    | 'zoomIn' | 'zoomOut' | 'zoomToFit' | 'zoomToSelection' | 'zoomTo100' | 'toggleMinimap'
    | 'exportPng' | 'exportSvg' | 'exportPdf' | 'exportJson' | 'print' | 'keyboardShortcuts';
export type MainSection = 'edit' | 'view' | 'export' | 'preferences';

export interface MainMenuSource extends BoardCommandSource {
    actionLabel(id: MainAction): string;
    actionShortcut(id: MainAction): string | undefined;
    actionState(id: MainAction): CommandState;
    runAction(id: MainAction): void | Promise<void>;
    sectionLabel(id: MainSection): string;
    readonly preferences: ContextMenuSubmenu['entries'];
    /** Top level, not under Preferences. */
    readonly language?: ContextMenuSubmenu | null;
    readonly copyAsLabel: string;
    readonly transparentLabel: string;
    readonly transparent: boolean;
    readonly debugMode: boolean;
    toggleTransparent(): void;
}

/** The main menu writes its chords as '⌘ I' (the context menus keep '⌘I'). */
export function spacedChord(chord: string | undefined): string | undefined {
    return chord?.replace(/([⌘⇧⌥⌃])(?=\S)/gu, '$1 ');
}

export function mainMenuEntries(source: MainMenuSource): ContextMenuEntry[] {
    const command = (id: Parameters<BoardCommandSource['run']>[0]): ContextMenuCommand => {
        const row = commandRow(source, id);
        return { ...row, shortcut: spacedChord(row.shortcut) };
    };
    const action = (id: MainAction): ContextMenuCommand => {
        const state = source.actionState(id);
        // Keyboard shortcuts… is an opener, not a command with a chord of its own: it keeps the ellipsis and no chord.
        const shortcut = id === 'keyboardShortcuts' ? undefined : spacedChord(source.actionShortcut(id));
        return { kind: 'command', id, label: source.actionLabel(id), shortcut,
            disabled: !state.enabled, reason: state.enabled ? undefined : state.reason, run: () => source.runAction(id) };
    };
    const section = (id: MainSection, entries: ContextMenuSubmenu['entries']): ContextMenuSubmenu => ({
        kind: 'submenu', id, label: source.sectionLabel(id), entries,
    });
    // Groups are separated as the catalogue's Edit menu separates them: history, clipboard and conversions, the Misc
    // shape commands, the lock pair, then Select all.
    const divider = (id: string): ContextMenuSeparator => ({ kind: 'separator', id });
    const transparent: ContextMenuCommand = { kind: 'command', id: 'transparent', label: source.transparentLabel,
        checked: source.transparent, run: () => source.toggleTransparent() };
    const copyAs: ContextMenuSubmenu = { kind: 'submenu', id: 'copyAs', label: source.copyAsLabel,
        entries: [command('copyAsPng'), command('copyAsSvg'), ...(source.debugMode ? [command('copyAsJson')] : []), transparent] };
    return [
        section('edit', [command('undo'), command('redo'), divider('edit-history'),
            command('cut'), command('copy'), command('paste'), command('duplicate'), command('delete'), copyAs, divider('edit-misc'),
            command('group'), command('ungroup'), command('flatten'), command('frameSelection'), command('editLink'),
            command('toggleAutoSize'), command('removeFrame'), command('fitFrame'), action('convertToEmbed'), action('convertToBookmark'),
            divider('edit-lock'), command('toggleLocked'), action('unlockAll'), divider('edit-select'), command('selectAll')]),
        section('view', [action('zoomIn'), action('zoomOut'), action('zoomToFit'), action('zoomToSelection'),
            action('zoomTo100'), action('toggleMinimap')]),
        section('export', [action('exportPng'), action('exportSvg'), action('exportPdf'), action('exportJson'), action('print'), transparent]),
        action('insertEmbed'), action('uploadMedia'),
        { kind: 'separator', id: 'main-divider' },
        section('preferences', source.preferences),
        ...(source.language ? [source.language] : []),
        action('keyboardShortcuts'),
    ];
}
