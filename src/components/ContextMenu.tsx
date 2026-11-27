import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { moduleSlot } from './moduleSlot';
import { ErrorBoundary, PartFailureBox } from './ErrorBoundary';
import TableSizeGrid from './TableSizeGrid';
import { Check } from './icons';
import type { ContextMenuRequest, ContextMenuSubmenu } from '../utils/contextMenu';

const EntryStylePicker = moduleSlot(() => import('./EntryStylePicker')).View;

interface ContextMenuProps {
    request: ContextMenuRequest;
    onClose: () => void;
}

const MARGIN = 8;

const HIDDEN_UNTIL_MEASURED: React.CSSProperties = { opacity: 0, pointerEvents: 'none' };

function place(point: number, size: number, limit: number): number {
    const flipped = point + size + MARGIN > limit ? point - size : point;
    return Math.max(MARGIN, Math.min(flipped, limit - size - MARGIN));
}

function placeAbove(point: number, size: number, limit: number): number {
    const above = point - size;
    return above >= MARGIN ? above : place(point, size, limit);
}

function SubmenuRows({ entries, activate, direction }: {
    entries: ContextMenuSubmenu['entries'];
    activate: (run: () => void | Promise<void>, keepOpen?: boolean) => void;
    direction?: 'ltr' | 'rtl';
}) {
    const [child, setChild] = useState<{ entry: ContextMenuSubmenu; anchor: DOMRect; focus: boolean } | null>(null);
    const childPanel = useRef<HTMLDivElement>(null);
    const childTrigger = useRef<HTMLButtonElement>(null);
    const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
    useLayoutEffect(() => {
        const el = childPanel.current;
        if (!child || !el) { setPosition(null); return; }
        const rect = el.getBoundingClientRect();
        const right = child.anchor.right + MARGIN;
        const leftSide = child.anchor.left - MARGIN - rect.width;
        const left = direction === 'rtl' && leftSide >= MARGIN ? leftSide
            : right + rect.width + MARGIN > window.innerWidth ? Math.max(MARGIN, leftSide) : right;
        setPosition({ left, top: place(child.anchor.top, rect.height, window.innerHeight) });
        if (child.focus) el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }, [child, direction]);

    return <>
        {entries.map(item => {
            if (item.kind === 'separator') return <div key={item.id} className="context-menu-separator" role="separator" />;
            if (item.kind === 'submenu') return <button key={item.id} type="button" className="context-menu-item"
                role="menuitem" aria-haspopup="menu" aria-expanded={child?.entry.id === item.id}
                disabled={item.disabled} data-tooltip={item.reason}
                onMouseEnter={event => {
                    if (!item.disabled && child?.entry.id !== item.id) {
                        childTrigger.current = event.currentTarget;
                        setChild({ entry: item, anchor: event.currentTarget.getBoundingClientRect(), focus: false });
                    }
                }}
                onClick={event => {
                    childTrigger.current = event.currentTarget;
                    setChild({ entry: item, anchor: event.currentTarget.getBoundingClientRect(), focus: true });
                }}
                onKeyDown={event => {
                    if (event.key !== (direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight')) return;
                    event.preventDefault();
                    event.stopPropagation();
                    childTrigger.current = event.currentTarget;
                    setChild({ entry: item, anchor: event.currentTarget.getBoundingClientRect(), focus: true });
                }}>{item.label}<span className="context-menu-item-arrow" aria-hidden="true">{direction === 'rtl' ? '◂' : '▸'}</span></button>;
            return <button key={item.id} type="button" className={`context-menu-item${item.danger ? ' is-danger' : ''}`}
                role={item.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={item.checked}
                disabled={item.disabled} data-tooltip={item.reason} onMouseEnter={() => setChild(null)}
                onClick={() => activate(item.run, item.keepOpen)}>
                {item.checked !== undefined && <span className="context-menu-item-check" aria-hidden="true">{item.checked && <Check size={14} />}</span>}
                {item.label}
                {item.shortcut && <span style={{ marginInlineStart: 'auto', direction: 'ltr', unicodeBidi: 'isolate' }}>{item.shortcut}</span>}
            </button>;
        })}
        {child && <div ref={childPanel} className="context-menu-panel" style={{ position: 'fixed',
            left: position?.left ?? 0, top: position?.top ?? 0, ...(position ? null : HIDDEN_UNTIL_MEASURED) }}
            onKeyDown={event => {
                if (event.key === (direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft')) {
                    event.preventDefault();
                    event.stopPropagation();
                    setChild(null);
                    childTrigger.current?.focus();
                    return;
                }
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                const rows = Array.from(childPanel.current?.querySelectorAll<HTMLButtonElement>(':scope > .context-menu > button:not(:disabled)') ?? []);
                if (!rows.length) return;
                event.preventDefault();
                event.stopPropagation();
                const index = rows.indexOf(document.activeElement as HTMLButtonElement);
                const step = event.key === 'ArrowDown' ? 1 : -1;
                rows[(index + step + rows.length) % rows.length].focus();
            }}>
            <div className="context-menu" role="menu" aria-label={child.entry.label} style={{ position: 'static' }}>
                <SubmenuRows entries={child.entry.entries} activate={activate} direction={direction} />
            </div>
        </div>}
    </>;
}

export default function ContextMenu({ request, onClose }: ContextMenuProps) {
    const menuRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
    const restoreFocusRef = useRef(true);

    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

    const [flyout, setFlyout] = useState<{ id: string; anchor: DOMRect; focus?: boolean } | null>(null);
    const [panelPos, setPanelPos] = useState<{ left: number; top: number } | null>(null);

    const requestRef = useRef(request);
    useLayoutEffect(() => { requestRef.current = request; }, [request]);

    const [shown, setShown] = useState(request);
    if (shown !== request) {
        setShown(request);
        setPos(null);
        setFlyout(null);
    }

    const hasChecks = useMemo(
        () => request.entries.some(e => e.kind === 'command' && e.checked !== undefined),
        [request.entries]);

    const rowIndex = useMemo(() => {
        const map = new Map<string, number>();
        let i = 0;
        for (const entry of request.entries) {
            if (entry.kind !== 'separator' && entry.kind !== 'label') map.set(entry.id, i++);
        }
        return map;
    }, [request.entries]);

    useLayoutEffect(() => {
        const el = menuRef.current;
        if (!el) return;
        itemsRef.current.length = rowIndex.size;
        restoreFocusRef.current = true;
        const rect = el.getBoundingClientRect();
        setPos({
            left: place(request.x, rect.width, window.innerWidth),
            top: request.above ? placeAbove(request.y, rect.height, window.innerHeight) : place(request.y, rect.height, window.innerHeight),
        });
    }, [request, rowIndex]);

    useLayoutEffect(() => {
        const el = panelRef.current;
        if (!flyout || !el) { setPanelPos(null); return; }
        const rect = el.getBoundingClientRect();
        const right = flyout.anchor.right + MARGIN;
        const leftSide = flyout.anchor.left - MARGIN - rect.width;
        const left = request.dir === 'rtl' && leftSide >= MARGIN ? leftSide
            : right + rect.width + MARGIN > window.innerWidth ? Math.max(MARGIN, leftSide) : right;
        setPanelPos({ left, top: place(flyout.anchor.top, rect.height, window.innerHeight) });
        if (flyout.focus) el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }, [flyout, request.dir]);

    useEffect(() => {
        const inside = (node: EventTarget | null): boolean =>
            node instanceof Node
            && (!!menuRef.current?.contains(node) || !!panelRef.current?.contains(node));

        const onPointerDown = (e: PointerEvent) => {
            if (inside(e.target)) return;
            const anchor = requestRef.current.anchor;
            if (anchor && e.target instanceof Node && anchor.contains(e.target)) return;
            restoreFocusRef.current = false;
            onClose();
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            onClose();
        };
        const moves = (target: EventTarget | null): boolean => {
            if (!(target instanceof Element)) return true;
            const { opener, x, y } = requestRef.current;
            if (opener && target.contains(opener)) return true;
            const box = target.getBoundingClientRect();
            return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
        };
        const onScroll = (e: Event) => {
            if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
            if (!inside(e.target) && moves(e.target)) onClose();
        };

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

    useEffect(() => {
        const first = itemsRef.current.find(el => !!el && !el.disabled);
        (first ?? menuRef.current)?.focus({ preventScroll: true });
        const opener = request.opener;
        return () => {
            if (!restoreFocusRef.current) return;
            const active = document.activeElement;
            if (active && active !== document.body) return;
            if (opener?.isConnected) opener.focus();
        };
    }, [request]);

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
    const closeFlyout = useCallback(() => {
        if (!flyout) return;
        const row = itemsRef.current[rowIndex.get(flyout.id) ?? -1];
        setFlyout(null);
        row?.focus();
    }, [flyout, rowIndex]);

    const swallowSelectAll = (e: React.KeyboardEvent<HTMLDivElement>): boolean => {
        if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'a'
            || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return false;
        e.preventDefault();
        return true;
    };

    const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (swallowSelectAll(e)) return;
        switch (e.key) {
            case 'ArrowDown': e.preventDefault(); moveFocus('next'); break;
            case 'ArrowUp': e.preventDefault(); moveFocus('prev'); break;
            case 'Home': e.preventDefault(); moveFocus('first'); break;
            case 'End': e.preventDefault(); moveFocus('last'); break;
            case 'ArrowLeft':
            case 'ArrowRight':
                if (flyout && e.key === (request.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft')) {
                    e.preventDefault(); closeFlyout();
                }
                break;
            default: break;
        }
    };

    const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (swallowSelectAll(e)) return;
        if (e.key === (request.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft')) {
            e.preventDefault();
            e.stopPropagation();
            closeFlyout();
            return;
        }
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        const entry = request.entries.find(item => item.id === flyout?.id);
        if (entry?.kind !== 'submenu') return;
        const rows = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>(':scope > .context-menu > button:not(:disabled)') ?? []);
        if (!rows.length) return;
        e.preventDefault();
        const index = rows.indexOf(document.activeElement as HTMLButtonElement);
        const step = e.key === 'ArrowDown' ? 1 : -1;
        rows[(index + step + rows.length) % rows.length].focus();
    };

    /** Close FIRST, then act. A `run` that raises the app's dialog would
     *  otherwise be fighting this menu for the focus it is about to take. */
    const activate = (run: () => void | Promise<void>, keepOpen = false) => {
        if (!keepOpen) onClose();
        void run();
    };

    const cancelDrop = (e: React.DragEvent) => e.preventDefault();

    return (
        <>
            <div
                ref={menuRef}
                className={request.className ? `context-menu ${request.className}` : 'context-menu'}
                role="menu"
                aria-label={request.label}
                lang={request.lang}
                dir={request.dir}
                tabIndex={-1}
                style={{
                    left: pos ? pos.left : 0,
                    top: pos ? pos.top : 0,
                    ...(pos ? null : HIDDEN_UNTIL_MEASURED),
                }}
                onKeyDown={onMenuKeyDown}
                onContextMenu={(e) => e.preventDefault()}
                onDragOver={cancelDrop}
                onDrop={cancelDrop}
            >
                {request.entries.map(entry => {
                    if (entry.kind === 'separator') {
                        return <div key={entry.id} className="context-menu-separator" role="separator" />;
                    }

                    if (entry.kind === 'label') {
                        return (
                            <div key={entry.id} className="context-menu-label" role="none" data-tooltip={entry.tooltip}>
                                {hasChecks && <span className="context-menu-item-check" aria-hidden="true" />}
                                {entry.label}
                            </div>
                        );
                    }

                    const index = rowIndex.get(entry.id) ?? 0;

                    if (entry.kind === 'grid' || entry.kind === 'entry-style' || entry.kind === 'submenu') {
                        const open = flyout?.id === entry.id;
                        return (
                            <button
                                key={entry.id}
                                ref={el => { itemsRef.current[index] = el; }}
                                className="context-menu-item"
                                role="menuitem"
                                aria-haspopup={entry.kind === 'submenu' ? 'menu' : true}
                                aria-expanded={open}
                                disabled={entry.disabled}
                                data-tooltip={entry.reason}
                                onMouseEnter={e => {
                                    if (entry.kind === 'submenu' && !entry.disabled && !open) {
                                        setFlyout({ id: entry.id, anchor: e.currentTarget.getBoundingClientRect() });
                                    }
                                }}
                                onClick={e => {
                                    const anchor = e.currentTarget.getBoundingClientRect();
                                    setFlyout(current => (current?.id === entry.id && entry.kind !== 'submenu'
                                        ? null : { id: entry.id, anchor, focus: entry.kind === 'submenu' }));
                                }}
                                onKeyDown={e => {
                                    const forward = request.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
                                    if (e.key !== forward || (open && entry.kind !== 'submenu')) return;
                                    e.preventDefault();
                                    setFlyout({ id: entry.id, anchor: e.currentTarget.getBoundingClientRect(), focus: entry.kind === 'submenu' });
                                }}
                            >
                                {entry.label}
                                <span className="context-menu-item-arrow" aria-hidden="true">{request.dir === 'rtl' ? '◂' : '▸'}</span>
                            </button>
                        );
                    }

                    return (
                        <button
                            key={entry.id}
                            ref={el => { itemsRef.current[index] = el; }}
                            className={`context-menu-item${entry.danger ? ' is-danger' : ''}`}
                            role={entry.checked !== undefined ? 'menuitemradio' : 'menuitem'}
                            aria-checked={entry.checked !== undefined ? entry.checked : undefined}
                            disabled={entry.disabled}
                            data-tooltip={entry.reason}
                            onMouseEnter={() => {
                                if (request.entries.find(item => item.id === flyout?.id)?.kind === 'submenu') setFlyout(null);
                            }}
                            onClick={() => activate(entry.run, entry.keepOpen)}
                        >
                            {hasChecks && (
                                <span className="context-menu-item-check" aria-hidden="true">
                                    {entry.checked && <Check size={14} />}
                                </span>
                            )}
                            {entry.label}
                            {entry.shortcut && <span style={{ marginInlineStart: 'auto', direction: 'ltr', unicodeBidi: 'isolate' }}>{entry.shortcut}</span>}
                        </button>
                    );
                })}
            </div>

            {flyout && (() => {
                const entry = request.entries.find(e => e.id === flyout.id);
                if (!entry || (entry.kind !== 'grid' && entry.kind !== 'entry-style' && entry.kind !== 'submenu')) return null;
                return (
                    <div
                        ref={panelRef}
                        className={request.className ? `context-menu-panel ${request.className}` : 'context-menu-panel'}
                        lang={request.lang}
                        dir={request.dir}
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
                        {entry.kind === 'submenu' ? (
                            <div className="context-menu" role="menu" aria-label={entry.label} style={{ position: 'static' }}>
                                <SubmenuRows key={entry.id} entries={entry.entries} activate={activate} direction={request.dir} />
                            </div>
                        ) : entry.kind === 'grid' ? (
                            <TableSizeGrid
                                maxRows={entry.maxRows}
                                maxCols={entry.maxCols}
                                onPick={(rows, cols) => activate(() => entry.pick(rows, cols))}
                            />
                        ) : (
                            <ErrorBoundary label="The icon picker" fallback={(error, retry) => (
                                <div className="folder-style-picker folder-style-failure"><PartFailureBox error={error} retry={retry} what="the icon picker" /></div>
                            )}>
                                <EntryStylePicker
                                    fallback={<div className="folder-style-picker folder-style-loading">Loading icons…</div>}
                                    icon={entry.icon}
                                    color={entry.color}
                                    onChange={entry.pick}
                                    onClose={closeFlyout}
                                />
                            </ErrorBoundary>
                        )}
                    </div>
                );
            })()}
        </>
    );
}
