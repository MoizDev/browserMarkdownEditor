// Portalled to <body> so no ancestor App gives the panel (overflow, contain,
// a transform) can clip or re-anchor it — and the portal root carries
// `data-agent-panel` itself, because App's global shortcut guard asks the DOM
// (`closest('[data-agent-panel]')`), not React's tree.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { dismissOnEscape } from '../../utils/escapeDismiss';
import type { Theme } from '../../types';

const GAP = 6;
const MARGIN = 8;

export interface PopoverProps {
    anchor: HTMLElement | null;
    onClose: () => void;
    theme: Theme;
    label: string;
    placement?: 'below' | 'above';
    align?: 'start' | 'end';
    className?: string;
    children: ReactNode;
}

const ITEM_SELECTOR = '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled]), [role="option"]:not([disabled])';

export function Popover({ anchor, onClose, theme, label, placement = 'below', align = 'start', className, children }: PopoverProps) {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
    const onCloseRef = useRef(onClose);
    useEffect(() => { onCloseRef.current = onClose; });

    useLayoutEffect(() => {
        const el = ref.current;
        if (!anchor || !el) return;
        const place = () => {
            const r = anchor.getBoundingClientRect();
            const w = el.offsetWidth;
            let left = align === 'end' ? r.right - w : r.left;
            left = Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN));
            if (placement === 'above') {
                const header = anchor.closest('.agent-panel')?.querySelector('.agent-header');
                const ceiling = Math.max(MARGIN, header ? header.getBoundingClientRect().bottom + GAP : 0);
                setPos({ left, bottom: window.innerHeight - r.top + GAP, maxHeight: r.top - GAP - ceiling });
            } else {
                setPos({ left, top: r.bottom + GAP, maxHeight: window.innerHeight - r.bottom - GAP - MARGIN });
            }
        };
        place();
        window.addEventListener('resize', place);
        return () => window.removeEventListener('resize', place);
    }, [anchor, align, placement]);

    useLayoutEffect(() => {
        const el = ref.current;
        const first = el?.querySelector<HTMLElement>('[aria-checked="true"]') ?? el?.querySelector<HTMLElement>(ITEM_SELECTOR);
        first?.focus({ preventScroll: true });
        return () => {
            if (el && el.contains(document.activeElement) && anchor?.isConnected) anchor.focus({ preventScroll: true });
        };
    }, [anchor]);

    useEffect(() => dismissOnEscape(() => onCloseRef.current()), []);

    useEffect(() => {
        const onPointerDown = (e: PointerEvent) => {
            const target = e.target as Node | null;
            if (!target) return;
            if (ref.current?.contains(target) || anchor?.contains(target)) return;
            onCloseRef.current();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => document.removeEventListener('pointerdown', onPointerDown, true);
    }, [anchor]);

    const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
        if ((e.target as HTMLElement).getAttribute('role') === 'slider') return;
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
        if (!items.length) return;
        e.preventDefault();
        const at = items.indexOf(document.activeElement as HTMLElement);
        let next = 0;
        if (e.key === 'End') next = items.length - 1;
        else if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length;
        else if (e.key === 'ArrowUp') next = at <= 0 ? items.length - 1 : at - 1;
        items[next].focus();
    };

    return createPortal(
        <div className="agent-panel-layer" data-agent-panel="" data-theme={theme}>
            <div
                ref={ref}
                role="menu"
                aria-label={label}
                className={'agent-popover' + (className ? ' ' + className : '')}
                style={pos
                    ? { left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }
                    : { left: 0, top: 0, opacity: 0 }}
                onKeyDown={onKeyDown}
                onContextMenu={e => e.preventDefault()}
                // An uncancelled drop navigates the app away to the file.
                onDragOver={e => e.preventDefault()}
                onDrop={e => e.preventDefault()}
            >
                {children}
            </div>
        </div>,
        document.body,
    );
}
