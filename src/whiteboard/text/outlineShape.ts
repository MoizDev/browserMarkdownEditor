import type { PathCommand } from '../../platform/types';
import type { WorkerContext } from '../../platform/workers';
import { outlineFontUrl } from './outlineFonts';
import type { Face, PaintFragment } from './paint';

type HarfBuzzFont = import('harfbuzzjs').Font;
type GlyphPath = ReturnType<HarfBuzzFont['glyphToJson']>;
interface FontEntry { readonly font: HarfBuzzFont; readonly paths: Map<number, { path: GlyphPath; bytes: number }>; bytes: number }
const loaded = new Map<string, Promise<FontEntry>>();
const GLYPH_CACHE_BYTES = 4 * 1024 * 1024;

async function outlineFont(face: Face): Promise<FontEntry> {
    const url = outlineFontUrl(face.key);
    let pending = loaded.get(url);
    if (!pending) {
        pending = Promise.all([import('harfbuzzjs'), fetch(url)]).then(async ([hb, response]) => {
            if (!response.ok) throw new Error('Export font could not be loaded');
            const bytes = await response.arrayBuffer(), source = new hb.Face(new hb.Blob(bytes));
            const font = new hb.Font(source);
            font.setScale(source.upem, source.upem);
            return { font, paths: new Map(), bytes: 0 };
        });
        loaded.set(url, pending);
        void pending.catch(() => { if (loaded.get(url) === pending) loaded.delete(url); });
    }
    return pending;
}
function glyphPath(entry: FontEntry, id: number): GlyphPath {
    const old = entry.paths.get(id);
    if (old) { entry.paths.delete(id); entry.paths.set(id, old); return old.path; }
    const path = entry.font.glyphToJson(id);
    let bytes = 128;
    for (const command of path) bytes += 80 + command.values.length * 8;
    if (bytes <= GLYPH_CACHE_BYTES) {
        while (entry.paths.size && (entry.paths.size >= 2048 || entry.bytes + bytes > GLYPH_CACHE_BYTES)) {
            const first = entry.paths.keys().next().value!, removed = entry.paths.get(first)!;
            entry.paths.delete(first); entry.bytes -= removed.bytes;
        }
        entry.paths.set(id, { path, bytes }); entry.bytes += bytes;
    }
    return path;
}

/** The captured layout decides lines and faces; shaping may fall back but never reflows the fragment. */
export async function shapeTextFragment(fragment: PaintFragment, face: Face, baseline: number, context: WorkerContext): Promise<PathCommand[] | null> {
    if (fragment.systemFallback || !face.loaded) return null;
    try {
        const [hb, entry] = await Promise.all([import('harfbuzzjs'), outlineFont(face)]);
        context.signal.throwIfAborted();
        const buffer = new hb.Buffer();
        buffer.addText(fragment.text); buffer.guessSegmentProperties();
        buffer.setDirection(fragment.rtl ? hb.Direction.RTL : hb.Direction.LTR);
        hb.shape(entry.font, buffer);
        const infos = buffer.getGlyphInfos(), positions = buffer.getGlyphPositions(), upem = entry.font.face.upem;
        if (!Number.isFinite(upem) || upem <= 0 || infos.length !== positions.length || infos.length > fragment.text.length * 8 + 1024) return null;
        let advance = 0;
        for (let i = 0; i < infos.length; i++) {
            const info = infos[i], position = positions[i];
            if (!Number.isSafeInteger(info.codepoint) || info.codepoint <= 0 || !Number.isFinite(position.xAdvance)
                || !Number.isFinite(position.yAdvance) || !Number.isFinite(position.xOffset) || !Number.isFinite(position.yOffset)) return null;
            advance += position.xAdvance;
        }
        if (!Number.isFinite(advance) || Math.abs(advance * 64 / upem - fragment.width * 64 / face.size) > 0.05) return null;
        const commands: PathCommand[] = [], factor = face.size / upem;
        let x = fragment.x, y = baseline, work = 0;
        for (let i = 0; i < infos.length; i++) {
            context.signal.throwIfAborted();
            const position = positions[i], originX = x + position.xOffset * factor, originY = y - position.yOffset * factor;
            let px = 0, py = 0, startX = 0, startY = 0;
            for (const part of glyphPath(entry, infos[i].codepoint)) {
                const v = part.values, type = part.type;
                const count = type === 'M' || type === 'L' ? 2 : type === 'Q' ? 4 : type === 'C' ? 6 : type === 'Z' ? 0 : -1;
                if (count < 0 || v.length !== count || !v.every(Number.isFinite)) return null;
                const tx = (value: number) => originX + value * factor, ty = (value: number) => originY - value * factor;
                if (type === 'M') { px = tx(v[0]); py = ty(v[1]); startX = px; startY = py; commands.push(['M', px, py]); }
                else if (type === 'L') { px = tx(v[0]); py = ty(v[1]); commands.push(['L', px, py]); }
                else if (type === 'Q') {
                    const qx = tx(v[0]), qy = ty(v[1]), ex = tx(v[2]), ey = ty(v[3]);
                    commands.push(['C', px + 2 * (qx - px) / 3, py + 2 * (qy - py) / 3,
                        ex + 2 * (qx - ex) / 3, ey + 2 * (qy - ey) / 3, ex, ey]); px = ex; py = ey;
                } else if (type === 'C') {
                    px = tx(v[4]); py = ty(v[5]); commands.push(['C', tx(v[0]), ty(v[1]), tx(v[2]), ty(v[3]), px, py]);
                } else { commands.push(['Z']); px = startX; py = startY; }
                if (++work % 1024 === 0) { context.signal.throwIfAborted(); await context.slice(); }
            }
            x += position.xAdvance * factor; y -= position.yAdvance * factor;
            if ((i & 127) === 127) await context.slice();
        }
        context.signal.throwIfAborted();
        return commands.length || !/\S/u.test(fragment.text) ? commands : null;
    } catch {
        context.signal.throwIfAborted();
        return null;
    }
}
