import type { Rgba } from '../../platform/types';
import { figureLabelRequest, frameTitleRequest } from '../geom/providers';
import { urlPoster } from '../media/urlPoster';
import type { EmbedNode, LinkcardNode, Node } from '../model/nodes';
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
export interface BoardTextGeometryOptions {
    readonly revision: string;
    readonly zoom?: number;
    readonly connectorLength?: number;
    readonly anchor?: { readonly x: number; readonly y: number };
}
export interface PreparedBoardText {
    readonly paint: TextPaint;
    readonly request: TextLayoutRequest;
    readonly placement: { x: number; y: number; scale: number };
}
export interface BoardTextGeometry {
    readonly fonts: BoardFonts;
    readonly layout: BoardTextLayout;
    readonly faces: FaceTable;
    prepareNow(node: Readonly<Node>, options: BoardTextGeometryOptions): PreparedBoardText | null;
    prepare(node: Readonly<Node>, options: BoardTextGeometryOptions, signal: AbortSignal): Promise<PreparedBoardText | null>;
    dispose(): void;
}
/** The poster's inset, in world units: 12 screen pixels at any zoom, as the frame title's size is kept. */
function cardPosterPad(zoom: number): number { return 12 / zoom; }
/** A stored preview's favicon sits on the title's line, its own size and gap left of the text. */
export const POSTER_FAVICON = 16, POSTER_FAVICON_GAP = 6, POSTER_FAVICON_INSET = POSTER_FAVICON + POSTER_FAVICON_GAP;
/** The picture band at a card's top when a preview picture is stored: the top 55% of the card; the poster sits below it. */
export const POSTER_IMAGE_SHARE = 0.55;
export function posterImageHeight(node: Readonly<EmbedNode | LinkcardNode>): number {
    return node.kind === 'linkcard' && node.preview?.image ? node.h * POSTER_IMAGE_SHARE : 0;
}
export function posterFaviconInset(node: Readonly<EmbedNode | LinkcardNode>): number {
    return node.kind === 'linkcard' && node.preview?.favicon ? POSTER_FAVICON_INSET : 0;
}
/**
 * A card's poster: the title (a preview's title, else the provider or domain), a preview's description, and the address the
 * link names; an embed also says its content is not in the picture. The actions (Load, Stop, Fetch preview, Open link) are
 * the viewer's controls on the card, so the poster names no instructions. It sits at the card's foot in the card's own width,
 * and as many lines as the card's on-screen height holds are kept (the rest end in an ellipsis).
 */
function cardPosterRequest(node: Readonly<EmbedNode | LinkcardNode>, revision: string, fontEpoch: number, zoom: number): TextLayoutRequest {
    const { title, address } = urlPoster(node.url), pad = cardPosterPad(zoom);
    const preview = node.kind === 'linkcard' ? node.preview : null;
    const lines = [preview?.title || title, ...(preview?.description ? [preview.description] : []), address,
        ...(node.kind === 'embed' ? ['Embedded content not included'] : [])];
    const paragraph = (text: string) => ({ kind: 'p' as const, level: 0 as const, dir: 'auto' as const, runs: [{ text, marks: {} }] });
    const size = 14 / zoom, lineHeight = size * 1.3, inset = posterFaviconInset(node);
    // Screen height is the world height times zoom; the line count is what that holds at this size, never less than one.
    const linesThatFit = Math.max(1, Math.floor((node.h - posterImageHeight(node) - 2 * pad) / lineHeight));
    return { text: { blocks: lines.map(paragraph) },
        revision, fontEpoch, width: Math.max(1, node.w - 2 * pad - inset),
        style: { font: 'sans', size, ink: { swatch: 'black', role: 'label' }, align: 'start', verticalAlign: 'start',
            padding: { top: 0, right: 0, bottom: 0, left: 0 }, minHeight: 0, overflow: 'allow', maxLines: linesThatFit, ellipsis: true } };
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
    const makeRequest = (node: Readonly<Node>, requestOptions: BoardTextGeometryOptions): TextLayoutRequest | null => {
        if (node.kind === 'embed' || node.kind === 'linkcard') return cardPosterRequest(node, requestOptions.revision, getFonts().epoch, requestOptions.zoom ?? 1);
        let text: RichText;
        if (node.kind === 'text' || node.kind === 'sticky') text = node.text;
        else if (node.kind === 'figure' || node.kind === 'connector') {
            if (!node.label) return null;
            text = node.label;
        } else if (node.kind === 'frame') {
            // An unnamed frame stores an empty title but is presented as "Frame", as the accessibility label does.
            text = frameTitleRequest(node, 'Frame', requestOptions.revision, getFonts().epoch, requestOptions.zoom ?? 1).text;
        } else return null;
        if (node.kind === 'connector' && (!requestOptions.anchor || !Number.isFinite(requestOptions.anchor.x)
            || !Number.isFinite(requestOptions.anchor.y))) throw new RangeError('Connector text requires an exact label anchor');
        return editableTextRequest(node, text, { revision: requestOptions.revision,
            fontEpoch: getFonts().epoch, zoom: requestOptions.zoom ?? 1, connectorLength: requestOptions.connectorLength });
    };
    const prepareNow = (node: Readonly<Node>, requestOptions: BoardTextGeometryOptions): PreparedBoardText | null => {
        check();
        const request = makeRequest(node, requestOptions);
        if (!request) return null;
        const paint = getLayout().layout(request);
        let x = 0, y = 0, scale = 1;
        if (node.kind === 'figure') {
            const placement = figureLabelRequest(node, requestOptions.revision, request.fontEpoch)!;
            x = placement.x; y = placement.y;
        } else if (node.kind === 'sticky' || node.kind === 'text') scale = node.scale;
        else if (node.kind === 'frame') y = -paint.box.h;
        else if (node.kind === 'embed' || node.kind === 'linkcard') {
            // The poster's text sits at the card's bottom-left, inside the same pad the layout width leaves.
            const pad = cardPosterPad(requestOptions.zoom ?? 1);
            x = pad + posterFaviconInset(node); y = node.h - paint.box.h - pad;
        }
        else if (node.kind === 'connector') {
            x = requestOptions.anchor!.x - paint.box.w / 2;
            y = requestOptions.anchor!.y - paint.box.h / 2;
        }
        return { paint, request, placement: { x, y, scale } };
    };
    return {
        get fonts() { return getFonts(); },
        get layout() { return getLayout(); },
        get faces() { return getLayout().faceTable; },
        prepareNow,
        async prepare(node, requestOptions, signal) {
            check(signal);
            requestOptions = { ...requestOptions, ...(requestOptions.anchor ? { anchor: { ...requestOptions.anchor } } : {}) };
            const request = makeRequest(node, requestOptions);
            if (!request) return null;
            await getLayout().prepare(request);
            check(signal);
            await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
            check(signal);
            // Font loads can finish during the wait; use their actual current epoch and faces.
            return prepareNow(node, requestOptions);
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
