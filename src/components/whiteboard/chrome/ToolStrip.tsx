import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { dismissOnEscape } from '../../../utils/escapeDismiss';
import { LockIcon, MoreToolIcon, ToolIcon } from './toolIcons';
import { focusBoardInteraction } from './boardFocus';
import { chordLabel } from './toolChoices';
import './chrome.css';

export interface ToolChoice {
    readonly id: string;
    readonly label: string;
    readonly shortcut?: string;
    readonly figure?: string;
}

export interface ToolLockView {
    readonly locked: boolean;
    readonly label: string;
    readonly shortcut?: string;
    readonly disabledReason?: string;
    readonly toggle: () => void;
}

export interface ToolStripProps {
    readonly primary: readonly ToolChoice[];
    readonly more: readonly ToolChoice[];
    readonly selected: ToolChoice;
    readonly moreLabel: string;
    readonly toolsLabel: string;
    readonly disabled?: boolean;
    readonly disabledReason?: (choice: ToolChoice) => string | undefined;
    readonly select: (choice: ToolChoice) => void;
    readonly lock?: ToolLockView;
    readonly onShown?: (shown: readonly ToolChoice[]) => void;
    readonly dragTool?: (choice: ToolChoice, event: PointerEvent, bar: Element) => boolean;
}

function sameTool(a: ToolChoice, b: ToolChoice): boolean {
    return a.id === b.id && a.figure === b.figure;
}

export function ToolStrip({ primary, more, selected, moreLabel, toolsLabel, disabled, disabledReason, select, lock, onShown, dragTool }: ToolStripProps) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const fit = useFittingTools(root, primary.length);
    const shown = fit < primary.length ? primary.slice(0, fit) : primary;
    const overflow = fit < primary.length ? [...primary.slice(fit), ...more] : more;
    useEffect(() => { onShown?.(shown); });
    useEffect(() => () => onShown?.([]), [onShown]);
    const trigger = useRef<HTMLButtonElement>(null);
    const popup = useRef<HTMLDivElement>(null);
    const close = useCallback(() => {
        setOpen(false);
        focusBoardInteraction(root.current);
    }, []);

    useEffect(() => {
        if (!open) return;
        popup.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
        const removeEscape = dismissOnEscape(close);
        const onPointerDown = (event: PointerEvent) => {
            if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => {
            removeEscape();
            document.removeEventListener('pointerdown', onPointerDown);
        };
    }, [open, close]);

    function button(choice: ToolChoice) {
        const label = chordLabel(choice.label, choice.shortcut);
        const reason = disabledReason?.(choice);
        return <button
            type="button"
            key={`${choice.id}:${choice.figure ?? ''}`}
            className="board-chrome-tool board-chrome-tool-icon"
            aria-label={label}
            data-tooltip={reason ?? label}
            aria-pressed={sameTool(choice, selected)}
            disabled={disabled || reason !== undefined}
            onPointerDown={dragTool ? event => {
                const bar = event.currentTarget.closest<HTMLElement>('.board-chrome-tool-strip, .board-chrome-more');
                if (!bar || event.button !== 0 || !dragTool(choice, event.nativeEvent, bar)) return;
                if (!bar.classList.contains('board-chrome-more')) return;
                const leave = (move: PointerEvent) => {
                    const box = bar.getBoundingClientRect();
                    if (move.clientX < box.left || move.clientX > box.right || move.clientY < box.top || move.clientY > box.bottom) {
                        setOpen(false);
                        window.removeEventListener('pointermove', leave);
                    }
                };
                window.addEventListener('pointermove', leave);
                window.addEventListener('pointerup', () => window.removeEventListener('pointermove', leave), { once: true });
            } : undefined}
            onClick={() => { select(choice); setOpen(false); }}
        ><ToolIcon id={choice.id} figure={choice.figure} /></button>;
    }

    const moreDisabled = disabled || overflow.every(choice => disabledReason?.(choice) !== undefined);
    const moreReason = moreDisabled ? overflow.map(choice => disabledReason?.(choice)).find(reason => reason !== undefined) : undefined;
    const moreCurrent = overflow.some(choice => sameTool(choice, selected));
    return <div className="board-chrome-tools" ref={root}>
        {lock && <button type="button" className="board-chrome-tool board-chrome-tool-icon board-chrome-tool-lock"
            aria-label={chordLabel(lock.label, lock.shortcut)} data-tooltip={lock.disabledReason ?? chordLabel(lock.label, lock.shortcut)}
            aria-pressed={lock.locked} disabled={lock.disabledReason !== undefined} onClick={lock.toggle}>
            <LockIcon locked={lock.locked} />
        </button>}
        <div role="toolbar" aria-label={toolsLabel} className="board-chrome-tool-row board-chrome-tool-strip" dir="ltr">
            <div className="board-chrome-primary-tools">{shown.map(button)}</div>
            <button type="button" ref={trigger} className="board-chrome-tool board-chrome-tool-icon board-chrome-tool-more"
                aria-label={moreLabel} data-tooltip={moreReason ?? moreLabel} data-current={moreCurrent || undefined}
                aria-expanded={open} aria-haspopup="dialog" disabled={moreDisabled}
                onClick={() => setOpen(value => !value)}><MoreToolIcon /></button>
        </div>
        {open && <div ref={popup} role="dialog" aria-label={moreLabel} className="board-chrome-more">
            {overflow.map(button)}
        </div>}
    </div>;
}

function useFittingTools(root: RefObject<HTMLDivElement | null>, count: number): number {
    const [fit, setFit] = useState(count);
    useLayoutEffect(() => {
        const tools = root.current, row = tools?.parentElement, host = tools?.closest('.board-viewer-host');
        if (!tools || !row) return;
        const measure = () => {
            const strip = tools.querySelector<HTMLElement>('.board-chrome-tool-strip');
            const group = tools.querySelector<HTMLElement>('.board-chrome-primary-tools');
            const button = group?.querySelector<HTMLElement>('button');
            if (!strip || !group || !button || !row.clientWidth) return;
            const gap = parseFloat(getComputedStyle(group).columnGap) || 0, step = button.offsetWidth + gap;
            const zoom = row.querySelector<HTMLElement>('.board-chrome-zoom');
            const beside = zoom && !host?.hasAttribute('data-chrome-stacked') ? 2 * (zoom.offsetWidth + (parseFloat(getComputedStyle(row).columnGap) || 0)) : 0;
            const room = row.clientWidth - beside - (strip.offsetWidth - group.offsetWidth);
            if (step > 0) setFit(Math.max(1, Math.min(count, Math.floor((room + gap) / step))));
        };
        const resized = new ResizeObserver(measure);
        resized.observe(row);
        const restacked = new MutationObserver(measure);
        if (host) restacked.observe(host, { attributes: true, attributeFilter: ['data-chrome-stacked'] });
        measure();
        return () => { resized.disconnect(); restacked.disconnect(); };
    }, [root, count]);
    return fit;
}
