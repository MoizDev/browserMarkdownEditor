import type { PageDisplayItem, PathCommand, Rgba } from '../../platform/types';
import type { WorkerContext } from '../../platform/workers';
import { BoardFonts } from './fonts';
import { outlineFontUrl } from './outlineFonts';
import type { Face, PaintFragment, PaintRect } from './paint';
import type { OutlineWorkerRequest } from './outlineTypes';

const fonts = new BoardFonts((globalThis as unknown as { fonts: FontFaceSet }).fonts);
const loaded = new Map<string, Promise<import('harfbuzzjs').Font>>();
async function outlineFont(face: Face): Promise<import('harfbuzzjs').Font> {
    const url = outlineFontUrl(face.key);
    let pending = loaded.get(url);
    if (!pending) {
        pending = Promise.all([import('harfbuzzjs'), fetch(url)]).then(async ([hb, response]) => {
            if (!response.ok) throw new Error('Export font could not be loaded');
            const bytes = await response.arrayBuffer();
            const fontFace = new hb.Face(new hb.Blob(bytes));
            const font = new hb.Font(fontFace);
            font.setScale(fontFace.upem, fontFace.upem);
            return font;
        });
        loaded.set(url, pending);
        void pending.catch(() => { if (loaded.get(url) === pending) loaded.delete(url); });
    }
    return pending;
}
function box(rect: PaintRect, color: Rgba, blend: 'normal' | 'multiply'): PageDisplayItem {
    return { kind: 'path', fill: color, blend, d: [['M', rect.x, rect.y], ['L', rect.x + rect.w, rect.y],
        ['L', rect.x + rect.w, rect.y + rect.h], ['L', rect.x, rect.y + rect.h], ['Z']] };
}
function css(color: Rgba): string {
    return `rgba(${color[0] * 255},${color[1] * 255},${color[2] * 255},${color[3]})`;
}
async function raster(fragment: PaintFragment, face: Face, baseline: number, color: Rgba, scale: number,
    blend: 'normal' | 'multiply', signal: AbortSignal): Promise<PageDisplayItem> {
    if (face.loaded) {
        if (!await fonts.load(face.key)) throw new Error('Export canvas font could not be loaded');
    }
    signal.throwIfAborted();
    const probe = new OffscreenCanvas(1, 1), context = probe.getContext('2d');
    if (!context) throw new Error('Export canvas is unavailable');
    context.font = face.css; context.direction = fragment.rtl ? 'rtl' : 'ltr'; context.textAlign = 'left';
    context.textBaseline = 'alphabetic'; context.fontKerning = 'normal'; context.textRendering = 'geometricPrecision';
    context.letterSpacing = '0px'; context.wordSpacing = '0px'; context.fontVariantCaps = 'normal';
    const metrics = context.measureText(fragment.text), factor = face.size / 64;
    const left = fragment.x - Math.max(0, metrics.actualBoundingBoxLeft * factor) - factor * 2;
    const top = baseline - metrics.actualBoundingBoxAscent * factor - factor * 2;
    const width = Math.max(factor, (metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight) * factor + factor * 4);
    const height = Math.max(factor, (metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) * factor + factor * 4);
    const density = 4 * scale, w = Math.max(1, Math.ceil(width * density)), h = Math.max(1, Math.ceil(height * density));
    if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w > 16384 || h > 16384 || w * h > 2 ** 28)
        throw new RangeError('Text fragment is too large to rasterize');
    const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Export canvas is unavailable');
    ctx.scale(density, density); ctx.translate(fragment.x - left, baseline - top); ctx.scale(factor, factor);
    ctx.font = face.css; ctx.direction = fragment.rtl ? 'rtl' : 'ltr'; ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic'; ctx.fontKerning = 'normal'; ctx.textRendering = 'geometricPrecision';
    ctx.letterSpacing = '0px'; ctx.wordSpacing = '0px'; ctx.fontVariantCaps = 'normal';
    ctx.fillStyle = css(color); ctx.fillText(fragment.text, 0, 0);
    const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    signal.throwIfAborted();
    return { kind: 'raster', rect: { x: left, y: top, width: w / density, height: h / density }, png, blend };
}

/** Worker handler: the layout owns line breaks, HarfBuzz owns export glyph shapes only. */
export async function textOutline(payload: unknown, context: WorkerContext): Promise<PageDisplayItem[]> {
    const request = payload as OutlineWorkerRequest;
    if (!request || !Number.isFinite(request.pageScale) || request.pageScale <= 0) throw new RangeError('Invalid text export request');
    const { paint, faces, material, pageScale } = request, items: PageDisplayItem[] = [];
    for (let i = 0; i < paint.backgrounds.length; i++) items.push(box(paint.backgrounds[i], material.backgrounds[i], material.blend));
    let colorIndex = 0;
    for (const line of paint.lines) for (const fragment of line.fragments) {
        context.signal.throwIfAborted();
        const face = faces.faces[fragment.face], color = material.glyphs[colorIndex++];
        if (!face || !color) throw new Error('Missing export text face or colour');
        if (!fragment.text) continue;
        let commands: PathCommand[] | null = null;
        if (!fragment.systemFallback && face.loaded) {
            const [hb, font] = await Promise.all([import('harfbuzzjs'), outlineFont(face).catch(() => null)]);
            context.signal.throwIfAborted();
            if (font) {
            const buffer = new hb.Buffer();
            buffer.addText(fragment.text); buffer.guessSegmentProperties();
            buffer.setDirection(fragment.rtl ? hb.Direction.RTL : hb.Direction.LTR);
            hb.shape(font, buffer);
            const infos = buffer.getGlyphInfos(), positions = buffer.getGlyphPositions(), upem = font.face.upem;
            const sum = positions.reduce((n, position) => n + position.xAdvance, 0);
            if (infos.every(info => info.codepoint !== 0) && Math.abs(sum * 64 / upem - fragment.width * 64 / face.size) <= 0.05) {
                commands = [];
                const factor = face.size / upem;
                let x = fragment.x, y = line.baseline;
                for (let i = 0; i < infos.length; i++) {
                    const position = positions[i], originX = x + position.xOffset * factor, originY = y - position.yOffset * factor;
                    let px = 0, py = 0, startX = 0, startY = 0;
                    for (const part of font.glyphToJson(infos[i].codepoint)) {
                        const v = part.values, type = part.type.toUpperCase();
                        const tx = (value: number) => originX + value * factor, ty = (value: number) => originY - value * factor;
                        if (type === 'M') { px = tx(v[0]); py = ty(v[1]); startX = px; startY = py; commands.push(['M', px, py]); }
                        else if (type === 'L') { px = tx(v[0]); py = ty(v[1]); commands.push(['L', px, py]); }
                        else if (type === 'Q') {
                            const qx = tx(v[0]), qy = ty(v[1]), ex = tx(v[2]), ey = ty(v[3]);
                            commands.push(['C', px + 2 * (qx - px) / 3, py + 2 * (qy - py) / 3,
                                ex + 2 * (qx - ex) / 3, ey + 2 * (qy - ey) / 3, ex, ey]); px = ex; py = ey;
                        } else if (type === 'C') {
                            px = tx(v[4]); py = ty(v[5]); commands.push(['C', tx(v[0]), ty(v[1]), tx(v[2]), ty(v[3]), px, py]);
                        } else if (type === 'Z') { commands.push(['Z']); px = startX; py = startY; }
                        else throw new Error(`Unsupported glyph path: ${part.type}`);
                    }
                    x += position.xAdvance * factor; y -= position.yAdvance * factor;
                }
            }
            }
        }
        if (commands) items.push({ kind: 'path', d: commands, fill: color, blend: material.blend });
        else items.push(await raster(fragment, face, line.baseline, color, pageScale, material.blend, context.signal));
        await context.slice();
    }
    for (let i = 0; i < paint.decorations.length; i++) items.push(box(paint.decorations[i], material.decorations[i], material.blend));
    return items;
}
