import React, { useEffect, useRef, useState } from 'react';

interface TableSizeGridProps {
    /** Rows the grid offers, INCLUDING the header row. */
    maxRows: number;
    /** Columns the grid offers. */
    maxCols: number;
    /** `rows` includes the header row and is never below 2. */
    onPick: (rows: number, cols: number) => void;
}

/**
 * The smallest number of rows a GFM table can have and still be one: a header
 * row and a body row. There is no such thing as a header-only table, so the
 * grid's first row lights two — the alternative is a whole row of cells that
 * cannot mean anything, and a picker with dead cells in it is worse than one
 * that rounds up.
 */
const MIN_ROWS = 2;

/**
 * The matrix size picker behind "Insert table…", in the shape everyone already
 * knows from Google Docs and Word: sweep across a grid of cells, watch the
 * rectangle light up, click to commit.
 *
 * It is a plain flyout rather than a dialog — see ContextMenu, which positions
 * it. Everything it knows is the two maxima it is given, so the same component
 * would serve any other "pick a rectangle" job unchanged.
 */
export default function TableSizeGrid({ maxRows, maxCols, onPick }: TableSizeGridProps) {
    /** The cell the rectangle is drawn to, 1-based. Both the pointer and the
     *  keyboard write it, so the label and the lit cells never disagree with
     *  what a click or Enter is about to do. */
    const [at, setAt] = useState<{ row: number; col: number }>({ row: 1, col: 1 });
    const cellsRef = useRef<(HTMLButtonElement | null)[]>([]);

    const index = (row: number, col: number) => (row - 1) * maxCols + (col - 1);

    // Take the keyboard the moment the flyout opens: it is reached by
    // ArrowRight from the menu row, and a picker that cannot then be driven by
    // the same keyboard would be a dead end.
    useEffect(() => { cellsRef.current[0]?.focus({ preventScroll: true }); }, []);

    /** What the current cell actually means, once the header rule is applied. */
    const rows = Math.max(MIN_ROWS, at.row);
    const cols = at.col;

    const focusCell = (row: number, col: number) => {
        cellsRef.current[index(row, col)]?.focus({ preventScroll: true });
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        let row = at.row;
        let col = at.col;
        switch (e.key) {
            case 'ArrowRight': col = Math.min(maxCols, col + 1); break;
            case 'ArrowLeft':
                // At the left edge the key means "back to the menu", so it is
                // left to bubble — ContextMenu closes the flyout on it.
                if (col === 1) return;
                col -= 1;
                break;
            case 'ArrowDown': row = Math.min(maxRows, row + 1); break;
            case 'ArrowUp': row = Math.max(1, row - 1); break;
            case 'Home': row = 1; col = 1; break;
            case 'End': row = maxRows; col = maxCols; break;
            default: return;
        }
        e.preventDefault();
        // Stopped, or the menu's own arrow handling would move focus between
        // its rows at the same time as this moves it between cells.
        e.stopPropagation();
        focusCell(row, col);
    };

    const cells: React.ReactNode[] = [];
    for (let row = 1; row <= maxRows; row++) {
        const inRow: React.ReactNode[] = [];
        for (let col = 1; col <= maxCols; col++) {
            const on = row <= rows && col <= cols;
            inRow.push(
                <button
                    key={col}
                    ref={el => { cellsRef.current[index(row, col)] = el; }}
                    className={`table-size-cell${on ? ' is-on' : ''}`}
                    role="gridcell"
                    // One roving tab stop, so Tab leaves the picker rather than
                    // walking eighty buttons.
                    tabIndex={row === at.row && col === at.col ? 0 : -1}
                    aria-selected={on}
                    aria-label={`${col} × ${Math.max(MIN_ROWS, row)}`}
                    onPointerEnter={() => setAt({ row, col })}
                    onFocus={() => setAt({ row, col })}
                    onClick={() => onPick(Math.max(MIN_ROWS, row), col)}
                />
            );
        }
        // A row wrapper out of the layout entirely: role="grid" requires
        // role="row" children to be a valid grid, while the cells have to stay
        // direct grid items of .table-size-grid for the stylesheet's
        // `grid-template-columns` to lay them out. `display: contents` is the
        // one thing that is both.
        cells.push(
            <div key={row} role="row" style={{ display: 'contents' }}>{inRow}</div>
        );
    }

    return (
        <div onKeyDown={onKeyDown}>
            <div
                className="table-size-grid"
                role="grid"
                aria-label="Table size"
                aria-rowcount={maxRows}
                aria-colcount={maxCols}
                // The column count is this component's to know — it is what
                // decides how many cells are rendered — so it is handed to the
                // stylesheet rather than written there a second time. The rule
                // has a fallback for the same reason every other var() here
                // does, but the two can no longer disagree: change `maxCols`
                // and the grid re-wraps to match, instead of the rows silently
                // wrapping at whatever number the CSS was last edited to.
                style={{ '--table-grid-cols': maxCols } as React.CSSProperties}
            >
                {cells}
            </div>
            {/* Announced, because the lit rectangle is the only other feedback
                and a screen reader cannot see it. */}
            <div className="table-size-label" aria-live="polite">{cols} × {rows}</div>
            <div className="table-size-hint">The first row is the header.</div>
        </div>
    );
}
