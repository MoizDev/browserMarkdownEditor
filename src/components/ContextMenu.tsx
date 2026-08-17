import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import TableSizeGrid from './TableSizeGrid';
import type { ContextMenuRequest } from '../utils/contextMenu';

interface ContextMenuProps {
    /** What to draw, where to hang it, and who to give focus back to. One
     *  request describes one menu; a new one replaces this menu entirely. */
    request: ContextMenuRequest;
    /** Take the menu down. Also runs the request's own `onClose` (the store
     *  does that), which is how a tree row clears its own highlight. */
    onClose: () => void;
}

/** How far the menu keeps from the edge of the window, in px. */
const MARGIN = 8;

/**
 * How a surface is hidden for the one frame between being rendered and being
 * measured.
 *
 * `opacity: 0` and NOT `visibility: hidden`, which is the obvious choice and
 * is wrong here: a visibility-hidden element cannot take focus at all, and
 * `focus()` on one is a silent no-op. Measured — with `visibility` the menu
 * opened with the keyboard focus still on whatever raised it, so the arrow
 * keys did nothing and Escape only worked because its listener is on `window`.
 * The focus effect runs while this frame is still on screen (React flushes the
 * pending passive effects before the re-render the measurement schedules), so
 * the hidden state has to be one a focusable element survives.
 */
const HIDDEN_UNTIL_MEASURED: React.CSSProperties = { opacity: 0, pointerEvents: 'none' };

/**
 * Where one axis of the menu goes, given the click, the menu's size along that
 * axis and the window's.
 *
 * FLIP FIRST, THEN CLAMP. The flip is what makes a right-click near the right
 * edge open leftwards, the way every native menu does; the clamp is for the
 * case the flip cannot rescue — a menu taller than the viewport fits on
 * neither side of the click, and without it the bottom rows would be off
 * screen with nothing to scroll. Same rule as the vault menu's width
 * computation (FileExplorer.tsx:22-26): compute the geometry, do not merely
 * cap it in CSS.
 */
function place(point: number, size: number, limit: number): number {
    const flipped = point + size + MARGIN > limit ? point - size : point;
    return Math.max(MARGIN, Math.min(flipped, limit - size - MARGIN));
}

/**
 * The app's own right-click menu — the one surface every context menu in the
 * app is drawn by, whoever raised it (the editor, a table cell, a file tree
 * row).
 *
 * It is a component over a module-level store rather than a component per
 * caller because the callers have nothing else in common: one of them is a DOM
 * handler hung off a CodeMirror widget, which knows nothing about React. See
 * utils/contextMenu.ts for why that store shape is the only one that works.
 *
 * Modelled on VaultMenu — the app's only other dismissible popover — with
 * three differences that all come from WHERE this one sits. It hangs from a
 * point in the viewport rather than from a button, so a scroll invalidates its
 * position and must dismiss it; it can be raised anywhere, so it flips on both
 * axes instead of only leftwards; and it is drawn over CodeMirror, which binds
 * Escape itself — so Escape here is capture-phase and stopped, the treatment
 * ConfirmDialog.tsx:58-67 already documents.
 */
export default function ContextMenu({ request, onClose }: ContextMenuProps) {
    const menuRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
    // A click somewhere else is already choosing where focus goes; taking it
    // back to the opener on the way out would yank it away again.
    const restoreFocusRef = useRef(true);

    /** Null until measured. The menu is drawn invisible for that one frame
     *  rather than at the raw click point, so it never flashes in the wrong
     *  place. */
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

    /** The id of the grid row whose size picker is open, and the rect of that
     *  row — the flyout hangs off the row, like a native submenu. */
    const [grid, setGrid] = useState<{ id: string; anchor: DOMRect } | null>(null);
    const [panelPos, setPanelPos] = useState<{ left: number; top: number } | null>(null);

    /* One menu REPLACING another does not remount this component — the store
       swaps the request and React re-renders in place. Everything measured
       about the old menu has to go with it, or the new one is positioned from
       the old one's rect, measured in the room the old one's position left it
       (see the layout effect), and any flyout the old menu had open stays open
       hanging off a row that is no longer there. Adjusting state during render
       when a prop changes is React's own pattern for this, and it costs a
       re-render before the commit rather than a frame on screen. */
    const [shown, setShown] = useState(request);
    if (shown !== request) {
        setShown(request);
        setPos(null);
        setGrid(null);
    }

    /* Which rows can hold focus, in the order the arrow keys walk them.
       Separators are not rows, so an index into `entries` would put gaps in
       itemsRef and make every arrow-key walk step over holes. */
    const rowIndex = useMemo(() => {
        const map = new Map<string, number>();
        let i = 0;
        for (const entry of request.entries) {
            if (entry.kind !== 'separator') map.set(entry.id, i++);
        }
        return map;
    }, [request.entries]);

    /* Position from the menu's OWN measured size — it depends on the entries,
       so it cannot be known before the first render. Layout effect, so the
       move lands in the same frame the browser paints.

       Measured at the TOP-LEFT CORNER, not at the click point, which is why
       the unmeasured render puts it there. A fixed-position box with `left`
       set and no width shrinks to fit the room between that edge and the
       viewport's — so measuring it at a click near the right edge would
       measure a box squeezed down to its min-width, and the flip would then
       place a wider menu than the one it measured, back off the screen. At 0,0
       the whole viewport is available and the measurement is the real one. */
    useLayoutEffect(() => {
        const el = menuRef.current;
        if (!el) return;
        // Rows from a menu this one REPLACED (a right-click while another menu
        // is open re-renders this component rather than remounting it) are
        // still sitting past the end of the array, detached. Arrow-key
        // navigation would happily focus one.
        itemsRef.current.length = rowIndex.size;
        // For the same reason: the pointerdown that dismissed the previous
        // menu cleared this flag, and the menu that replaced it is owed its
        // own focus round trip.
        restoreFocusRef.current = true;
        const rect = el.getBoundingClientRect();
        setPos({
            left: place(request.x, rect.width, window.innerWidth),
            top: place(request.y, rect.height, window.innerHeight),
        });
    }, [request, rowIndex]);

    // Same treatment for the size picker's flyout: beside the row it belongs
    // to, flipped to the row's left when there is no room to its right.
    useLayoutEffect(() => {
        const el = panelRef.current;
        if (!grid || !el) { setPanelPos(null); return; }
        const rect = el.getBoundingClientRect();
        const right = grid.anchor.right + MARGIN;
        const left = right + rect.width + MARGIN > window.innerWidth
            ? Math.max(MARGIN, grid.anchor.left - MARGIN - rect.width)
            : right;
        setPanelPos({ left, top: place(grid.anchor.top, rect.height, window.innerHeight) });
    }, [grid]);

    /* Dismissal. Mirrors VaultMenu.tsx:61-77, with the two listeners a menu
       anchored to a VIEWPORT POINT needs and the vault button's menu did not:
       a scroll moves the thing the menu was aimed at out from under it, and
       this menu is routinely raised inside a scrollable editor.

       Escape is on `window`, in the CAPTURE phase, and both prevented and
       stopped. VaultMenu's bubble-phase Escape is fine in the sidebar and
       wrong here: CodeMirror binds Escape too, and focus is usually still in
       (or one Tab away from) a pane behind this menu — which is the exact bug
       ConfirmDialog.tsx:58-67 was written to fix. */
    useEffect(() => {
        const inside = (node: EventTarget | null): boolean =>
            node instanceof Node
            && (!!menuRef.current?.contains(node) || !!panelRef.current?.contains(node));

        const onPointerDown = (e: PointerEvent) => {
            if (inside(e.target)) return;
            restoreFocusRef.current = false;
            onClose();
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            onClose();
        };
        // Capture, because a scroll inside the editor does not bubble to
        // window. A scroll of the menu's OWN content is not a reason to close
        // it, hence the containment test.
        const onScroll = (e: Event) => { if (!inside(e.target)) onClose(); };

        document.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onClose);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('keydown', onKeyDown, true);
            document.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onClose);
        };
    }, [onClose]);

    /* Take the keyboard on the way in and hand it back on the way out.
       In an effect rather than with `autoFocus`, so StrictMode's simulated
       remount (setup → cleanup → setup) still ends with a row focused instead
       of with the cleanup's restore having the last word — the reasoning
       ConfirmDialog.tsx:77-80 records.

       The FIRST ENABLED row, not row 0: a disabled <button> cannot take focus
       at all, and this menu deliberately keeps its dead rows on screen. With
       every row disabled the menu itself takes focus, so the arrow keys and
       Escape still have somewhere to land. */
    useEffect(() => {
        const first = itemsRef.current.find(el => !!el && !el.disabled);
        (first ?? menuRef.current)?.focus({ preventScroll: true });
        // Captured per request, so a menu that REPLACED another still hands
        // focus back to the element its own right-click came from.
        const opener = request.opener;
        return () => {
            if (!restoreFocusRef.current) return;
            // ...and only if nothing else has taken the keyboard in the
            // meantime. A row's own `run` may place focus deliberately, and it
            // runs SYNCHRONOUSLY while this cleanup does not — so an
            // unconditional restore undoes it. Measured: Insert table… leaves
            // the caret in the new table's first header cell, and this handed
            // focus straight back to .cm-content, where the caret had already
            // mapped past the table — so the next keystroke landed on the line
            // AFTER the table the user had just asked for.
            //
            // Dismissing leaves focus nowhere, which is what makes this test
            // the right one: a passive cleanup runs after the row is detached,
            // so Escape and a pick-with-no-focus-of-its-own both arrive here
            // with the document back on <body>.
            const active = document.activeElement;
            if (active && active !== document.body) return;
            if (opener?.isConnected) opener.focus();
        };
    }, [request]);

    /** Arrow-key navigation skips DISABLED rows — they stay on screen so the
     *  reader can see what is unavailable and why, but stopping on one would
     *  be a keyboard trap for a row that cannot do anything. */
    const moveFocus = useCallback((to: 'first' | 'last' | 'next' | 'prev') => {
        const rows = itemsRef.current.filter(
            (el): el is HTMLButtonElement => !!el && !el.disabled);
        if (!rows.length) return;
        const from = rows.indexOf(document.activeElement as HTMLButtonElement);
        const next = to === 'first' ? 0
            : to === 'last' ? rows.length - 1
                : to === 'next' ? (from < 0 ? 0 : (from + 1) % rows.length)
                    : (from < 0 ? rows.length - 1 : (from - 1 + rows.length) % rows.length);
        rows[next].focus();
    }, []);

    /** Shut the flyout and put focus back on the row it came out of. Not
     *  inside the state updater: StrictMode invokes those twice, and moving
     *  focus is not something to do twice. */
    const closeGrid = useCallback(() => {
        if (!grid) return;
        const row = itemsRef.current[rowIndex.get(grid.id) ?? -1];
        setGrid(null);
        row?.focus();
    }, [grid, rowIndex]);

    const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        switch (e.key) {
            case 'ArrowDown': e.preventDefault(); moveFocus('next'); break;
            case 'ArrowUp': e.preventDefault(); moveFocus('prev'); break;
            case 'Home': e.preventDefault(); moveFocus('first'); break;
            case 'End': e.preventDefault(); moveFocus('last'); break;
            case 'ArrowLeft':
                // Only meaningful while a flyout is open — otherwise leave the
                // key alone rather than swallowing it.
                if (grid) { e.preventDefault(); closeGrid(); }
                break;
            default: break;
        }
    };

    /** The flyout's own keys. Everything the grid handles it stops itself; what
     *  reaches here is ArrowLeft at the grid's left edge, which means "back to
     *  the menu". */
    const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'ArrowLeft') return;
        e.preventDefault();
        closeGrid();
    };

    /** Close FIRST, then act. A `run` that raises the app's dialog would
     *  otherwise be fighting this menu for the focus it is about to take. */
    const activate = (run: () => void | Promise<void>) => {
        onClose();
        void run();
    };

    // A file dropped from the desktop on an UNCANCELLED target navigates the
    // whole app away to that file, taking every unsaved buffer with it. This
    // menu is a plain div over the workspace, so it is one more surface that
    // has to refuse a drop itself (the same rule as .view-content and the
    // split divider).
    const cancelDrop = (e: React.DragEvent) => e.preventDefault();

    return (
        <>
            <div
                ref={menuRef}
                className="context-menu"
                role="menu"
                aria-label={request.label}
                // Focusable only as the fallback for a menu whose every row is
                // disabled; -1 keeps it out of the Tab order.
                tabIndex={-1}
                // Invisible and at the corner until measured — see the layout
                // effect for why the corner and not the click point, and
                // HIDDEN_UNTIL_MEASURED for why not `visibility`.
                style={{
                    left: pos ? pos.left : 0,
                    top: pos ? pos.top : 0,
                    ...(pos ? null : HIDDEN_UNTIL_MEASURED),
                }}
                onKeyDown={onMenuKeyDown}
                // A right-click ON the menu is still a right-click, and
                // without this the browser's own menu opens on top of the
                // app's — the one thing this whole surface exists to replace.
                onContextMenu={(e) => e.preventDefault()}
                onDragOver={cancelDrop}
                onDrop={cancelDrop}
            >
                {request.entries.map(entry => {
                    if (entry.kind === 'separator') {
                        return <div key={entry.id} className="context-menu-separator" role="separator" />;
                    }

                    const index = rowIndex.get(entry.id) ?? 0;

                    if (entry.kind === 'grid') {
                        const open = grid?.id === entry.id;
                        return (
                            <button
                                key={entry.id}
                                ref={el => { itemsRef.current[index] = el; }}
                                className="context-menu-item"
                                role="menuitem"
                                aria-haspopup="true"
                                aria-expanded={open}
                                disabled={entry.disabled}
                                title={entry.reason}
                                onClick={e => {
                                    const anchor = e.currentTarget.getBoundingClientRect();
                                    setGrid(current => (current?.id === entry.id ? null : { id: entry.id, anchor }));
                                }}
                                onKeyDown={e => {
                                    if (e.key !== 'ArrowRight' || open) return;
                                    e.preventDefault();
                                    setGrid({ id: entry.id, anchor: e.currentTarget.getBoundingClientRect() });
                                }}
                            >
                                {entry.label}
                                <span className="context-menu-item-arrow" aria-hidden="true">▸</span>
                            </button>
                        );
                    }

                    return (
                        <button
                            key={entry.id}
                            ref={el => { itemsRef.current[index] = el; }}
                            className={`context-menu-item${entry.danger ? ' is-danger' : ''}`}
                            role="menuitem"
                            disabled={entry.disabled}
                            // Required when disabled: a dead row that says
                            // nothing is indistinguishable from a broken one.
                            title={entry.reason}
                            onClick={() => activate(entry.run)}
                        >
                            {entry.label}
                        </button>
                    );
                })}
            </div>

            {/* The size picker is a flyout BESIDE the menu, not a modal: it has
                no backdrop, takes no focus round trip and needs no change to
                the app's ask()/tell() dialog — which could not host it anyway
                (its children render inside a <p> and its confirm carries no
                value). Positioned inline because only this component knows the
                row it hangs off; the stylesheet gives it its chrome. */}
            {grid && (() => {
                const entry = request.entries.find(e => e.id === grid.id);
                if (!entry || entry.kind !== 'grid') return null;
                return (
                    <div
                        ref={panelRef}
                        className="context-menu-panel"
                        style={{
                            position: 'fixed',
                            left: panelPos ? panelPos.left : 0,
                            top: panelPos ? panelPos.top : 0,
                            ...(panelPos ? null : HIDDEN_UNTIL_MEASURED),
                        }}
                        onKeyDown={onPanelKeyDown}
                        onContextMenu={(e) => e.preventDefault()}
                        onDragOver={cancelDrop}
                        onDrop={cancelDrop}
                    >
                        <TableSizeGrid
                            maxRows={entry.maxRows}
                            maxCols={entry.maxCols}
                            onPick={(rows, cols) => activate(() => entry.pick(rows, cols))}
                        />
                    </div>
                );
            })()}
        </>
    );
}
