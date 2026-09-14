// The top bar's Insert table button: the size picker the editor's right-click
// menu already has, one click away instead of behind a right-click nobody finds.
//
// It cannot reach an editor itself (EditorPane holds no views), so a pick goes
// out as a request the focused DocumentPane answers. See
// utils/tableInsertRequest.ts.

import { useEffect, useRef, useState } from 'react';
import TableSizeGrid from './TableSizeGrid';
import { TableIcon } from './icons';
import { TABLE_GRID_COLS, TABLE_GRID_ROWS, requestTableInsert } from '../utils/tableInsertRequest';

interface TableInsertButtonProps {
    /** The focused document, which is the one a pick inserts into. */
    path: string;
    /** Reading mode: nothing can be inserted. */
    disabled: boolean;
    /** Shown as the title while disabled, so the dead button says why. */
    reason: string;
}

export default function TableInsertButton({ path, disabled, reason }: TableInsertButtonProps) {
    /** Where the picker sits, or null while closed. Fixed to the viewport from
     *  the button's own box, so no clipping ancestor can cut it off. */
    const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const buttonRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        if (!pos) return;
        const close = () => setPos(null);
        const onPointerDown = (e: PointerEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) close();
        };
        // Capture, stopped: the picker is drawn over CodeMirror, which binds
        // Escape itself (the context menu's reason).
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            close();
            buttonRef.current?.focus();
        };
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('resize', close);
        return () => {
            window.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('resize', close);
        };
    }, [pos]);

    // Switching into reading mode, or to another document, closes it.
    useEffect(() => { setPos(null); }, [disabled, path]);

    const toggle = () => {
        if (pos) { setPos(null); return; }
        const box = buttonRef.current?.getBoundingClientRect();
        if (box) setPos({ top: box.bottom + 6, right: Math.max(8, window.innerWidth - box.right) });
    };

    return (
        <div className="table-insert" ref={rootRef}>
            <button
                ref={buttonRef}
                className={`view-header-action${pos ? ' active' : ''}`}
                onClick={toggle}
                disabled={disabled}
                title={disabled ? reason : 'Insert table'}
                aria-label="Insert table"
                aria-haspopup="dialog"
                aria-expanded={!!pos}
            >
                <TableIcon size={15} />
            </button>
            {pos && (
                <div
                    className="context-menu-panel table-insert-panel"
                    style={{ top: pos.top, right: pos.right }}
                    role="dialog"
                    aria-label="Table size"
                >
                    <TableSizeGrid
                        maxRows={TABLE_GRID_ROWS}
                        maxCols={TABLE_GRID_COLS}
                        onPick={(rows, cols) => {
                            setPos(null);
                            requestTableInsert(path, rows, cols);
                        }}
                    />
                </div>
            )}
        </div>
    );
}
