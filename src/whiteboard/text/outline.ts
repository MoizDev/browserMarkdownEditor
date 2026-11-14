import type { PageDisplayItem, Rgba } from '../../platform/types';
import type { WorkerContext } from '../../platform/workers';
import { BoardFonts } from './fonts';
import type { PaintRect } from './paint';
import type { OutlineWorkerRequest } from './outlineTypes';
import { handleOutlineStream, isOutlineStreamRequest } from './outlineStream';
import type { OutlineStreamReply } from './outlineStream';
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
    if (!await validOutlineRequest(payload, context)) throw new RangeError('Invalid text export request or face generation');
    context.signal.throwIfAborted();
    if (context.cancelled) throw new DOMException('Text export cancelled', 'AbortError');
    const { paint, faces, material, pageScale, localToWorld } = payload as OutlineWorkerRequest;
    activeStreams++;
    try {
        for (let i = 0; i < paint.backgrounds.length; i++) {
            context.signal.throwIfAborted();
            if (context.cancelled) throw new DOMException('Text export cancelled', 'AbortError');
            yield box(paint.backgrounds[i], material.backgrounds[i], material.blend);
            if ((i & 255) === 255) { context.signal.throwIfAborted(); await context.slice(); }
        }
        let colorIndex = 0, lineCount = 0;
        for (const line of paint.lines) {
            if ((++lineCount & 1023) === 0) await context.slice();
            for (const fragment of line.fragments) {
                context.signal.throwIfAborted();
                if (context.cancelled) throw new DOMException('Text export cancelled', 'AbortError');
                const face = faces.faces[fragment.face], color = material.glyphs[colorIndex++];
                if (!fragment.text) { if ((colorIndex & 1023) === 0) await context.slice(); continue; }
                const commands = await shapeTextFragment(fragment, face, line.baseline, context);
                if (commands !== null) yield { kind: 'path', d: commands, fill: color, blend: material.blend };
                else yield* rasterTextFragment(fragment, face, line.baseline, line.top, line.bottom, localToWorld, color, pageScale, material.blend, fonts, context);
                await context.slice();
            }
        }
        for (let i = 0; i < paint.decorations.length; i++) {
            context.signal.throwIfAborted();
            if (context.cancelled) throw new DOMException('Text export cancelled', 'AbortError');
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
export async function textOutline(payload: unknown, context: WorkerContext): Promise<PageDisplayItem[] | OutlineStreamReply> {
    if (isOutlineStreamRequest(payload)) return handleOutlineStream(payload, context, streamTextOutline);
    const items: PageDisplayItem[] = [];
    for await (const item of streamTextOutline(payload, context)) items.push(item);
    return items;
}
