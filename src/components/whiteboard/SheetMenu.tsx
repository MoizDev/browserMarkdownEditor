import { useEffect, useRef, useState } from 'react';
import type { Sheet } from '../../whiteboard/model/doc';
import type { SheetId } from '../../whiteboard/model/ids';
import { openContextMenu, type ContextMenuEntry } from '../../utils/contextMenu';
import { dismissOnEscape } from '../../utils/escapeDismiss';
import './sheetMenu.css';

export interface SheetMenuProps {
    readonly anchor: HTMLElement;
    readonly sheets: readonly Sheet[];
    readonly current: SheetId;
    readonly readOnly: boolean;
    readonly close: () => void;
    readonly select: (id: SheetId) => void;
    readonly create: () => void;
    readonly rename: (id: SheetId, name: string) => void;
    readonly duplicate: (id: SheetId) => void;
    readonly remove: (id: SheetId) => void;
    readonly move: (id: SheetId, destination: number) => void;
}

/** Logical sheets are independent of the paper-page navigator on paged hosts. */
export function SheetMenu({ anchor, sheets, current, readOnly, close, select, create, rename, duplicate, remove, move }: SheetMenuProps) {
    const panel = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const [editing, setEditing] = useState<SheetId | null>(null);
    const [name, setName] = useState('');
    const cancelled = useRef(false);
    const closeRef = useRef(close);
    closeRef.current = close;
    const rect = anchor.getBoundingClientRect();
    useEffect(() => {
        panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
        const escape = dismissOnEscape(() => closeRef.current());
        const outside = (event: PointerEvent) => {
            if (event.target instanceof Element && event.target.closest('.context-menu-panel')) return;
            if (event.target instanceof Node && !panel.current?.contains(event.target) && !anchor.contains(event.target)) closeRef.current();
        };
        document.addEventListener('pointerdown', outside);
        return () => { escape(); document.removeEventListener('pointerdown', outside); };
    }, [anchor]);
    useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
    const finishRename = (sheet: Sheet) => {
        if (!cancelled.current && name.trim() && name !== sheet.name) rename(sheet.id, name.trim());
        cancelled.current = false;
        setEditing(null);
    };
    return <div ref={panel} className="board-sheet-menu" role="dialog" aria-label="Pages"
        style={{ left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)), top: Math.min(rect.bottom + 6, window.innerHeight - 80) }}
        onContextMenu={event => event.preventDefault()} onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}>
        <div className="board-sheet-menu-label">Go to page</div>
        {sheets.map((sheet, index) => <div className="board-sheet-row" key={sheet.id}>
            {editing === sheet.id ? <input ref={input} aria-label="Page name" value={name} maxLength={200}
                onChange={event => setName(event.currentTarget.value)} onBlur={() => finishRename(sheet)}
                onKeyDown={event => {
                    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; event.currentTarget.blur(); }
                    else if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
                }} /> : <button type="button" className="board-sheet-select" aria-current={sheet.id === current ? 'page' : undefined}
                onClick={() => { select(sheet.id); close(); }}>{sheet.name}</button>}
            <button type="button" aria-label={`Menu for ${sheet.name}`} data-tooltip="Menu" disabled={readOnly}
                onClick={event => {
                    const button = event.currentTarget, box = button.getBoundingClientRect();
                    const entries: ContextMenuEntry[] = [
                        { kind: 'command', id: 'rename', label: 'Rename', run: () => { cancelled.current = false; setName(sheet.name); setEditing(sheet.id); } },
                        ...(sheets.length < 40 ? [{ kind: 'command' as const, id: 'duplicate', label: 'Duplicate', run: () => duplicate(sheet.id) }] : []),
                        ...(index > 0 ? [{ kind: 'command' as const, id: 'up', label: 'Move up', run: () => move(sheet.id, index - 1) }] : []),
                        ...(index < sheets.length - 1 ? [{ kind: 'command' as const, id: 'down', label: 'Move down', run: () => move(sheet.id, index + 1) }] : []),
                        ...(sheets.length > 1 ? [{ kind: 'command' as const, id: 'delete', label: 'Delete', danger: true, run: () => remove(sheet.id) }] : []),
                    ];
                    openContextMenu({ x: box.left, y: box.bottom, entries, label: 'Page menu', opener: button, anchor: button });
                }}>⋯</button>
        </div>)}
        {sheets.length < 40 ? <button type="button" disabled={readOnly} onClick={() => { create(); close(); }}>Create new page</button>
            : <div className="board-sheet-menu-label">Maximum pages reached</div>}
    </div>;
}
