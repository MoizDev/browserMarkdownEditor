import type { ContextMenuCommand, ContextMenuEntry, ContextMenuSeparator, ContextMenuSubmenu } from '../../../utils/contextMenu';

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

export const actionCommands: readonly BoardCommand[] = [
    'alignLeft', 'alignHorizontal', 'alignRight', 'stretchHorizontal',
    'alignTop', 'alignVertical', 'alignBottom', 'stretchVertical',
    'distributeHorizontal', 'distributeVertical', 'stackHorizontal', 'stackVertical',
    'sendBack', 'sendBackward', 'bringForward', 'bringFront',
    'rotateCounterclockwise', 'rotateClockwise', 'editLink', 'group',
];

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
    readonly textSelected: boolean;
    readonly noPagesReason: string;
    toggleTransparent(): void;
    readonly pages: readonly { id: string; label: string; enabled: boolean; reason?: string }[];
    readonly newPage?: { readonly label: string; readonly enabled: boolean; readonly reason?: string; run(): void };
    readonly extraEntries?: readonly MenuRow[];
    moveToPage(id: string): void;
}

export const arrangeCommands: readonly BoardCommand[] = [
    'alignLeft', 'alignHorizontal', 'alignRight', 'alignTop', 'alignVertical', 'alignBottom',
    'stretchHorizontal', 'stretchVertical', 'distributeHorizontal', 'distributeVertical',
    'flipHorizontal', 'flipVertical', 'stackHorizontal', 'stackVertical', 'pack',
];
export const reorderCommands: readonly BoardCommand[] = ['sendBack', 'sendBackward', 'bringForward', 'bringFront'];

export function arrangeSubmenus(source: BoardCommandSource, sectionLabel: (section: ContextSection) => string): ContextMenuSubmenu[] {
    const submenu = (id: 'arrange' | 'reorder', ids: readonly BoardCommand[]): ContextMenuSubmenu => ({
        kind: 'submenu', id, label: sectionLabel(id), entries: ids.map(item => commandRow(source, item)) });
    return [submenu('arrange', arrangeCommands), submenu('reorder', reorderCommands)];
}
const separator = (id: string): ContextMenuSeparator => ({ kind: 'separator', id });

export function contextEntries(source: BoardContextMenuSource): ContextMenuEntry[] {
    const rows = (ids: readonly BoardCommand[]): ContextMenuCommand[] => ids.map(id => commandRow(source, id));
    const menu = (id: ContextSection, entries: MenuRow[], noTargets = false): ContextMenuSubmenu => ({
        kind: 'submenu', id, label: source.sectionLabel(id), entries,
        disabled: noTargets, reason: noTargets ? source.noPagesReason : undefined,
    });
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
