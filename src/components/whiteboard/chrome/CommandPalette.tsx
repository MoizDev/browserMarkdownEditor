import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import LucideGlyph from '../../LucideGlyph';
import type { ContextMenuCommand, ContextMenuEntry, ContextMenuSubmenu } from '../../../utils/contextMenu';
import { paletteLeaves, recentLeaves, runnableGroups, searchLeaves, type PaletteGroup, type PaletteLeaf } from './commandPaletteModel';
import { paletteIcons } from './boardIcons';
import './chrome.css';

export interface CommandPaletteProps {
    readonly groups: readonly PaletteGroup[];
    /** A read-only board lists only the rows that can run there. */
    readonly readOnly: boolean;
    /** Keys of the commands run most recently, newest first. */
    readonly recent: readonly string[];
    readonly label: string;
    readonly placeholder: string;
    readonly emptyLabel: string;
    readonly recentLabel: string;
    readonly backLabel: string;
    readonly locale: string;
    readonly direction: 'ltr' | 'rtl';
    /** Focus goes here when the palette closes, unless the close came from a pointer press elsewhere. */
    readonly returnFocus: HTMLElement | null;
    /** A command was chosen. The owner closes the palette and runs it; `key` names the row for Recent. */
    readonly onRun: (key: string, command: ContextMenuCommand) => void;
    readonly onClose: () => void;
}

interface Level { readonly key: string; readonly label: string; readonly entries: readonly ContextMenuEntry[]; readonly from: string }

interface Row {
    /** Unique within the list, so the keyboard highlight and the option id name one row. */
    readonly id: string;
    readonly kind: 'heading' | 'separator' | 'command' | 'submenu';
    readonly label: string;
    /** The row's path of ids, the key Recent stores. */
    readonly key: string;
    readonly crumb?: string;
    readonly shortcut?: string;
    readonly checked?: boolean;
    readonly disabled: boolean;
    readonly reason?: string;
    readonly command?: ContextMenuCommand;
    readonly submenu?: ContextMenuSubmenu;
}

function commandRow(id: string, key: string, entry: ContextMenuCommand, crumb?: string): Row {
    return { id, kind: 'command', label: entry.label, key, crumb, shortcut: entry.shortcut, checked: entry.checked,
        disabled: !!entry.disabled, reason: entry.disabled ? entry.reason : undefined, command: entry };
}

/** The rows of one level, keyed by their path so a row keeps its identity while the palette is open. */
function levelRows(entries: readonly ContextMenuEntry[], base: string, scope: string): Row[] {
    return entries.flatMap((entry, index): Row[] => {
        if (entry.kind === 'separator') return [{ id: `${scope}|sep${index}`, kind: 'separator', label: '', key: '', disabled: true }];
        if (entry.kind === 'command') return [commandRow(`${scope}|${base}/${entry.id}`, `${base}/${entry.id}`, entry)];
        if (entry.kind === 'submenu') return [{ id: `${scope}|${base}/${entry.id}`, kind: 'submenu', label: entry.label, key: `${base}/${entry.id}`,
            disabled: !!entry.disabled, reason: entry.disabled ? entry.reason : undefined, submenu: entry }];
        return [];
    });
}

/**
 * The command palette: one searchable list of the board's commands, with nested submenus. It is a modal dialog: the
 * keyboard stays in its search field (arrows and Tab move, Enter runs, Escape backs out or closes), and focus goes back
 * to the board when it closes. Its state (open, submenu path, query) lives in the owner; this draws and routes keys.
 */
export function CommandPalette({ groups, readOnly, recent, label, placeholder, emptyLabel, recentLabel, backLabel, locale, direction,
    returnFocus, onRun, onClose }: CommandPaletteProps) {
    const baseId = useId();
    const [query, setQuery] = useState('');
    const [levels, setLevels] = useState<readonly Level[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const restoreFocus = useRef(true);
    const swallowEnter = useRef<((event: KeyboardEvent) => void) | null>(null);
    const rtl = direction === 'rtl';

    const runnable = useMemo(() => runnableGroups(groups, readOnly), [groups, readOnly]);
    const leaves = useMemo(() => paletteLeaves(runnable), [runnable]);
    const top = levels[levels.length - 1];

    const rows = useMemo((): Row[] => {
        const trimmed = query.trim();
        if (top) {
            if (!trimmed) return levelRows(top.entries, top.key, `level:${top.key}`);
            return searchLeaves(paletteLeaves([{ id: top.key, label: top.label, entries: top.entries }]), trimmed)
                .map(leaf => commandRow(`search|${leaf.key}`, leaf.key, leaf.command, leaf.crumb));
        }
        if (trimmed) return searchLeaves(leaves, trimmed).map(leaf => commandRow(`search|${leaf.key}`, leaf.key, leaf.command, leaf.crumb));
        const result: Row[] = [];
        const recents = recentLeaves(recent, leaves);
        if (recents.length) {
            result.push({ id: 'heading|recent', kind: 'heading', label: recentLabel, key: '', disabled: true });
            for (const leaf of recents) result.push(commandRow(`recent|${leaf.key}`, leaf.key, leaf.command, leaf.crumb));
        }
        for (const group of runnable) {
            if (!group.entries.length) continue;
            result.push({ id: `heading|${group.id}`, kind: 'heading', label: group.label, key: group.id, disabled: true });
            result.push(...levelRows(group.entries, group.id, 'root'));
        }
        return result;
    }, [query, top, leaves, recent, recentLabel, runnable]);

    const navigable = rows.filter(row => (row.kind === 'command' || row.kind === 'submenu') && !row.disabled);
    const active = navigable.find(row => row.id === activeId) ?? navigable[0];
    const hasChecks = rows.some(row => row.checked !== undefined);
    const optionDom = (row: Row) => `${baseId}-${rows.indexOf(row)}`;

    // The highlight follows the keyboard: a row scrolls into view when it becomes active, never by the pointer alone.
    useLayoutEffect(() => {
        listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    // The palette opens once and a close is the owner's unmount, so the focus target is read at that moment, not captured per render.
    const returnRef = useRef(returnFocus);
    useLayoutEffect(() => { returnRef.current = returnFocus; }, [returnFocus]);
    useEffect(() => {
        inputRef.current?.focus({ preventScroll: true });
        return () => {
            if (swallowEnter.current) window.removeEventListener('keyup', swallowEnter.current, true);
            // Pointer dismissal moved focus to what was pressed; the keyboard's own close hands it back to the board.
            const target = returnRef.current;
            if (restoreFocus.current && target?.isConnected) target.focus({ preventScroll: true });
        };
    }, []);

    const enter = (row: Row) => {
        if (!row.submenu) return;
        setLevels(previous => [...previous, { key: row.key, label: row.label, entries: row.submenu!.entries, from: row.id }]);
        setQuery('');
        setActiveId(null);
    };
    const back = () => {
        const last = levels[levels.length - 1];
        if (!last) return;
        setLevels(levels.slice(0, -1));
        setQuery('');
        setActiveId(last.from);
    };
    const run = (row: Row | undefined) => {
        if (!row || row.disabled) return;
        if (row.kind === 'submenu') enter(row);
        else if (row.kind === 'command' && row.command) onRun(row.key, row.command);
    };
    const step = (delta: number) => {
        if (!navigable.length) return;
        const index = Math.max(0, navigable.findIndex(row => row.id === active?.id));
        setActiveId(navigable[(index + delta + navigable.length) % navigable.length].id);
    };

    const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
        // The palette owns every key while it is open: nothing reaches the board or the app's own shortcuts.
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        const input = event.currentTarget, caretAtEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
        const caretAtStart = input.selectionStart === 0 && input.selectionEnd === 0;
        const forward = rtl ? 'ArrowLeft' : 'ArrowRight', backward = rtl ? 'ArrowRight' : 'ArrowLeft';
        if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            onClose();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            if (levels.length) back(); else onClose();
        } else if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
            event.preventDefault();
            step(1);
        } else if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
            event.preventDefault();
            step(-1);
        } else if (event.key === forward && caretAtEnd && active?.kind === 'submenu') {
            event.preventDefault();
            enter(active);
        } else if (event.key === backward && caretAtStart && levels.length) {
            event.preventDefault();
            back();
        } else if (event.key === 'Backspace' && input.value === '' && levels.length) {
            event.preventDefault();
            back();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            // The Enter that chose a row must not reach the board as a keyup: a text edit starts on it.
            if (swallowEnter.current) window.removeEventListener('keyup', swallowEnter.current, true);
            const swallow = (up: KeyboardEvent) => {
                if (up.key !== 'Enter') return;
                up.preventDefault();
                up.stopPropagation();
                window.removeEventListener('keyup', swallow, true);
                swallowEnter.current = null;
            };
            swallowEnter.current = swallow;
            window.addEventListener('keyup', swallow, true);
            run(active);
        }
    };

    return <>
        <div className="board-palette-backdrop" onPointerDown={() => { restoreFocus.current = false; onClose(); }} />
        <section className="board-palette" role="dialog" aria-modal="true" aria-label={label} lang={locale} dir={direction}
            onPointerDown={event => event.stopPropagation()}>
            <div className="board-palette-search">
                <LucideGlyph nodes={paletteIcons.search} size={16} />
                <input ref={inputRef} type="text" role="combobox" aria-expanded="true" aria-autocomplete="list"
                    aria-controls={`${baseId}-list`} aria-activedescendant={active ? optionDom(active) : undefined}
                    aria-label={placeholder} placeholder={placeholder} value={query} dir="auto" autoComplete="off" spellCheck={false}
                    className="board-palette-input" onChange={event => { setQuery(event.target.value); setActiveId(null); }}
                    onKeyDown={onKeyDown} />
            </div>
            {top && <div className="board-palette-level">
                <button type="button" tabIndex={-1} className="board-palette-back" onClick={back}>
                    <LucideGlyph nodes={rtl ? paletteIcons.chevronRight : paletteIcons.chevronLeft} size={16} /><span>{backLabel}</span>
                </button>
                <span className="board-palette-level-label">{top.label}</span>
            </div>}
            <div ref={listRef} id={`${baseId}-list`} role="listbox" aria-label={label} className="board-palette-list">
                {rows.map((row, index) => {
                    if (row.kind === 'heading') return <div key={row.id} role="presentation" className="board-palette-heading">{row.label}</div>;
                    if (row.kind === 'separator') return <div key={row.id} role="separator" className="board-palette-separator" />;
                    const isActive = row === active;
                    return <div key={row.id} id={`${baseId}-${index}`} role="option" className="board-palette-row"
                        aria-selected={isActive} aria-disabled={row.disabled || undefined}
                        aria-checked={row.checked === undefined ? undefined : row.checked} aria-haspopup={row.kind === 'submenu' ? 'listbox' : undefined}
                        data-active={isActive || undefined} data-disabled={row.disabled || undefined} data-checked={row.checked || undefined}
                        onPointerMove={() => { if (!row.disabled && !isActive) setActiveId(row.id); }}
                        onClick={() => run(row)}>
                        {hasChecks && <span className="board-palette-check" aria-hidden="true">
                            {row.checked ? <LucideGlyph nodes={paletteIcons.check} size={14} /> : null}</span>}
                        <span className="board-palette-text">
                            <span className="board-palette-label">{row.label}</span>
                            {row.crumb && <span className="board-palette-crumb">{row.crumb}</span>}
                            {row.disabled && row.reason && <span className="board-palette-reason">{row.reason}</span>}
                        </span>
                        {row.shortcut && <span className="board-palette-chord" aria-hidden="true">{row.shortcut}</span>}
                        {row.kind === 'submenu' && <LucideGlyph nodes={rtl ? paletteIcons.chevronLeft : paletteIcons.chevronRight} size={16} />}
                    </div>;
                })}
                {!rows.some(row => row.kind === 'command' || row.kind === 'submenu') && <div className="board-palette-empty" role="status">{emptyLabel}</div>}
            </div>
        </section>
    </>;
}
