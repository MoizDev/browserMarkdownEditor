import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { dismissOnEscape } from '../../../utils/escapeDismiss';
import { MoreToolIcon, ToolIcon } from './toolIcons';
import './chrome.css';

export interface ToolChoice {
    readonly id: string;
    readonly label: string;
    readonly shortcut?: string;
    readonly figure?: string;
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
}

function sameTool(a: ToolChoice, b: ToolChoice): boolean {
    return a.id === b.id && a.figure === b.figure;
}

function name(choice: ToolChoice): string {
    return choice.shortcut ? `${choice.label} — ${choice.shortcut}` : choice.label;
}

export function ToolStrip({ primary, more, selected, moreLabel, toolsLabel, disabled, disabledReason, select }: ToolStripProps) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const fit = useFittingTools(root, primary.length);
    // The bar's tools that do not fit its row move to the front of More tools, in order, rather than scrolling inside
    // the bar: a scrolled row left a sliver of a cut-off icon beside the chevron in a narrow pane.
    const shown = fit < primary.length ? primary.slice(0, fit) : primary;
    const overflow = fit < primary.length ? [...primary.slice(fit), ...more] : more;
    const trigger = useRef<HTMLButtonElement>(null);
    const popup = useRef<HTMLDivElement>(null);
    const close = useCallback(() => {
        setOpen(false);
        trigger.current?.focus();
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
        const label = name(choice);
        const reason = disabledReason?.(choice);
        return <button
            type="button"
            key={`${choice.id}:${choice.figure ?? ''}`}
            className="board-chrome-tool board-chrome-tool-icon"
            aria-label={label}
            data-tooltip={reason ?? label}
            aria-pressed={sameTool(choice, selected)}
            disabled={disabled || reason !== undefined}
            onClick={() => { select(choice); setOpen(false); }}
        ><ToolIcon id={choice.id} figure={choice.figure} /></button>;
    }

    const moreDisabled = disabled || overflow.every(choice => disabledReason?.(choice) !== undefined);
    const moreReason = moreDisabled ? overflow.map(choice => disabledReason?.(choice)).find(reason => reason !== undefined) : undefined;
    // A tool living in the popover still shows on the bar: the chevron takes the active look while it is selected.
    const moreCurrent = overflow.some(choice => sameTool(choice, selected));
    return <div className="board-chrome-tools" ref={root}>
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

/** How many of the bar's tools fit its row. The row is the chrome's bottom grid; when the zoom controls sit beside the
 *  bar (ViewerHost has not set `data-chrome-stacked`) they take a column on each side, the centred bar the rest. Sizes
 *  are read from the rendered bar (button step, the strip's own padding and chevron), never assumed. */
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
