import { useCallback, useEffect, useRef, useState } from 'react';
import LucideGlyph from '../../LucideGlyph';
import { openContextMenu, type ContextMenuEntry } from '../../../utils/contextMenu';
import { dismissOnEscape } from '../../../utils/escapeDismiss';
import { actionCommands, type BoardCommand, type BoardCommandSource } from './boardCommands';
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
    const actionButton = useRef<HTMLButtonElement>(null);
    const actions = useRef<HTMLDivElement>(null);
    const closeActions = useCallback(() => {
        setActionsOpen(false);
        actionButton.current?.focus();
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
        <div className="board-chrome-strip" role="toolbar" aria-label={menuLabel}>
            <button type="button" className="board-chrome-strip-button" aria-label={menuLabel} data-tooltip={menuLabel}
                onClick={event => {
                    const anchor = event.currentTarget;
                    const rect = anchor.getBoundingClientRect();
                    openContextMenu({ x: rect.left, y: rect.bottom,
                        entries: typeof menuEntries === 'function' ? menuEntries(anchor) : menuEntries,
                        label: menuLabel, lang: locale, dir: direction, opener: anchor, anchor });
                }}><LucideGlyph nodes={headerIcons.menu} size={16} /></button>
            <button type="button" className="board-chrome-sheet" onClick={event => openSheets(event.currentTarget)}>
                <span>{sheetName}</span><LucideGlyph nodes={headerIcons.chevronDown} size={16} />
            </button>
            {headerCommands.map(id => {
                const state = commands.state(id);
                const label = commands.label(id);
                const chord = commands.shortcut(id);
                const accessibleLabel = chord ? `${label} — ${chord}` : label;
                return <button key={id} type="button" className="board-chrome-strip-button" aria-label={accessibleLabel}
                    aria-disabled={!state.enabled} disabled={!state.enabled} data-tooltip={state.enabled ? accessibleLabel : state.reason}
                    onClick={() => void commands.run(id)}><LucideGlyph nodes={headerCommandIcons[id]} size={16} /></button>;
            })}
            <div className="board-chrome-actions">
                <button type="button" ref={actionButton} className="board-chrome-strip-button" aria-label={actionsLabel}
                    aria-haspopup="dialog" aria-expanded={actionsOpen} data-tooltip={actionsLabel}
                    onClick={() => setActionsOpen(value => !value)}><LucideGlyph nodes={headerIcons.actions} size={16} /></button>
                {actionsOpen && <div ref={actions} className="board-chrome-action-popup" role="dialog" aria-label={actionsLabel}>
                    <div role="toolbar" aria-label={actionsLabel}>
                        {actionSlots.map(id => {
                            const state = commands.state(id);
                            const label = commands.label(id);
                            const glyph = actionIcons[id];
                            return <button key={id} type="button" className="board-chrome-action" disabled={!state.enabled}
                                aria-disabled={!state.enabled} aria-label={label} data-tooltip={state.enabled ? label : state.reason}
                                onClick={() => { setActionsOpen(false); void commands.run(id); }}>
                                {glyph && <LucideGlyph nodes={glyph} size={16} />}
                            </button>;
                        })}
                    </div>
                </div>}
            </div>
        </div>
    </div>;
}
