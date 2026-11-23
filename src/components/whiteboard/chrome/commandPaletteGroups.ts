import type { ContextMenuCommand, ContextMenuEntry, ContextMenuSubmenu } from '../../../utils/contextMenu';
import type { CommandState } from './boardCommands';
import type { BoardTranslate } from './localize';
import type { PaletteGroup } from './commandPaletteModel';
import type { ToolChoices } from './toolChoices';

/**
 * The style setters the palette calls: the board's own style controls (host/styleControls.ts, which owns the value lists).
 * Values are plain strings here, so this chrome module stays out of the engine's dark import zone.
 */
export interface PaletteStyleCommands {
    readonly options: {
        readonly colours: readonly string[]; readonly opacities: readonly number[]; readonly fills: readonly string[];
        readonly dashes: readonly string[]; readonly sizes: readonly string[]; readonly fonts: readonly string[]; readonly aligns: readonly string[];
    };
    currentColor(): string | null;
    /** The opacity the selection shares, null when nothing is selected or the items differ. */
    currentOpacity(): number | null;
    /** Opacity is a property of selected shapes only (the style panel offers its row only with a selection), so the palette's row needs one too. */
    hasSelection(): boolean;
    setColor(color: string): void;
    setOpacity(opacity: number): void;
    setFill(fill: string): void;
    setDash(dash: string): void;
    setSize(size: string): void;
    setFont(font: string): void;
    setAlignment(align: string, textAlign: string): void;
    /** The defaults the next shape gets: the values the style rows mark as chosen. */
    nextStyle(): { readonly fill: string; readonly dash: string; readonly size: string; readonly font: string; readonly align: string };
}

export interface PaletteToolSource {
    readonly choices: ToolChoices;
    readonly current: { readonly id: string; readonly figure?: string };
    state(id: string, figure?: string): CommandState;
    select(id: string, figure?: string): void;
}

export interface PaletteSheetSource {
    readonly sheets: readonly { readonly id: string; readonly name: string }[];
    readonly current: string;
    readonly canCreate: boolean;
    select(id: string): void;
    create(): void;
    duplicate(id: string): void;
}

export interface PaletteSources {
    readonly translate: BoardTranslate;
    readonly sectionLabel: (id: 'edit' | 'view' | 'export' | 'preferences') => string;
    /** mainMenuEntries' rows: four sections (submenus with those ids), then the top-level Insert and Help rows and Language. */
    readonly main: readonly ContextMenuEntry[];
    /** preferenceEntries' rows. */
    readonly preferences: readonly SubmenuRow[];
    /** The selection-scoped rows the context menu shows (empty when nothing is selected); the palette keeps only the ones no other group lists. */
    readonly selection: readonly ContextMenuEntry[];
    /** The Arrange and Reorder submenus, listed even with nothing selected: their rows say why they cannot run. */
    readonly arrange: readonly ContextMenuEntry[];
    readonly arrangeLabel: string;
    readonly styles: PaletteStyleCommands | null;
    readonly sheets: PaletteSheetSource | null;
    readonly tools: PaletteToolSource | null;
}

/** The catalogued label key of each style value, keyed by the value. A value without one is shown as it is. */
const FILL_LABELS: Readonly<Record<string, string>> = { none: 'styles.none', semi: 'styles.semi', solid: 'styles.solid', pattern: 'styles.pattern',
    fill: 'styles.fillSolid', 'lined-fill': 'styles.linedFill' };
const DASH_LABELS: Readonly<Record<string, string>> = { draw: 'styles.draw', solid: 'styles.solid', dashed: 'styles.dashed', dotted: 'styles.dotted', none: 'styles.none' };
const SIZE_LABELS: Readonly<Record<string, string>> = { s: 'styles.small', m: 'styles.medium', l: 'styles.large', xl: 'styles.extraLarge' };
const FONT_LABELS: Readonly<Record<string, string>> = { draw: 'styles.draw', sans: 'styles.sans', serif: 'styles.serif', mono: 'styles.mono' };
const ALIGN_LABELS: Readonly<Record<string, string>> = { start: 'styles.start', middle: 'styles.middle', end: 'styles.end' };
/** The sheet menu's limit (SheetMenu.tsx). */
const SHEET_LIMIT = 40;

type SubmenuRow = ContextMenuSubmenu['entries'][number];

function section(entries: readonly ContextMenuEntry[], id: string): readonly ContextMenuEntry[] {
    const found = entries.find((entry): entry is ContextMenuSubmenu => entry.kind === 'submenu' && entry.id === id);
    return found ? found.entries : [];
}

function commandsOf(entries: readonly ContextMenuEntry[], ids: readonly string[]): ContextMenuEntry[] {
    return entries.filter(entry => entry.kind === 'command' && ids.includes(entry.id));
}

/** Removes one row wherever it sits in the tree. */
function withoutRow(entries: readonly SubmenuRow[], id: string): SubmenuRow[] {
    return entries.flatMap((entry): SubmenuRow[] => {
        if (entry.kind === 'command') return entry.id === id ? [] : [entry];
        if (entry.kind === 'submenu') return [{ ...entry, entries: withoutRow(entry.entries, id) }];
        return [entry];
    });
}

/** A submenu of values where exactly one is chosen: every row carries a boolean `checked`, so the menu draws its check column. */
function pickOne(id: string, label: string, rows: readonly { readonly id: string; readonly label: string; readonly checked: boolean; readonly run: () => void }[]): ContextMenuSubmenu {
    return { kind: 'submenu', id, label, entries: rows.map(row => ({ kind: 'command', id: row.id, label: row.label, checked: row.checked, run: row.run })) };
}

function styleSubmenus(styles: PaletteStyleCommands, t: BoardTranslate): ContextMenuSubmenu[] {
    const next = styles.nextStyle(), current = styles.currentColor(), currentOpacity = styles.currentOpacity();
    const labelOf = (labels: Readonly<Record<string, string>>, value: string) => labels[value] ? t(labels[value]) : value;
    const { options } = styles;
    const colour = pickOne('colour', t('styles.colour'), options.colours.map(color => ({
        id: `colour-${color}`, label: t(`colours.${color}`), checked: color === current, run: () => styles.setColor(color),
    })));
    const opacity = styles.hasSelection() ? pickOne('opacity', t('styles.opacity'), options.opacities.map(value => ({
        id: `opacity-${value}`, label: `${Math.round(value * 100)}%`, checked: value === currentOpacity, run: () => styles.setOpacity(value),
    }))) : null;
    const fill = pickOne('fill', t('styles.fill'), options.fills.map(value => ({
        id: `fill-${value}`, label: labelOf(FILL_LABELS, value), checked: value === next.fill, run: () => styles.setFill(value),
    })));
    const dash = pickOne('dash', t('styles.dash'), options.dashes.map(value => ({
        id: `dash-${value}`, label: labelOf(DASH_LABELS, value), checked: value === next.dash, run: () => styles.setDash(value),
    })));
    const size = pickOne('size', t('styles.size'), options.sizes.map(value => ({
        id: `size-${value}`, label: labelOf(SIZE_LABELS, value), checked: value === next.size, run: () => styles.setSize(value),
    })));
    const font = pickOne('font', t('styles.font'), options.fonts.map(value => ({
        id: `font-${value}`, label: labelOf(FONT_LABELS, value), checked: value === next.font, run: () => styles.setFont(value),
    })));
    const alignment = pickOne('alignment', t('styles.alignment'), options.aligns.map(value => ({
        id: `alignment-${value}`, label: labelOf(ALIGN_LABELS, value), checked: value === next.align, run: () => styles.setAlignment(value, value),
    })));
    return [colour, ...(opacity ? [opacity] : []), fill, dash, size, font, alignment];
}

/**
 * The selection's own rows, without the ones another group lists: Arrange and Reorder have their own group, and the Edit
 * submenu's commands are in the main Edit section, except Edit link and Toggle auto size, which only the selection has.
 */
function selectionOnly(selection: readonly ContextMenuEntry[]): ContextMenuEntry[] {
    return selection.flatMap((entry): ContextMenuEntry[] => {
        if (entry.kind !== 'submenu') return [entry];
        if (entry.id === 'edit') return entry.entries.filter(row => row.kind === 'command' && (row.id === 'editLink' || row.id === 'toggleAutoSize'));
        if (entry.id === 'arrange' || entry.id === 'reorder') return [];
        return [entry];
    });
}

function sheetRows(sheets: PaletteSheetSource, t: BoardTranslate): ContextMenuEntry[] {
    const full = !sheets.canCreate;
    const reason = full ? t('sheet.limit', { count: SHEET_LIMIT }) : undefined;
    const goTo: ContextMenuSubmenu = { kind: 'submenu', id: 'goToSheet', label: t('sheet.goToPage'), entries: sheets.sheets.map(sheet => ({
        kind: 'command', id: `sheet-${sheet.id}`, label: sheet.name, checked: sheet.id === sheets.current, run: () => sheets.select(sheet.id),
    })) };
    const create: ContextMenuCommand = { kind: 'command', id: 'newSheet', label: t('sheet.create'), disabled: full, ...(reason ? { reason } : {}),
        run: () => sheets.create() };
    const duplicate: ContextMenuCommand = { kind: 'command', id: 'duplicateSheet', label: t('sheet.duplicate'), disabled: full, ...(reason ? { reason } : {}),
        run: () => sheets.duplicate(sheets.current) };
    return [goTo, create, duplicate];
}

/**
 * The palette's groups, in the order a person reads them. Each row is the same entry a menu shows, so one command has one
 * label, chord and rule wherever it appears. Groups with no rows are left out by the caller.
 */
export function paletteGroups(sources: PaletteSources): PaletteGroup[] {
    const { translate: t, main, preferences, selection } = sources;
    const tools = sources.tools;
    const toolRows: ContextMenuEntry[] = tools ? [...tools.choices.primary, ...tools.choices.more]
        .filter(choice => choice.id !== 'media' && !(choice.id === tools.current.id && choice.figure === tools.current.figure))
        .map(choice => {
            const state = tools.state(choice.id, choice.figure);
            return { kind: 'command', id: `tool-${choice.id}${choice.figure ? `-${choice.figure}` : ''}`, label: choice.label,
                ...(choice.shortcut ? { shortcut: choice.shortcut } : {}), disabled: !state.enabled, ...(state.enabled ? {} : { reason: state.reason }),
                run: () => tools.select(choice.id, choice.figure) };
        }) : [];
    const language = main.filter((entry): entry is ContextMenuSubmenu => entry.kind === 'submenu' && entry.id === 'language');
    const groups: PaletteGroup[] = [
        { id: 'selection', label: t('palette.selection'), entries: selectionOnly(selection) },
        // The Arrange rows sit directly in the group that is already named Arrange: a submenu of the same name would repeat it.
        { id: 'arrange', label: sources.arrangeLabel, entries: sources.arrange.flatMap(entry => entry.kind === 'submenu' && entry.id === 'arrange' ? entry.entries : [entry]) },
        { id: 'styles', label: t('palette.styles'), entries: sources.styles ? styleSubmenus(sources.styles, t) : [] },
        { id: 'edit', label: sources.sectionLabel('edit'), entries: section(main, 'edit') },
        { id: 'view', label: sources.sectionLabel('view'), entries: section(main, 'view') },
        { id: 'sheets', label: t('sheet.menu'), entries: sources.sheets ? sheetRows(sources.sheets, t) : [] },
        { id: 'insert', label: t('palette.insert'), entries: commandsOf(main, ['insertEmbed', 'uploadMedia']) },
        { id: 'tools', label: t('chrome.tools'), entries: toolRows },
        { id: 'export', label: sources.sectionLabel('export'), entries: section(main, 'export') },
        { id: 'preferences', label: sources.sectionLabel('preferences'), entries: [
            // The shortcuts switch is kept out: a palette that can turn shortcuts off has no keyboard way back (K§11 wart 9).
            ...withoutRow(preferences, 'keyboardShortcutsEnabled'), ...language,
        ] },
        { id: 'help', label: t('palette.help'), entries: commandsOf(main, ['keyboardShortcuts']) },
    ];
    return groups;
}
