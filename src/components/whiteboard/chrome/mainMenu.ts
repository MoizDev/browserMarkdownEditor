import type { ContextMenuCommand, ContextMenuEntry, ContextMenuSubmenu } from '../../../utils/contextMenu';
import { commandRow, type BoardCommandSource, type CommandState } from './boardCommands';

export type MainAction = 'uploadMedia' | 'insertEmbed' | 'unlockAll' | 'convertToBookmark' | 'convertToEmbed'
    | 'zoomIn' | 'zoomOut' | 'zoomToFit' | 'zoomToSelection' | 'zoomTo100' | 'toggleMinimap'
    | 'exportPng' | 'exportSvg' | 'keyboardShortcuts';
export type MainSection = 'edit' | 'view' | 'export' | 'preferences';

export interface MainMenuSource extends BoardCommandSource {
    actionLabel(id: MainAction): string;
    actionShortcut(id: MainAction): string | undefined;
    actionState(id: MainAction): CommandState;
    runAction(id: MainAction): void | Promise<void>;
    sectionLabel(id: MainSection): string;
    readonly preferences: ContextMenuSubmenu['entries'];
    readonly copyAsLabel: string;
    readonly transparentLabel: string;
    readonly transparent: boolean;
    readonly debugMode: boolean;
    toggleTransparent(): void;
}

export function mainMenuEntries(source: MainMenuSource): ContextMenuEntry[] {
    const command = (id: Parameters<BoardCommandSource['run']>[0]) => commandRow(source, id);
    const action = (id: MainAction): ContextMenuCommand => {
        const state = source.actionState(id);
        return { kind: 'command', id, label: source.actionLabel(id), shortcut: source.actionShortcut(id),
            disabled: !state.enabled, reason: state.enabled ? undefined : state.reason, run: () => source.runAction(id) };
    };
    const section = (id: MainSection, entries: ContextMenuSubmenu['entries']): ContextMenuSubmenu => ({
        kind: 'submenu', id, label: source.sectionLabel(id), entries,
    });
    const transparent: ContextMenuCommand = { kind: 'command', id: 'transparent', label: source.transparentLabel,
        checked: source.transparent, run: () => source.toggleTransparent() };
    const copyAs: ContextMenuSubmenu = { kind: 'submenu', id: 'copyAs', label: source.copyAsLabel,
        entries: [command('copyAsPng'), command('copyAsSvg'), ...(source.debugMode ? [command('copyAsJson')] : []), transparent] };
    return [
        action('uploadMedia'), action('insertEmbed'),
        section('edit', [command('undo'), command('redo'), command('cut'), command('copy'), command('paste'),
            command('duplicate'), command('delete'), command('selectAll'), copyAs, command('group'), command('ungroup'),
            command('flatten'), command('frameSelection'), command('toggleLocked'), action('unlockAll'),
            action('convertToBookmark'), action('convertToEmbed')]),
        section('view', [action('zoomIn'), action('zoomOut'), action('zoomToFit'), action('zoomToSelection'),
            action('zoomTo100'), action('toggleMinimap')]),
        section('export', [action('exportPng'), action('exportSvg'), transparent]),
        section('preferences', source.preferences),
        action('keyboardShortcuts'),
    ];
}
