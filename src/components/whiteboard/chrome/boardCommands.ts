import type { ContextMenuCommand, ContextMenuEntry, ContextMenuSeparator, ContextMenuSubmenu } from '../../../utils/contextMenu';

/** A row a submenu holds: the grid and label kinds only appear at a menu's top level. */
export type MenuRow = ContextMenuSubmenu['entries'][number];

export type BoardCommand =
    | 'undo' | 'redo' | 'delete' | 'duplicate' | 'cut' | 'copy' | 'paste' | 'selectAll'
    | 'group' | 'ungroup' | 'flatten' | 'editLink' | 'frameSelection' | 'removeFrame' | 'fitFrame' | 'toggleLocked' | 'toggleAutoSize'
    | 'convertToBookmark' | 'convertToEmbed'
    | 'alignLeft' | 'alignHorizontal' | 'alignRight' | 'alignTop' | 'alignVertical' | 'alignBottom'
    | 'stretchHorizontal' | 'stretchVertical' | 'distributeHorizontal' | 'distributeVertical' | 'flipHorizontal' | 'flipVertical'
    | 'stackHorizontal' | 'stackVertical' | 'pack' | 'sendBack' | 'sendBackward'
    | 'bringForward' | 'bringFront' | 'rotateCounterclockwise' | 'rotateClockwise'
    | 'copyAsPng' | 'copyAsSvg' | 'copyAsJson' | 'exportPng' | 'exportSvg' | 'exportJson';

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

/** The Actions grid, four to a row, in this order; its last slot is Group, or Ungroup for a group. */
export const actionCommands: readonly BoardCommand[] = [
    'alignLeft', 'alignHorizontal', 'alignRight', 'stretchHorizontal',
    'alignTop', 'alignVertical', 'alignBottom', 'stretchVertical',
    'distributeHorizontal', 'distributeVertical', 'stackHorizontal', 'stackVertical',
    'sendBack', 'sendBackward', 'bringForward', 'bringFront',
    'rotateCounterclockwise', 'rotateClockwise', 'editLink', 'group',
];

/** Move to page names are cut to this many characters, then "…" (the catalogue's rule, so a long sheet name cannot widen the menu). */
export const MOVE_TARGET_LABEL_LIMIT = 30;
export function moveTargetLabel(name: string): string {
    return name.length > MOVE_TARGET_LABEL_LIMIT ? `${name.slice(0, MOVE_TARGET_LABEL_LIMIT)}…` : name;
}

export type ContextSection = 'edit' | 'arrange' | 'reorder' | 'moveToPage' | 'copyAs' | 'exportAs';

export interface BoardContextMenuSource extends BoardCommandSource {
    sectionLabel(section: ContextSection): string;
    readonly selectedCount: number;
    readonly canUngroup: boolean;
    readonly debugMode: boolean;
    readonly transparent: boolean;
    readonly transparentLabel: string;
    readonly transparentDisabledReason?: string;
    /** The selection holds text, so Toggle auto size is offered (it is enabled only for fixed-width text). */
    readonly textSelected: boolean;
    readonly noPagesReason: string;
    toggleTransparent(): void;
    readonly pages: readonly { id: string; label: string; enabled: boolean; reason?: string }[];
    /** "New page" under Move to page: a sheet made for the selection in one history step. */
    readonly newPage?: { readonly label: string; readonly enabled: boolean; readonly reason?: string; run(): void };
    readonly extraEntries?: readonly MenuRow[];
    moveToPage(id: string): void;
}

const separator = (id: string): ContextMenuSeparator => ({ kind: 'separator', id });

export function contextEntries(source: BoardContextMenuSource): ContextMenuEntry[] {
    const rows = (ids: readonly BoardCommand[]): ContextMenuCommand[] => ids.map(id => commandRow(source, id));
    const menu = (id: ContextSection, entries: MenuRow[], noTargets = false): ContextMenuSubmenu => ({
        kind: 'submenu', id, label: source.sectionLabel(id), entries,
        disabled: noTargets, reason: noTargets ? source.noPagesReason : undefined,
    });
    // Rows are grouped the way the catalogue's menus are; a separator sits between groups, never at either end.
    const groups = (...groupsOfRows: (readonly MenuRow[])[]): MenuRow[] => groupsOfRows
        .filter(group => group.length > 0)
        .flatMap((group, index) => index === 0 ? group : [separator(`group-${index}`), ...group]);
    const common = rows(['cut', 'copy', 'paste', 'duplicate', 'delete']);
    const copyAs = menu('copyAs', [
        ...rows(['copyAsSvg', 'copyAsPng', ...(source.debugMode ? ['copyAsJson' as const] : [])]),
        separator('copy-as-separator'),
        { kind: 'command', id: 'transparent', label: source.transparentLabel,
            checked: source.transparent, disabled: !!source.transparentDisabledReason, reason: source.transparentDisabledReason,
            run: () => source.toggleTransparent() },
    ]);
    const exportAs = menu('exportAs', [
        ...rows(['exportSvg', 'exportPng', 'exportJson']),
        separator('export-as-separator'),
        { kind: 'command', id: 'transparent', label: source.transparentLabel,
            checked: source.transparent, disabled: !!source.transparentDisabledReason, reason: source.transparentDisabledReason,
            run: () => source.toggleTransparent() },
    ]);
    const pageRows: ContextMenuCommand[] = source.pages.map(page => ({
        kind: 'command', id: page.id, label: moveTargetLabel(page.label), disabled: !page.enabled,
        reason: page.reason, run: () => source.moveToPage(page.id),
    }));
    if (source.newPage) pageRows.push({ kind: 'command', id: 'move-to-new-page', label: source.newPage.label,
        disabled: !source.newPage.enabled, reason: source.newPage.reason, run: () => source.newPage!.run() });
    const selected: MenuRow[] = source.selectedCount ? [
        menu('edit', groups(rows([
            ...(source.canUngroup ? ['ungroup' as const] : source.selectedCount > 1 ? ['group' as const] : []),
            'flatten', ...(source.selectedCount === 1 ? ['editLink' as const] : ['frameSelection' as const]),
            // Frame and conversion rows appear only for a selection they can act on, so other selections keep their menu unchanged.
            ...(source.state('removeFrame').enabled ? ['removeFrame' as const] : []),
            ...(source.state('fitFrame').enabled ? ['fitFrame' as const] : []),
            ...(source.state('convertToEmbed').enabled ? ['convertToEmbed' as const] : []),
            ...(source.state('convertToBookmark').enabled ? ['convertToBookmark' as const] : []),
            ...(source.textSelected ? ['toggleAutoSize' as const] : []),
        ]), rows(['toggleLocked']))),
        menu('arrange', groups(
            rows(['alignLeft', 'alignHorizontal', 'alignRight', 'alignTop', 'alignVertical', 'alignBottom']),
            rows(['distributeHorizontal', 'distributeVertical']),
            rows(['stretchHorizontal', 'stretchVertical']),
            rows(['flipHorizontal', 'flipVertical']),
            rows(['pack', 'stackHorizontal', 'stackVertical']),
        )),
        menu('reorder', rows(['sendBack', 'sendBackward', 'bringForward', 'bringFront'])),
        menu('moveToPage', pageRows, pageRows.length === 0),
    ] : [];
    return [
        ...groups(selected, source.extraEntries ?? [], common, source.selectedCount ? [copyAs, exportAs] : [copyAs],
            rows(['selectAll'])),
    ];
}
