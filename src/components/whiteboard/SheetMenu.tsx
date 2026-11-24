import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { openContextMenu, type ContextMenuEntry } from '../../utils/contextMenu';
import { dismissOnEscape } from '../../utils/escapeDismiss';
import { getBoardPreferences, SHEET_LIST_MAX_HEIGHT, SHEET_LIST_MIN_HEIGHT, updateBoardPreferences } from '../../utils/boardPreferences';
import './sheetMenu.css';

export interface SheetMenuEntry { readonly id: string; readonly name: string }

export interface SheetMenuProps {
    readonly anchor: HTMLElement;
    readonly sheets: readonly SheetMenuEntry[];
    readonly current: string;
    readonly readOnly: boolean;
    readonly dir: 'ltr' | 'rtl';
    readonly t: (key: string, values?: Readonly<Record<string, string | number>>) => string;
    readonly close: () => void;
    readonly select: (id: string) => void;
    readonly create: () => void;
    readonly rename: (id: string, name: string) => void;
    readonly duplicate: (id: string) => void;
    readonly remove: (id: string) => void;
    readonly move: (id: string, destination: number) => void;
}

/** The structure controls refuse a fortieth sheet; the menu says so rather than offering a row that cannot run. */
const MAX_SHEETS = 40;
/** A pointer must travel this far before a press on a row becomes a drag, so a click still selects the sheet. */
const DRAG_THRESHOLD = 5;

/** Logical sheets are independent of the paper-page navigator on paged hosts. */
export function SheetMenu({ anchor, sheets, current, readOnly, dir, t, close, select, create, rename, duplicate, remove, move: moveSheet }: SheetMenuProps) {
    const panel = useRef<HTMLDivElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const [editing, setEditing] = useState<string | null>(null);
    const [name, setName] = useState('');
    const cancelled = useRef(false);
    const closeRef = useRef(close);
    useEffect(() => { closeRef.current = close; }, [close]);
    const rect = anchor.getBoundingClientRect();
    const atLimit = sheets.length >= MAX_SHEETS;
    // The drag state lives in a ref: pointer moves change nothing the render shows except the drop marker.
    const [drop, setDrop] = useState<{ from: number; to: number } | null>(null);
    const dragging = useRef<{ index: number; startY: number; active: boolean; to: number } | null>(null);
    const suppressClick = useRef(false);
    const [pinned, setPinned] = useState<number | null>(() => getBoardPreferences().sheetListHeight);
    useEffect(() => {
        panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
        const escape = dismissOnEscape(() => { closeRef.current(); if (anchor.isConnected) anchor.focus(); });
        const outside = (event: PointerEvent) => {
            // The app menu's root is `.context-menu`; only its submenus are `.context-menu-panel` (missing the root closed this
            // menu before Rename could show its field).
            if (event.target instanceof Element && event.target.closest('.context-menu, .context-menu-panel')) return;
            if (event.target instanceof Node && !panel.current?.contains(event.target) && !anchor.contains(event.target)) closeRef.current();
        };
        document.addEventListener('pointerdown', outside);
        return () => { escape(); document.removeEventListener('pointerdown', outside); };
    }, [anchor]);
    useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
    const finishRename = (sheet: SheetMenuEntry) => {
        if (!cancelled.current && name.trim() && name !== sheet.name) rename(sheet.id, name.trim());
        cancelled.current = false;
        setEditing(null);
    };
    const beginRename = (sheet: SheetMenuEntry) => {
        if (readOnly) return;
        cancelled.current = false; setName(sheet.name); setEditing(sheet.id);
    };
    // Escape while a drag is live cancels the drag only: the window-capture listener stops the event before the menu's own Escape.
    const endDrag = () => { dragging.current = null; setDrop(null); };
    useEffect(() => {
        const cancelOnEscape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || !dragging.current?.active) return;
            event.preventDefault(); event.stopPropagation(); endDrag();
        };
        window.addEventListener('keydown', cancelOnEscape, true);
        return () => window.removeEventListener('keydown', cancelOnEscape, true);
    }, []);
    const rowRects = () => [...(list.current?.querySelectorAll<HTMLElement>('.board-sheet-row') ?? [])];
    const onRowPointerDown = (event: ReactPointerEvent<HTMLDivElement>, index: number) => {
        // Touch keeps its own handle (catalogue: the drag handle appears only on coarse pointers), so only a fine pointer drags rows.
        if (readOnly || event.button !== 0 || event.pointerType === 'touch' || editing !== null) return;
        dragging.current = { index, startY: event.clientY, active: false, to: index };
        const move = (moveEvent: PointerEvent) => {
            const drag = dragging.current;
            if (!drag) return;
            if (!drag.active) {
                if (Math.abs(moveEvent.clientY - drag.startY) < DRAG_THRESHOLD) return;
                drag.active = true;
            }
            const rows = rowRects();
            let to = rows.length - 1;
            for (let i = 0; i < rows.length; i++) {
                const box = rows[i].getBoundingClientRect();
                if (moveEvent.clientY < box.top + box.height / 2) { to = i; break; }
            }
            drag.to = to;
            setDrop({ from: drag.index, to });
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            const drag = dragging.current;
            endDrag();
            if (!drag?.active) return;
            // The click that follows a real drag belongs to the drag, not to selecting the row under the pointer.
            suppressClick.current = true;
            setTimeout(() => { suppressClick.current = false; }, 0);
            if (drag.to !== drag.index) moveSheet(sheets[drag.index].id, drag.to);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    };
    // The grip sets the list's height and persists it; a double-click gives the height back to the content.
    const onGripPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || !list.current) return;
        const start = event.clientY, startHeight = list.current.getBoundingClientRect().height;
        const maxHeight = Math.min(Math.floor(window.innerHeight * 0.62), SHEET_LIST_MAX_HEIGHT);
        let height = startHeight, moved = false;
        const drag = (moveEvent: PointerEvent) => {
            moved = true;
            height = Math.max(SHEET_LIST_MIN_HEIGHT, Math.min(maxHeight, startHeight + moveEvent.clientY - start));
            if (list.current) list.current.style.height = `${height}px`;
        };
        const up = () => {
            window.removeEventListener('pointermove', drag);
            window.removeEventListener('pointerup', up);
            // A press without a move is not a resize: only a dragged height is pinned.
            if (!moved) return;
            setPinned(height);
            updateBoardPreferences({ sheetListHeight: height });
        };
        window.addEventListener('pointermove', drag);
        window.addEventListener('pointerup', up);
    };
    const resetGrip = () => {
        if (list.current) list.current.style.height = '';
        setPinned(null);
        updateBoardPreferences({ sheetListHeight: null });
    };
    return <div ref={panel} className="board-sheet-menu" role="menu" dir={dir} aria-label={t('sheet.menu')}
        style={{ left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)), top: Math.min(rect.bottom + 6, window.innerHeight - 80) }}
        onContextMenu={event => event.preventDefault()} onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}>
        <div className="board-sheet-menu-label">{t('sheet.menu')}</div>
        <div ref={list} className="board-sheet-list" style={pinned !== null ? { height: pinned } : undefined}>
            {sheets.map((sheet, index) => <div className="board-sheet-row" role="none" key={sheet.id}
                data-dragging={drop?.from === index ? 'true' : undefined}
                data-drop={drop && drop.to === index && drop.from !== index ? (drop.to < drop.from ? 'before' : 'after') : undefined}
                onPointerDown={event => onRowPointerDown(event, index)}>
                {editing === sheet.id ? <input ref={input} aria-label={t('sheet.rename')} value={name} maxLength={200}
                    onChange={event => setName(event.currentTarget.value)} onBlur={() => finishRename(sheet)}
                    onKeyDown={event => {
                        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; event.currentTarget.blur(); }
                        else if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
                    }} /> : <button type="button" role="menuitemradio" className="board-sheet-select" aria-checked={sheet.id === current}
                    aria-current={sheet.id === current ? 'page' : undefined}
                    onClick={() => {
                        // Clicking the current sheet keeps the menu open, so its double-click can rename it.
                        if (suppressClick.current || sheet.id === current) return;
                        select(sheet.id); close();
                    }}
                    onDoubleClick={() => beginRename(sheet)}
                    onKeyDown={event => {
                        // Enter on the current sheet renames it (catalogue: Enter on the current page), instead of selecting it again.
                        if (event.key === 'Enter' && sheet.id === current && !readOnly) { event.preventDefault(); beginRename(sheet); }
                    }}>{sheet.name}</button>}
                <button type="button" className="board-sheet-more" role="menuitem" aria-haspopup="menu"
                    aria-label={`${t('sheet.menu')}: ${sheet.name}`} data-tooltip={t('sheet.menu')} disabled={readOnly}
                    onClick={event => {
                        const button = event.currentTarget, box = button.getBoundingClientRect();
                        const entries: ContextMenuEntry[] = [
                            { kind: 'command', id: 'rename', label: t('sheet.rename'), run: () => beginRename(sheet) },
                            { kind: 'command', id: 'duplicate', label: t('sheet.duplicate'), disabled: atLimit,
                                reason: atLimit ? t('sheet.limit', { count: MAX_SHEETS }) : undefined, run: () => duplicate(sheet.id) },
                            ...(index > 0 ? [{ kind: 'command' as const, id: 'up', label: t('sheet.moveUp'), run: () => moveSheet(sheet.id, index - 1) }] : []),
                            ...(index < sheets.length - 1 ? [{ kind: 'command' as const, id: 'down', label: t('sheet.moveDown'), run: () => moveSheet(sheet.id, index + 1) }] : []),
                            ...(sheets.length > 1 ? [{ kind: 'command' as const, id: 'delete', label: t('sheet.delete'), danger: true, run: () => remove(sheet.id) }] : []),
                        ];
                        openContextMenu({ x: box.left, y: box.bottom, entries, label: t('sheet.menu'), opener: button, anchor: button });
                    }}>⋯</button>
            </div>)}
        </div>
        <div className="board-sheet-grip" role="separator" aria-orientation="horizontal" aria-label={t('sheet.resizeList')}
            data-tooltip={t('sheet.resizeList')} data-pinned={pinned !== null ? 'true' : undefined}
            onPointerDown={onGripPointerDown} onDoubleClick={resetGrip} />
        <button type="button" className="board-sheet-create" role="menuitem" disabled={readOnly || atLimit}
            onClick={() => { create(); close(); }}>{atLimit ? t('sheet.limit', { count: MAX_SHEETS }) : t('sheet.create')}</button>
    </div>;
}
