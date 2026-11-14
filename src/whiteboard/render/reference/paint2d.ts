import type { Affine } from '../../../platform/types';
import { colourCss } from '../colour';
import type { PaintItem } from '../paintStream';
import type { PathOrigin2d } from './coverage2d';

/** These resources are pinned by the published frame, never built while drawing. */
export interface PreparedPath2d {
    readonly path: Path2D;
    readonly origin: PathOrigin2d;
}
export interface PaintResources2d {
    path(item: PaintItem): PreparedPath2d;
    clip(key: string): PreparedPath2d;
    image(key: string): CanvasImageSource;
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
            if (src) ctx.drawImage(image, src.x, src.y, src.width, src.height, dst.x, dst.y, dst.width, dst.height);
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
