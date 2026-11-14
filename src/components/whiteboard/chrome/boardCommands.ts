import type { ContextMenuCommand, ContextMenuEntry } from '../../../utils/contextMenu';

export type BoardCommand =
    | 'undo' | 'redo' | 'delete' | 'duplicate' | 'cut' | 'copy' | 'paste' | 'selectAll'
    | 'group' | 'ungroup' | 'flatten' | 'editLink' | 'frameSelection' | 'toggleLocked'
    | 'alignLeft' | 'alignHorizontal' | 'alignRight' | 'alignTop' | 'alignVertical' | 'alignBottom'
    | 'stretchHorizontal' | 'stretchVertical' | 'distributeHorizontal' | 'distributeVertical'
    | 'stackHorizontal' | 'stackVertical' | 'pack' | 'sendBack' | 'sendBackward'
    | 'bringForward' | 'bringFront' | 'rotateCounterclockwise' | 'rotateClockwise'
    | 'copyAsPng' | 'copyAsSvg' | 'copyAsJson' | 'exportPng' | 'exportSvg';

export type CommandState =
    | { readonly enabled: true }
    | { readonly enabled: false; readonly reason: string };

export interface BoardCommandSource {
    label(id: BoardCommand): string;
    shortcut(id: BoardCommand): string | undefined;
    state(id: BoardCommand): CommandState;
    run(id: BoardCommand): void | Promise<void>;
}

export function commandRow(source: BoardCommandSource, id: BoardCommand): ContextMenuCommand {
    const state = source.state(id);
    return {
        kind: 'command', id, label: source.label(id), shortcut: source.shortcut(id), disabled: !state.enabled,
        reason: state.enabled ? undefined : state.reason, run: () => source.run(id),
    };
}

export const actionCommands: readonly BoardCommand[] = [
    'alignLeft', 'alignHorizontal', 'alignRight', 'alignTop', 'alignVertical', 'alignBottom',
    'stretchHorizontal', 'stretchVertical', 'distributeHorizontal', 'distributeVertical',
    'stackHorizontal', 'stackVertical', 'sendBack', 'sendBackward', 'bringForward', 'bringFront',
    'rotateCounterclockwise', 'rotateClockwise', 'editLink', 'group',
];

export type ContextSection = 'edit' | 'arrange' | 'reorder' | 'moveToPage' | 'copyAs' | 'exportAs';

export interface BoardContextMenuSource extends BoardCommandSource {
    sectionLabel(section: ContextSection): string;
    readonly selectedCount: number;
    readonly canUngroup: boolean;
    readonly debugMode: boolean;
    readonly transparent: boolean;
    readonly transparentLabel: string;
    readonly noPagesReason: string;
    toggleTransparent(): void;
    readonly pages: readonly { id: string; label: string; enabled: boolean; reason?: string }[];
    readonly extraEntries?: readonly ContextMenuEntry[];
    moveToPage(id: string): void;
}

export function contextEntries(source: BoardContextMenuSource): ContextMenuEntry[] {
    const rows = (ids: readonly BoardCommand[]) => ids.map(id => commandRow(source, id));
    const menu = (id: ContextSection, entries: ContextMenuCommand[]): ContextMenuEntry => ({
        kind: 'submenu', id, label: source.sectionLabel(id), entries,
        disabled: entries.length === 0, reason: entries.length === 0 ? source.noPagesReason : undefined,
    });
    const common = rows(['cut', 'copy', 'paste', 'duplicate', 'delete']);
    const copyAs = menu('copyAs', [
        ...rows(['copyAsPng', 'copyAsSvg', ...(source.debugMode ? ['copyAsJson' as const] : [])]),
        { kind: 'command', id: 'transparent', label: source.transparentLabel,
            checked: source.transparent, run: () => source.toggleTransparent() },
    ]);
    const selected: ContextMenuEntry[] = source.selectedCount ? [
        menu('edit', rows([
            ...(source.canUngroup ? ['ungroup' as const] : source.selectedCount > 1 ? ['group' as const] : []),
            'flatten', ...(source.selectedCount === 1 ? ['editLink' as const] : ['frameSelection' as const]),
            'toggleLocked',
        ])),
        menu('arrange', rows([
            'alignLeft', 'alignHorizontal', 'alignRight', 'alignTop', 'alignVertical', 'alignBottom',
            'stretchHorizontal', 'stretchVertical', 'distributeHorizontal', 'distributeVertical',
            'stackHorizontal', 'stackVertical', 'pack',
        ])),
        menu('reorder', rows(['sendBack', 'sendBackward', 'bringForward', 'bringFront'])),
        menu('moveToPage', source.pages.map(page => ({
            kind: 'command', id: page.id, label: page.label, disabled: !page.enabled,
            reason: page.reason, run: () => source.moveToPage(page.id),
        }))),
    ] : [];
    return [
        ...selected, ...(source.extraEntries ?? []), ...common, copyAs,
        ...(source.selectedCount ? [menu('exportAs', rows(['exportPng', 'exportSvg']))] : []),
        ...rows(['selectAll']),
    ];
}
