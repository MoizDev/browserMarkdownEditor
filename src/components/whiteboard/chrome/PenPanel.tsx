import { useEffect, useRef } from 'react';
import './chrome.css';

export interface PenSwatch {
    readonly id: string;
    readonly label: string;
    readonly color: string;
}

export interface PenPanelProps {
    readonly swatches: readonly PenSwatch[];
    readonly selectedColor: string | null;
    readonly nextColorCss: string;
    readonly indicatorOutline: string;
    readonly sliderPosition: number;
    readonly widthLabel: string;
    readonly mixedWidthLabel?: string;
    readonly hideLabel: string;
    readonly showLabel: string;
    readonly collapsed: boolean;
    readonly disabled: boolean;
    readonly setCollapsed: (value: boolean) => void;
    readonly setColor: (id: string) => void;
    readonly beginWidth: () => void;
    readonly changeWidth: (position: number) => void;
    readonly commitWidth: () => void;
    readonly resetWidth: () => void;
}

export function PenPanel(props: PenPanelProps) {
    const dragging = useRef(false);
    const opened = useRef(false);
    const timer = useRef<number | null>(null);
    const commit = useRef(props.commitWidth);
    useEffect(() => { commit.current = props.commitWidth; }, [props.commitWidth]);
    const finish = () => {
        if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
        dragging.current = false;
        if (opened.current) { opened.current = false; commit.current(); }
    };
    useEffect(() => () => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        if (opened.current) { opened.current = false; commit.current(); }
    }, []);
    // A double-click resets the slider; keep its first click in the same undo step.
    const deferFinish = () => {
        if (!dragging.current) return;
        dragging.current = false;
        timer.current = window.setTimeout(finish, 500);
    };
    const toggleLabel = props.collapsed ? props.showLabel : props.hideLabel;
    // The fold is a disclosure chevron at the end of the width row; its words are its name and tooltip. Written out as the button's
    // text, "Hide colours and pen width" wrapped over two centred lines at the top of the panel and read as the panel's title.
    const toggle = <button type="button" className="board-chrome-tool board-pen-toggle" aria-label={toggleLabel}
        data-tooltip={toggleLabel} aria-expanded={!props.collapsed} onClick={() => { finish(); props.setCollapsed(!props.collapsed); }}>
        {props.collapsed && <span className="board-pen-indicator" aria-hidden="true"
            style={{ background: props.nextColorCss, outlineColor: props.indicatorOutline }} />}
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d={props.collapsed ? 'm6 9 6 6 6-6' : 'm18 15-6-6-6 6'} />
        </svg>
    </button>;
    return <div className={props.collapsed ? 'board-pen-panel board-pen-panel-collapsed' : 'board-pen-panel'}>
        {props.collapsed && toggle}
        {!props.collapsed && <>
            <div className="board-pen-swatches">
                {props.swatches.map(swatch => <button key={swatch.id} type="button" className="board-pen-swatch"
                    aria-label={swatch.label} data-tooltip={swatch.label} aria-pressed={props.selectedColor === swatch.id}
                    disabled={props.disabled} onClick={() => props.setColor(swatch.id)}>
                    <span aria-hidden="true" style={{ background: swatch.color }} />
                </button>)}
            </div>
            <div className="board-pen-width-row">
                <input type="range" min={0} max={1} step={0.001} value={props.sliderPosition} aria-label={props.widthLabel}
                    aria-valuetext={props.mixedWidthLabel}
                    data-tooltip={props.widthLabel} disabled={props.disabled}
                    onPointerDown={event => {
                        if (opened.current && event.detail !== 2) finish();
                        if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
                        if (!opened.current) { props.beginWidth(); opened.current = true; }
                        dragging.current = true;
                    }}
                    onPointerUp={deferFinish} onPointerCancel={finish} onLostPointerCapture={deferFinish} onBlur={finish}
                    onChange={event => {
                        if (!dragging.current) { finish(); props.beginWidth(); }
                        props.changeWidth(Number(event.currentTarget.value));
                        if (!dragging.current) props.commitWidth();
                    }}
                    onDoubleClick={() => {
                        if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
                        dragging.current = false;
                        try { props.resetWidth(); }
                        finally { if (opened.current) { opened.current = false; commit.current(); } }
                    }} />
                {toggle}
            </div>
        </>}
    </div>;
}
