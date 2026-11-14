import type { Rgba } from '../../platform/types';
import { figureLabelRequest, frameTitleRequest } from '../geom/providers';
import type { Node } from '../model/nodes';
import { editableTextRequest } from '../text/edit/request';
import { BoardFonts } from '../text/fonts';
import { BoardTextLayout } from '../text/layout';
import { ReferenceMeasurer } from '../text/measure';
import type { FaceTable, InkRef, TextLayoutRequest, TextPaint } from '../text/paint';
import type { RichText } from '../text/richText';
import { opacity, withOpacity } from './colour';
import type { PaintPalette } from './colour';
import type { TextMaterial } from './material';

// Provenance: text/edit host requests, figure geometry and paint material
// contracts; independent session service, no third-party source.
export interface BoardTextGeometry {
    readonly fonts: BoardFonts;
    readonly layout: BoardTextLayout;
    readonly faces: FaceTable;
    prepare(node: Readonly<Node>, options: { revision: string; zoom?: number; connectorLength?: number;
        anchor?: { readonly x: number; readonly y: number } }, signal: AbortSignal): Promise<{
            paint: TextPaint; request: TextLayoutRequest; placement: { x: number; y: number; scale: number };
        } | null>;
    dispose(): void;
}
export function createBoardTextGeometry(options: { fonts?: BoardFonts; onFontEpoch?: (epoch: number) => void;
    cooperate?: () => Promise<void> } = {}): BoardTextGeometry {
    let fonts = options.fonts, layout: BoardTextLayout | undefined, measurer: ReferenceMeasurer | undefined;
    let unsubscribe: (() => void) | undefined, disposed = false;
    const check = (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (disposed) throw new DOMException('Text geometry disposed', 'AbortError');
    };
    const getFonts = () => {
        check();
        fonts ??= new BoardFonts(document.fonts);
        if (!unsubscribe) unsubscribe = fonts.subscribe(epoch => { if (!disposed) options.onFontEpoch?.(epoch); });
        return fonts;
    };
    const getLayout = () => {
        check();
        if (!layout) {
            const context = new OffscreenCanvas(1, 1).getContext('2d');
            if (!context) throw new Error('Text measurement canvas unavailable');
            measurer = new ReferenceMeasurer(context);
            layout = new BoardTextLayout(measurer, getFonts());
        }
        return layout;
    };
    return {
        get fonts() { return getFonts(); },
        get layout() { return getLayout(); },
        get faces() { return getLayout().faceTable; },
        async prepare(node, requestOptions, signal) {
            check(signal);
            requestOptions = { ...requestOptions, ...(requestOptions.anchor ? { anchor: { ...requestOptions.anchor } } : {}) };
            let text: RichText;
            if (node.kind === 'text' || node.kind === 'sticky') text = node.text;
            else if (node.kind === 'figure' || node.kind === 'connector') {
                if (!node.label) return null;
                text = node.label;
            } else if (node.kind === 'frame') {
                text = frameTitleRequest(node, '', requestOptions.revision, getFonts().epoch, requestOptions.zoom ?? 1).text;
            } else return null;
            if (node.kind === 'connector' && (!requestOptions.anchor || !Number.isFinite(requestOptions.anchor.x)
                || !Number.isFinite(requestOptions.anchor.y))) throw new RangeError('Connector text requires an exact label anchor');
            const engine = getLayout(), registry = getFonts();
            const makeRequest = () => editableTextRequest(node, text, { revision: requestOptions.revision,
                fontEpoch: registry.epoch, zoom: requestOptions.zoom ?? 1, connectorLength: requestOptions.connectorLength });
            await engine.prepare(makeRequest());
            check(signal);
            await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
            check(signal);
            // Font loads can finish during the wait; the cache key must name the measurements actually used.
            const request = makeRequest(), paint = engine.layout(request);
            check(signal);
            let x = 0, y = 0, scale = 1;
            if (node.kind === 'figure') {
                const placement = figureLabelRequest(node, requestOptions.revision, request.fontEpoch)!;
                x = placement.x; y = placement.y;
            } else if (node.kind === 'sticky' || node.kind === 'text') scale = node.scale;
            else if (node.kind === 'frame') y = -paint.box.h;
            else if (node.kind === 'connector') {
                x = requestOptions.anchor!.x - paint.box.w / 2;
                y = requestOptions.anchor!.y - paint.box.h / 2;
            }
            return { paint, request, placement: { x, y, scale } };
        },
        dispose() { if (!disposed) { disposed = true; unsubscribe?.(); unsubscribe = undefined; measurer?.clear(); } },
    };
}

/** Parallel material arrays follow TextPaint visual order; inherited opacity is applied once. */
export function textPaintMaterial(paint: TextPaint, palette: PaintPalette, inheritedOpacity: number): TextMaterial {
    opacity(inheritedOpacity);
    const ink = (value: InkRef): Rgba => withOpacity(palette.stroke[value.swatch], inheritedOpacity);
    const backgrounds = paint.backgrounds.map(rect => {
        // TextPaint does not carry a separate code-background token. Use a subtle
        // ink-colour wash for code; regular highlights use the theme highlight pigment.
        const colour = rect.ink.role === 'code' ? withOpacity(palette.stroke[rect.ink.swatch], 0.12) : palette.highlight[rect.ink.swatch];
        return withOpacity(colour, inheritedOpacity);
    });
    const glyphs: Rgba[] = [];
    for (const line of paint.lines) for (const fragment of line.fragments) glyphs.push(ink(fragment.ink));
    return { glyphs, backgrounds, decorations: paint.decorations.map(rect => ink(rect.ink)), blend: 'normal' };
}
