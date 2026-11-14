import { useCallback, useEffect, useRef, useState } from 'react';
import { openContextMenu, type ContextMenuEntry } from '../../../utils/contextMenu';
import { dismissOnEscape } from '../../../utils/escapeDismiss';
import { actionCommands, type BoardCommandSource } from './boardCommands';
import './chrome.css';

export interface BoardHeaderProps {
    readonly commands: BoardCommandSource;
    readonly locale: string;
    readonly direction: 'ltr' | 'rtl';
    readonly menuLabel: string;
    readonly menuEntries: ContextMenuEntry[];
    readonly onMenuOpen?: (anchor: HTMLButtonElement) => void;
    readonly sheetName: string;
    readonly openSheets: (anchor: HTMLButtonElement) => void;
    readonly actionsLabel: string;
}

export function BoardHeader({ commands, locale, direction, menuLabel, menuEntries, onMenuOpen, sheetName, openSheets, actionsLabel }: BoardHeaderProps) {
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

    const headerCommands = (['undo', 'redo', 'delete', 'duplicate'] as const).map(id => {
        const state = commands.state(id);
        const label = commands.label(id);
        const chord = commands.shortcut(id);
        const accessibleLabel = chord ? `${label} — ${chord}` : label;
        return <button key={id} type="button" className="board-chrome-tool" aria-label={accessibleLabel}
            aria-disabled={!state.enabled} disabled={!state.enabled} data-tooltip={state.enabled ? accessibleLabel : state.reason}
            onClick={() => void commands.run(id)}>{label}</button>;
    });

    return <div className="board-chrome-header">
        <nav className="board-chrome-tool-row" aria-label={menuLabel}>
            <button type="button" className="board-chrome-tool" aria-label={menuLabel} data-tooltip={menuLabel}
                onClick={event => {
                    const anchor = event.currentTarget;
                    onMenuOpen?.(anchor);
                    const rect = anchor.getBoundingClientRect();
                    openContextMenu({ x: rect.left, y: rect.bottom, entries: menuEntries,
                        label: menuLabel, lang: locale, dir: direction, opener: anchor, anchor });
                }}>{menuLabel}</button>
            <button type="button" className="board-chrome-tool" onClick={event => openSheets(event.currentTarget)}>{sheetName}</button>
        </nav>
        <div className="board-chrome-actions">
            <div className="board-chrome-tool-row" role="toolbar" aria-label={actionsLabel}>
                {headerCommands}
                <button type="button" ref={actionButton} className="board-chrome-tool" aria-label={actionsLabel}
                    aria-haspopup="dialog" aria-expanded={actionsOpen} data-tooltip={actionsLabel}
                    onClick={() => setActionsOpen(value => !value)}>{actionsLabel}</button>
            </div>
            {actionsOpen && <div ref={actions} className="board-chrome-action-popup" role="dialog" aria-label={actionsLabel}>
                <div role="toolbar" aria-label={actionsLabel}>
                    {actionCommands.map(id => {
                        const state = commands.state(id);
                        const label = commands.label(id);
                        return <button key={id} type="button" className="board-chrome-tool" disabled={!state.enabled}
                            aria-disabled={!state.enabled} aria-label={label} data-tooltip={state.enabled ? label : state.reason}
                            onClick={() => { setActionsOpen(false); void commands.run(id); }}>{label}</button>;
                    })}
                </div>
            </div>}
        </div>
    </div>;
}
