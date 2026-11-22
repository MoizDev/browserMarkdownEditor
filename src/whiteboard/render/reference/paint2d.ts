import type { Affine, Rect } from '../../../platform/types';
import { colourCss } from '../colour';
import type { PaintItem } from '../paintStream';
import { IMAGE_SAMPLING_PROFILE, isGutterQuadDraw, texturedQuad, TILE_CROP, TILE_SIZE } from '../imageSampling';
import type { PathOrigin2d } from './coverage2d';

/** These resources are pinned by the published frame, never built while drawing. */
export interface PreparedPath2d {
    readonly path: Path2D;
    readonly origin: PathOrigin2d;
}
export interface PaintResources2d {
    path(item: PaintItem): PreparedPath2d;
    clip(key: string): PreparedPath2d;
    /** Null: the picture could not be decoded; it is drawn as a placeholder (the provider has told the person why). */
    image(key: string): CanvasImageSource | null;
    /** A standin's crop of its bitmap: such a draw has no quad, so its facts are not classified. Absent otherwise. */
    imageCrop?(key: string): Readonly<Rect> | null;
}

export type PaintContext2d = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function applyLocal(ctx: PaintContext2d, base: DOMMatrix, matrix: Affine, origin?: PathOrigin2d): void {
    ctx.setTransform(base);
    ctx.transform(...matrix);
    if (origin) ctx.translate(origin[0], origin[1]);
}

/** The caller has installed the host's world/page projection. Clip paths have their own
 * absolute local-to-world transforms, independent of the item's local transform.
 */
export function paintItem2d(ctx: PaintContext2d, item: PaintItem, resources: PaintResources2d): void {
    ctx.save();
    try {
        const base = ctx.getTransform();
        for (const clip of item.clips) {
            const prepared = resources.clip(clip.key);
            applyLocal(ctx, base, clip.localToWorld, prepared.origin);
            ctx.clip(prepared.path, clip.fillRule);
        }
        ctx.globalAlpha = 1;
        ctx.filter = 'none';
        ctx.globalCompositeOperation = (item.kind === 'image' ? item.blend : item.material.blend) === 'multiply'
            ? 'multiply' : 'source-over';
        if (item.kind === 'image') {
            applyLocal(ctx, base, item.localToWorld);
            ctx.globalAlpha = item.opacity;
            ctx.filter = item.inverted ? 'invert(1) hue-rotate(180deg)' : 'none';
            const image = resources.image(item.imageKey), dst = item.rect, src = item.sourceRect;
            if (!image && item.underlaid) return; // the stand-in under it shows
            if (!image) {
                // A picture that could not be decoded: a neutral box with a hairline frame where it sits, so the board stays usable
                // and the picture can still be selected, moved or deleted. Drawn without the image's filter or opacity.
                ctx.globalAlpha = 1; ctx.filter = 'none';
                ctx.fillStyle = 'rgba(128, 128, 128, 0.18)'; ctx.fillRect(dst.x, dst.y, dst.width, dst.height);
                ctx.strokeStyle = 'rgba(128, 128, 128, 0.7)'; ctx.lineWidth = Math.max(dst.width, dst.height) / 400;
                ctx.strokeRect(dst.x, dst.y, dst.width, dst.height);
                return;
            }
            // The declared sampling profile (imageSampling.ts): bilinear, no mips, on the same texels the GPU reads.
            ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = IMAGE_SAMPLING_PROFILE.quality;
            if (isGutterQuadDraw(item, image)) {
                // The GPU's own quad: the whole texture on its gutter-grown square (texturedQuad is unit-free).
                const quad = texturedQuad(dst, TILE_SIZE, TILE_CROP);
                ctx.drawImage(image, 0, 0, TILE_SIZE, TILE_SIZE, quad.x0, quad.y0, quad.x1 - quad.x0, quad.y1 - quad.y0);
            } else if (src) ctx.drawImage(image, src.x, src.y, src.width, src.height, dst.x, dst.y, dst.width, dst.height);
            else ctx.drawImage(image, dst.x, dst.y, dst.width, dst.height);
        } else if (item.kind === 'text') {
            applyLocal(ctx, base, item.localToWorld);
            for (let i = 0; i < item.paint.backgrounds.length; i++) {
                const rect = item.paint.backgrounds[i];
                ctx.fillStyle = colourCss(item.material.backgrounds[i]);
                ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
            }
            let colour = 0;
            for (const line of item.paint.lines) for (const fragment of line.fragments) {
                const face = item.faces.faces[fragment.face];
                ctx.font = face.css; ctx.direction = fragment.rtl ? 'rtl' : 'ltr'; ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic'; ctx.fontKerning = 'normal'; ctx.textRendering = 'geometricPrecision';
                ctx.letterSpacing = '0px'; ctx.wordSpacing = '0px'; ctx.fontVariantCaps = 'normal';
                ctx.fillStyle = colourCss(item.material.glyphs[colour++]);
                ctx.save();
                ctx.translate(fragment.x, line.baseline);
                ctx.scale(face.size / 64, face.size / 64);
                ctx.fillText(fragment.text, 0, 0);
                ctx.restore();
            }
            for (let i = 0; i < item.paint.decorations.length; i++) {
                const rect = item.paint.decorations[i];
                ctx.fillStyle = colourCss(item.material.decorations[i]);
                ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
            }
        } else {
            const prepared = resources.path(item);
            applyLocal(ctx, base, item.localToWorld, prepared.origin);
            if (item.kind === 'ink') {
                ctx.fillStyle = colourCss(item.material.color);
                ctx.fill(prepared.path, 'nonzero');
            } else {
                const { fill, stroke } = item.material;
                if (fill) { ctx.fillStyle = colourCss(fill); ctx.fill(prepared.path, item.fillRule); }
                if (stroke && stroke.width > 0) {
                    ctx.strokeStyle = colourCss(stroke.color);
                    ctx.lineWidth = stroke.width;
                    ctx.lineCap = stroke.cap;
                    ctx.lineJoin = stroke.join;
                    ctx.miterLimit = stroke.miterLimit;
                    ctx.setLineDash(stroke.dash ? [...stroke.dash.array] : []);
                    ctx.lineDashOffset = stroke.dash?.phase ?? 0;
                    ctx.stroke(prepared.path);
                }
            }
        }
    } finally {
        ctx.restore();
    }
}
