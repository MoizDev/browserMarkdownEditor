import { useRef } from 'react';
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
    const finish = () => {
        if (!dragging.current) return;
        dragging.current = false;
        props.commitWidth();
    };
    const toggleLabel = props.collapsed ? props.showLabel : props.hideLabel;
    return <div className="board-pen-panel">
        <button type="button" className="board-chrome-tool board-pen-toggle" aria-label={toggleLabel}
            data-tooltip={toggleLabel} aria-expanded={!props.collapsed} onClick={() => props.setCollapsed(!props.collapsed)}>
            {props.collapsed && <span className="board-pen-indicator" aria-hidden="true"
                style={{ background: props.nextColorCss, outlineColor: props.indicatorOutline }} />}
            {toggleLabel}
        </button>
        {!props.collapsed && <>
            <div className="board-pen-swatches">
                {props.swatches.map(swatch => <button key={swatch.id} type="button" className="board-pen-swatch"
                    aria-label={swatch.label} data-tooltip={swatch.label} aria-pressed={props.selectedColor === swatch.id}
                    disabled={props.disabled} onClick={() => props.setColor(swatch.id)}>
                    <span aria-hidden="true" style={{ background: swatch.color }} />
                </button>)}
            </div>
            <input type="range" min={0} max={1} step={0.001} value={props.sliderPosition} aria-label={props.widthLabel}
                data-tooltip={props.widthLabel} disabled={props.disabled}
                onPointerDown={() => { dragging.current = true; props.beginWidth(); }}
                onPointerUp={finish} onPointerCancel={finish} onBlur={finish}
                onChange={event => {
                    if (!dragging.current) props.beginWidth();
                    props.changeWidth(Number(event.currentTarget.value));
                    if (!dragging.current) props.commitWidth();
                }}
                onDoubleClick={() => { finish(); props.resetWidth(); }} />
        </>}
    </div>;
}
