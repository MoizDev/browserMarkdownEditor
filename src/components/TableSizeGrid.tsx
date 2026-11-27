import React, { useEffect, useRef, useState } from 'react';

interface TableSizeGridProps {
    maxRows: number;
    maxCols: number;
    onPick: (rows: number, cols: number) => void;
}

const MIN_ROWS = 2;

export default function TableSizeGrid({ maxRows, maxCols, onPick }: TableSizeGridProps) {
    const [at, setAt] = useState<{ row: number; col: number }>({ row: 1, col: 1 });
    const cellsRef = useRef<(HTMLButtonElement | null)[]>([]);

    const index = (row: number, col: number) => (row - 1) * maxCols + (col - 1);

    useEffect(() => { cellsRef.current[0]?.focus({ preventScroll: true }); }, []);

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
                    tabIndex={row === at.row && col === at.col ? 0 : -1}
                    aria-selected={on}
                    aria-label={`${col} × ${Math.max(MIN_ROWS, row)}`}
                    onPointerEnter={() => setAt({ row, col })}
                    onFocus={() => setAt({ row, col })}
                    onClick={() => onPick(Math.max(MIN_ROWS, row), col)}
                />
            );
        }
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
                style={{ '--table-grid-cols': maxCols } as React.CSSProperties}
            >
                {cells}
            </div>
            <div className="table-size-label" aria-live="polite">{cols} × {rows}</div>
            <div className="table-size-hint">The first row is the header.</div>
        </div>
    );
}
