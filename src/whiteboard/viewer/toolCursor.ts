import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { RenderToken } from '../../platform/render/types';
import type { PaintPalette } from '../render/colour';
import { colourCss, resolveSwatch } from '../render/colour';
import { styleGeometryMetrics } from '../geom/styleMetrics';
import type { BoardRuntime } from '../host/runtime';
import type { MappingHistory } from '../input/pointer';
import { sampleSurface, type RealSample } from '../input/tool';

type CursorPoint = Readonly<{ x: number; y: number; source: 'mouse' | 'pen' }>;
export interface BoardToolCursorOptions {
    readonly runtime: BoardRuntime;
    readonly token: RenderToken;
    readonly surface: HTMLElement;
    readonly overlay: HTMLElement;
    readonly mappings: MappingHistory;
    readonly sampleToSurface: (sample: RealSample) => Readonly<{ x: number; y: number }>;
    readonly palette: () => PaintPalette;
    readonly current: () => boolean;
    readonly visible: () => boolean;
    readonly schedule: (callback: () => void) => () => void;
    readonly error: (error: unknown) => void;
}

/** The cursor is view chrome: samples and tool state remain owned by the session. */
export function createBoardToolCursor(options: BoardToolCursorOptions) {
    const { runtime, surface } = options, session = runtime.session, doc = session.doc, owner = session.owner;
    const previous = surface.style.cursor;
    let disposed = false, point: CursorPoint | null = null, scheduled: (() => void) | undefined;
    let marker: HTMLDivElement | undefined;
    const active = () => !disposed && options.current() && options.visible() && session.owner === owner && session.doc === doc;
    const report = (error: unknown) => { try { options.error(error); } catch { /* Cursor failure cannot interrupt authoring. */ } };
    const reset = () => { marker?.remove(); marker = undefined; surface.style.cursor = previous; };
    const request = () => {
        if (disposed) return;
        if (!active()) { scheduled?.(); scheduled = undefined; point = null; reset(); return; }
        if (!scheduled) scheduled = options.schedule(() => { scheduled = undefined; });
    };
    const unsubscribe = runtime.tools.subscribe(request);
    const stopSession = session.subscribe(request);
    const retain = (x: number, y: number, source: 'mouse' | 'pen') => {
        if (!active() || !Number.isFinite(x) || !Number.isFinite(y)) return;
        point = { x, y, source }; request();
    };
    const shape = (frame: ScheduledFrame) => {
        const choice = runtime.tools.getSnapshot().active.id, next = doc.ui.next;
        if (choice === 'pen' || choice === 'highlighter') {
            const width = styleGeometryMetrics.fromPen(choice === 'pen' ? 'stroke:pen' : 'stroke:highlighter', doc.ui.penWidth);
            const colour = resolveSwatch(options.palette(), choice === 'pen' ? next.color : next.highlighterColor,
                choice === 'pen' ? 'stroke' : 'highlight');
            if (!colour || !Number.isFinite(width) || width <= 0) return null;
            return { diameter: Math.max(1, width * frame.view.camera.z), colour: colourCss(colour), filled: false };
        }
        if (choice === 'eraser') return { diameter: 16, colour: '#e9eef8', filled: false };
        if (choice === 'laser') return { diameter: 6, colour: '#ff4040', filled: true };
        return null;
    };
    return {
        hover(event: PointerEvent) {
            if (!active() || (event.pointerType !== 'mouse' && event.pointerType !== 'pen')) return;
            if (event.type === 'pointerout' && !surface.hasPointerCapture(event.pointerId)) { point = null; request(); return; }
            try {
                const p = options.mappings.surface(event.timeStamp, event.clientX, event.clientY);
                retain(p.x, p.y, event.pointerType);
            } catch (error) { report(error); }
        },
        sample(sample: RealSample) {
            if (!active()) return;
            if (sample.source !== 'mouse' && sample.source !== 'pen') { point = null; request(); return; }
            try { const p = sampleSurface(sample, options.sampleToSurface); retain(p.x, p.y, sample.source); }
            catch (error) { report(error); }
        },
        write(frame: ScheduledFrame) {
            if (!active()) { point = null; reset(); return; }
            const a = frame.token, b = options.token;
            if (a.vaultEpoch !== b.vaultEpoch || a.documentId !== b.documentId
                || a.bytesGeneration !== b.bytesGeneration || a.session !== b.session) return;
            const choice = runtime.tools.getSnapshot().active.id;
            const cursor = point ? shape(frame) : null;
            if (!cursor || !point) {
                marker?.remove(); marker = undefined;
                surface.style.cursor = choice === 'hand' ? 'grab' : choice === 'zoom' ? 'zoom-in'
                    : choice === 'select' ? previous : 'crosshair';
                return;
            }
            if (!marker) {
                marker = document.createElement('div'); marker.setAttribute('aria-hidden', 'true');
                marker.style.cssText = 'position:absolute;left:0;top:0;box-sizing:border-box;border-radius:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:1';
                options.overlay.append(marker);
            }
            const diameter = cursor.diameter;
            marker.style.width = `${diameter}px`; marker.style.height = `${diameter}px`;
            marker.style.left = `${point.x}px`; marker.style.top = `${point.y}px`;
            marker.style.border = `1px solid ${cursor.colour}`; marker.style.background = cursor.filled ? cursor.colour : 'transparent';
            marker.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.35)'; surface.style.cursor = 'none';
        },
        hide() { point = null; scheduled?.(); scheduled = undefined; reset(); },
        dispose() {
            if (disposed) return;
            disposed = true; scheduled?.(); scheduled = undefined; unsubscribe(); stopSession(); point = null; reset();
        },
    };
}
