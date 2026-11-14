import './chrome.css';

export interface DebugOverlayProps {
    readonly label: string;
    readonly locale: string;
    readonly direction: 'ltr' | 'rtl';
    readonly toolLabel: string;
    readonly selectionLabel: string;
    readonly sheetLabel: string;
    readonly zoomLabel: string;
    readonly frameTimeLabel: string;
    readonly nodeCountLabel: string;
    readonly visibleCountLabel: string;
    readonly backendLabel: string;
    readonly tool: string;
    readonly toolState: string;
    readonly selectionCount: number;
    readonly sheet: string;
    readonly zoom: number;
    readonly frameTimeMs: number;
    readonly nodeCount: number;
    readonly visibleCount: number;
    readonly backend: string;
    /** CSS-pixel bounds relative to the board overlay, after camera projection. */
    readonly outlines: readonly { readonly id: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number }[];
}

export function DebugOverlay(props: DebugOverlayProps) {
    const rows: readonly [string, string | number][] = [
        [props.toolLabel, `${props.tool}.${props.toolState}`], [props.selectionLabel, props.selectionCount],
        [props.sheetLabel, props.sheet], [props.zoomLabel, `${Math.round(props.zoom * 100)}%`],
        [props.frameTimeLabel, `${props.frameTimeMs.toFixed(1)} ms`], [props.nodeCountLabel, props.nodeCount],
        [props.visibleCountLabel, props.visibleCount], [props.backendLabel, props.backend],
    ];
    return <div className="board-debug-overlay" aria-label={props.label} lang={props.locale} dir={props.direction}>
        {props.outlines.map(outline => <span key={outline.id} className="board-debug-outline" aria-hidden="true"
            style={{ left: outline.x, top: outline.y, width: outline.width, height: outline.height }} />)}
        <dl className="board-debug-values">{rows.map(([label, value]) => <div key={label}>
            <dt>{label}</dt><dd>{value}</dd>
        </div>)}</dl>
    </div>;
}
