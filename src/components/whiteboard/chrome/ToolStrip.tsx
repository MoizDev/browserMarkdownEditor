import { useCallback, useEffect, useRef, useState } from 'react';
import { dismissOnEscape } from '../../../utils/escapeDismiss';
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
    readonly select: (choice: ToolChoice) => void;
}

function sameTool(a: ToolChoice, b: ToolChoice): boolean {
    return a.id === b.id && a.figure === b.figure;
}

function name(choice: ToolChoice): string {
    return choice.shortcut ? `${choice.label} — ${choice.shortcut}` : choice.label;
}

export function ToolStrip({ primary, more, selected, moreLabel, toolsLabel, disabled, select }: ToolStripProps) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
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
        return <button
            type="button"
            key={`${choice.id}:${choice.figure ?? ''}`}
            className="board-chrome-tool"
            aria-label={label}
            data-tooltip={label}
            aria-pressed={sameTool(choice, selected)}
            disabled={disabled}
            onClick={() => { select(choice); setOpen(false); }}
        >{choice.label}</button>;
    }

    return <div className="board-chrome-tools" ref={root}>
        <div role="toolbar" aria-label={toolsLabel} className="board-chrome-tool-row" dir="ltr">
            <div className="board-chrome-primary-tools">{primary.map(button)}</div>
            <button type="button" ref={trigger} className="board-chrome-tool" aria-label={moreLabel}
                data-tooltip={moreLabel} aria-expanded={open} aria-haspopup="dialog" disabled={disabled}
                onClick={() => setOpen(value => !value)}>{moreLabel}</button>
        </div>
        {open && <div ref={popup} role="dialog" aria-label={moreLabel} className="board-chrome-more">
            {more.map(button)}
        </div>}
    </div>;
}
