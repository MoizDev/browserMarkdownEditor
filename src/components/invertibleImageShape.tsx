// Press `i` to invert a picture you dropped on a canvas.
//
// WHAT IT IS FOR. Screenshots taken out of a dark-themed app land on a ruled
// notebook page or a whiteboard as a black rectangle — the one thing on the page
// that is not on paper. The alternative was flipping the SOURCE document to
// light mode before every screenshot, so this is the cheaper half of the trade:
// bring it over as it is, select it, press `i`.
//
// WHERE THE FLAG LIVES: `shape.meta.inverted`. Meta is part of the shape record,
// so it rides along in the document snapshot every canvas file already saves —
// an inverted screenshot is still inverted after a reload, and a notebook's PDF
// export (which goes through `toSvg`) prints what the screen showed. Nothing
// touches the image ASSET: the same picture inserted twice can be inverted in
// one place and not the other, and undo puts it back.
//
// WHY A FORK RATHER THAN CSS. The shape's wrapper carries `data-shape-type` but
// nothing this app can key a rule on per shape, and tldraw renders the <img>
// itself — so the one seam is ImageShapeUtil's own `component`/`toSvg`, wrapped
// here. Both delegate to tldraw and add a filter only when the flag is set, so a
// plain image keeps tldraw's exact rendering and an upgrade has one branch to
// carry, not a renderer (the same arrangement as tightDrawShape.tsx).

import { ImageShapeUtil, type Editor, type SvgExportContext, type TLImageShape, type TLShape } from 'tldraw';

/** The same filter the inverted PDF pages use (see --pdf-invert in index.css):
 *  a straight channel inversion, then the hue turned back so blues stay blue
 *  instead of coming out orange. */
const INVERT_FILTER = 'invert(1) hue-rotate(180deg)';

export function isImageInverted(shape: TLShape): boolean {
    return shape.meta?.inverted === true;
}

export class InvertibleImageShapeUtil extends ImageShapeUtil {
    override component(shape: TLImageShape) {
        const image = super.component(shape);
        if (!isImageInverted(shape)) return image;
        // A plain static div: tldraw's own container inside it is absolutely
        // positioned against the shape's wrapper, which this does not become a
        // containing block for, so the picture is placed and sized exactly as
        // before and only its pixels change. GPU-composited, so an inverted
        // image costs no more to pan or zoom than any other.
        return <div style={{ filter: INVERT_FILTER }}>{image}</div>;
    }

    override async toSvg(shape: TLImageShape, ctx: SvgExportContext) {
        const image = await super.toSvg(shape, ctx);
        if (!image || !isImageInverted(shape)) return image;
        return <g style={{ filter: INVERT_FILTER }}>{image}</g>;
    }
}

/**
 * Invert (or un-invert) whichever images are selected.
 *
 * All-or-nothing across the selection: if any selected image is still normal the
 * press inverts them all, so a second press on the same selection always undoes
 * the first rather than flipping a mixed set back and forth. One history
 * stopping point, so ⌘Z takes the whole press back.
 *
 * Returns false when there was nothing to do, which is what lets the caller hand
 * the key back to tldraw.
 */
export function invertSelectedImages(editor: Editor): boolean {
    const images = editor.getSelectedShapes().filter((s): s is TLImageShape => s.type === 'image');
    if (images.length === 0) return false;
    const inverted = !images.every(isImageInverted);
    editor.markHistoryStoppingPoint('invert images');
    editor.updateShapes(images.map(shape => ({
        id: shape.id,
        type: shape.type,
        meta: { ...shape.meta, inverted },
    })));
    return true;
}

/**
 * Bind `i` on `editor`'s container. Returns a disposer.
 *
 * Capture phase on the canvas's own container, not the window: a second canvas
 * in the next column must not answer for this one's selection, and tldraw's
 * keyboard handling sits below this. Cancelled only when an image actually got
 * inverted — with nothing selected `i` stays whatever tldraw makes of it.
 *
 * `i` with no modifier, and never while a text shape is being edited or a tldraw
 * input has the keyboard: there it is a letter someone is typing.
 */
export function bindImageInvertKey(editor: Editor): () => void {
    const container = editor.getContainer();
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== 'i' || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
        if (editor.getEditingShapeId()) return;
        const target = e.target as HTMLElement | null;
        if (target?.isContentEditable || target?.closest('input, textarea, select')) return;
        if (!invertSelectedImages(editor)) return;
        e.preventDefault();
        e.stopPropagation();
    };
    container.addEventListener('keydown', onKeyDown, true);
    return () => container.removeEventListener('keydown', onKeyDown, true);
}
