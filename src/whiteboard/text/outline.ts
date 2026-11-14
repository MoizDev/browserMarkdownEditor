import type { PageDisplayItem, Rgba } from '../../platform/types';
import type { WorkerContext } from '../../platform/workers';
import { BoardFonts } from './fonts';
import type { PaintRect } from './paint';
import { rasterTextFragment } from './outlineRaster';
import { clearOutlineGlyphCaches, shapeTextFragment } from './outlineShape';
import { validOutlineRequest } from './outlineValidation';

const fonts = new BoardFonts((globalThis as unknown as { fonts: FontFaceSet }).fonts);
let activeStreams = 0;
function box(rect: PaintRect, color: Rgba, blend: 'normal' | 'multiply'): PageDisplayItem {
    return { kind: 'path', fill: color, blend, d: [['M', rect.x, rect.y], ['L', rect.x + rect.w, rect.y],
        ['L', rect.x + rect.w, rect.y + rect.h], ['L', rect.x, rect.y + rect.h], ['Z']] };
}

/** The pinned layout owns line breaks and faces; HarfBuzz supplies export glyph outlines only. */
export async function* streamTextOutline(payload: unknown, context: WorkerContext): AsyncGenerator<PageDisplayItem> {
    if (!validOutlineRequest(payload)) throw new RangeError('Invalid text export request or face generation');
    const { paint, faces, material, pageScale } = payload;
    activeStreams++;
    try {
        for (let i = 0; i < paint.backgrounds.length; i++) {
            yield box(paint.backgrounds[i], material.backgrounds[i], material.blend);
            if ((i & 255) === 255) { context.signal.throwIfAborted(); await context.slice(); }
        }
        let colorIndex = 0;
        for (const line of paint.lines) for (const fragment of line.fragments) {
            context.signal.throwIfAborted();
            const face = faces.faces[fragment.face], color = material.glyphs[colorIndex++];
            if (!fragment.text) continue;
            const commands = await shapeTextFragment(fragment, face, line.baseline, context);
            if (commands !== null) yield { kind: 'path', d: commands, fill: color, blend: material.blend };
            else yield* rasterTextFragment(fragment, face, line.baseline, line.top, line.bottom, color, pageScale, material.blend, fonts, context);
            await context.slice();
        }
        for (let i = 0; i < paint.decorations.length; i++) {
            yield box(paint.decorations[i], material.decorations[i], material.blend);
            if ((i & 255) === 255) { context.signal.throwIfAborted(); await context.slice(); }
        }
        context.signal.throwIfAborted();
    } finally {
        activeStreams--;
        if (!activeStreams) clearOutlineGlyphCaches();
    }
}

/** The existing worker protocol collects one text node; streaming consumers can retain only one item. */
export async function textOutline(payload: unknown, context: WorkerContext): Promise<PageDisplayItem[]> {
    const items: PageDisplayItem[] = [];
    for await (const item of streamTextOutline(payload, context)) items.push(item);
    return items;
}
