import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import LucideGlyph from '../../LucideGlyph';
import { openContextMenu, type ContextMenuEntry } from '../../../utils/contextMenu';
import { dismissOnEscape } from '../../../utils/escapeDismiss';
import { actionCommands, type BoardCommand, type BoardCommandSource } from './boardCommands';
import { focusBoardInteraction } from './boardFocus';
import { actionIcons, headerCommandIcons, headerIcons } from './boardIcons';
import './chrome.css';

export interface BoardHeaderProps {
    readonly commands: BoardCommandSource;
    readonly locale: string;
    readonly direction: 'ltr' | 'rtl';
    readonly menuLabel: string;
    readonly menuEntries: ContextMenuEntry[] | ((anchor: HTMLButtonElement) => ContextMenuEntry[]);
    readonly sheetName: string;
    readonly openSheets: (anchor: HTMLButtonElement) => void;
    readonly actionsLabel: string;
}

const headerCommands = ['undo', 'redo', 'delete', 'duplicate'] as const;

/** The top-left strip: menu, sheet, Undo, Redo, Delete, Duplicate and the Actions grid. */
export function BoardHeader({ commands, locale, direction, menuLabel, menuEntries, sheetName, openSheets, actionsLabel }: BoardHeaderProps) {
    const [actionsOpen, setActionsOpen] = useState(false);
    const strip = useRef<HTMLDivElement>(null);
    // Commands the pane is too narrow to show move to the front of the Actions grid, in order, rather than running past
    // the pane's edge (measured: the strip needs 298px; a 207px pane cut off Delete, Duplicate and Actions itself).
    const fit = useFittingCommands(strip, headerCommands.length);
    const shownCommands = headerCommands.slice(0, fit), overflowCommands = headerCommands.slice(fit);
    const actionButton = useRef<HTMLButtonElement>(null);
    const actions = useRef<HTMLDivElement>(null);
    // Escape returns the keyboard to the board, not to the Actions button: the button is outside the board's keyboard root.
    const closeActions = useCallback(() => {
        setActionsOpen(false);
        focusBoardInteraction(actionButton.current);
    }, []);
    useEffect(() => {
        if (!actionsOpen) return;
        actions.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
        const removeEscape = dismissOnEscape(closeActions);
        const onPointerDown = (event: PointerEvent) => {
            if (event.target instanceof Node && !actions.current?.contains(event.target)
                && !actionButton.current?.contains(event.target)) setActionsOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => { removeEscape(); document.removeEventListener('pointerdown', onPointerDown); };
    }, [actionsOpen, closeActions]);

    // The grid's last slot is one button: Group, or Ungroup when the selection is a group.
    const actionSlots: readonly BoardCommand[] = actionCommands.map(id =>
        id === 'group' && commands.state('ungroup').enabled ? 'ungroup' : id);

    return <div className="board-chrome-header">
        <div ref={strip} className="board-chrome-strip" role="toolbar" aria-label={menuLabel}>
            <button type="button" className="board-chrome-strip-button" aria-label={menuLabel} data-tooltip={menuLabel}
                onClick={event => {
                    const anchor = event.currentTarget;
                    const rect = anchor.getBoundingClientRect();
                    // The menu renders outside the pane, so a dark board's menu carries the dark tokens itself.
                    const dark = anchor.closest('[data-board-theme="dark"]') !== null;
                    openContextMenu({ x: rect.left, y: rect.bottom,
                        entries: typeof menuEntries === 'function' ? menuEntries(anchor) : menuEntries,
                        label: menuLabel, lang: locale, dir: direction, opener: anchor, anchor,
                        className: dark ? 'board-main-menu board-main-menu-dark' : 'board-main-menu' });
                }}><LucideGlyph nodes={headerIcons.menu} size={16} /></button>
            <button type="button" className="board-chrome-sheet" onClick={event => openSheets(event.currentTarget)}>
                <span>{sheetName}</span><LucideGlyph nodes={headerIcons.chevronDown} size={16} />
            </button>
            {shownCommands.map(id => {
                const state = commands.state(id);
                const label = commands.label(id);
                const chord = commands.shortcut(id);
                const accessibleLabel = chord ? `${label} — ${chord}` : label;
                return <button key={id} type="button" className="board-chrome-strip-button" data-header-command={id} aria-label={accessibleLabel}
                    aria-disabled={!state.enabled} disabled={!state.enabled} data-tooltip={state.enabled ? accessibleLabel : state.reason}
                    onClick={() => void commands.run(id)}><LucideGlyph nodes={headerCommandIcons[id]} size={16} /></button>;
            })}
            <div className="board-chrome-actions">
                <button type="button" ref={actionButton} className="board-chrome-strip-button" aria-label={actionsLabel}
                    aria-haspopup="dialog" aria-expanded={actionsOpen} data-tooltip={actionsLabel}
                    onClick={() => setActionsOpen(value => !value)}><LucideGlyph nodes={headerIcons.actions} size={16} /></button>
                {actionsOpen && <div ref={actions} className="board-chrome-action-popup" role="dialog" aria-label={actionsLabel}>
                    <div role="toolbar" aria-label={actionsLabel}>
                        {[...overflowCommands, ...actionSlots].map(id => {
                            const state = commands.state(id);
                            const label = commands.label(id);
                            const glyph = id in headerCommandIcons ? headerCommandIcons[id as typeof headerCommands[number]] : actionIcons[id];
                            return <button key={id} type="button" className="board-chrome-action" disabled={!state.enabled}
                                aria-disabled={!state.enabled} aria-label={label} data-tooltip={state.enabled ? label : state.reason}
                                onClick={() => { setActionsOpen(false); void commands.run(id); }}>
                                {glyph && <LucideGlyph nodes={glyph} size={18} />}
                            </button>;
                        })}
                    </div>
                </div>}
            </div>
        </div>
    </div>;
}

/** How many header commands fit beside the menu, sheet and Actions buttons. The strip is pulled 8px into the chrome
 *  overlay's inset (chrome.css), so it has the overlay column's width plus those 8px; the button step and the strip's
 *  other parts are read from the rendered strip, never assumed. */
function useFittingCommands(strip: RefObject<HTMLDivElement | null>, count: number): number {
    const [fit, setFit] = useState(count);
    useLayoutEffect(() => {
        const element = strip.current, column = element?.closest<HTMLElement>('.board-chrome-top');
        if (!element || !column) return;
        const measure = () => {
            const button = element.querySelector<HTMLElement>('.board-chrome-strip-button');
            if (!button || !column.clientWidth) return;
            const gap = parseFloat(getComputedStyle(element).columnGap) || 0, step = button.offsetWidth + gap;
            const others = element.scrollWidth - element.querySelectorAll('[data-header-command]').length * step;
            if (step > 0) setFit(Math.max(0, Math.min(count, Math.floor((column.clientWidth + 8 - others) / step))));
        };
        const observer = new ResizeObserver(measure);
        observer.observe(column);
        measure();
        return () => observer.disconnect();
    }, [strip, count]);
    return fit;
}
