import type { PathCommand } from '../../platform/types';
import type { WorkerContext } from '../../platform/workers';
import { outlineFontUrl } from './outlineFonts';
import { awaitOutlineResource } from './outlineAbort';
import type { Face, PaintFragment } from './paint';

type HarfBuzzFont = import('harfbuzzjs').Font;
type GlyphPath = ReturnType<HarfBuzzFont['glyphToJson']>;
interface FontEntry { readonly font: HarfBuzzFont; readonly paths: Map<number, { path: GlyphPath; bytes: number }>; bytes: number }
interface FontSlot { promise: Promise<FontEntry>; readonly controller: AbortController; waiters: number; settled: boolean }
const loaded = new Map<string, FontSlot>();
const GLYPH_CACHE_BYTES = 512 * 1024;
const COMMAND_CHUNK = 1024;

export interface PreparedTextOutline {
    commands(): AsyncGenerator<readonly PathCommand[]>;
}

export function clearOutlineGlyphCaches(): void {
    for (const slot of loaded.values()) void slot.promise.then(entry => { entry.paths.clear(); entry.bytes = 0; }).catch(() => undefined);
}

async function outlineFont(face: Face, signal: AbortSignal): Promise<FontEntry> {
    signal.throwIfAborted();
    const url = outlineFontUrl(face.key);
    let slot = loaded.get(url);
    if (!slot) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(new DOMException('Export font deadline exceeded', 'TimeoutError')), 30_000);
        let created!: FontSlot;
        const promise = Promise.all([import('harfbuzzjs'), fetch(url, { signal: controller.signal })]).then(async ([hb, response]) => {
            if (!response.ok) throw new Error('Export font could not be loaded');
            const bytes = await response.arrayBuffer(), source = new hb.Face(new hb.Blob(bytes));
            const font = new hb.Font(source);
            font.setScale(source.upem, source.upem);
            return { font, paths: new Map(), bytes: 0 };
        }).then(entry => { created.settled = true; return entry; }).catch(error => {
            if (loaded.get(url) === created) loaded.delete(url);
            throw error;
        }).finally(() => clearTimeout(timer));
        created = { controller, waiters: 0, settled: false, promise };
        loaded.set(url, created); slot = created;
    }
    slot.waiters++;
    try { return await awaitOutlineResource(slot.promise, signal); }
    finally {
        slot.waiters--;
        if (!slot.waiters && !slot.settled && loaded.get(url) === slot) { loaded.delete(url); slot.controller.abort(); }
    }
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
function current(context: WorkerContext): void {
    context.signal.throwIfAborted();
    if (context.cancelled) throw new DOMException('Text export cancelled', 'AbortError');
}
function validGlyphPath(path: GlyphPath): boolean {
    for (const part of path) {
        const count = part.type === 'M' || part.type === 'L' ? 2 : part.type === 'Q' ? 4 : part.type === 'C' ? 6 : part.type === 'Z' ? 0 : -1;
        if (count < 0 || part.values.length !== count || !part.values.every(Number.isFinite)) return false;
    }
    return true;
}

/** Validate the whole fragment before exposing a path, so fallback never follows partial vector output. */
export async function prepareTextOutline(fragment: PaintFragment, face: Face, baseline: number,
    context: WorkerContext): Promise<PreparedTextOutline | null> {
    current(context);
    if (fragment.systemFallback || !face.loaded) return null;
    try {
        const [hb, entry] = await Promise.all([import('harfbuzzjs'), outlineFont(face, context.signal)]);
        current(context);
        const buffer = new hb.Buffer();
        buffer.addText(fragment.text); buffer.guessSegmentProperties();
        buffer.setDirection(fragment.rtl ? hb.Direction.RTL : hb.Direction.LTR);
        hb.shape(entry.font, buffer);
        const infos = buffer.getGlyphInfos(), positions = buffer.getGlyphPositions(), upem = entry.font.face.upem;
        if (!Number.isFinite(upem) || upem <= 0 || infos.length !== positions.length || infos.length > fragment.text.length * 8 + 1024) return null;
        let advance = 0, glyphCommands = 0;
        for (let i = 0; i < infos.length; i++) {
            const info = infos[i], position = positions[i];
            if (!Number.isSafeInteger(info.codepoint) || info.codepoint <= 0 || !Number.isFinite(position.xAdvance)
                || !Number.isFinite(position.yAdvance) || !Number.isFinite(position.xOffset) || !Number.isFinite(position.yOffset)) return null;
            advance += position.xAdvance;
            if ((i & 1023) === 1023) { current(context); await context.slice(); }
        }
        if (!Number.isFinite(advance) || Math.abs(advance * 64 / upem - fragment.width * 64 / face.size) > 0.05) return null;
        for (let i = 0; i < infos.length; i++) {
            current(context);
            const path = glyphPath(entry, infos[i].codepoint);
            if (!validGlyphPath(path)) return null;
            glyphCommands += path.length;
            if ((i & 127) === 127) await context.slice();
        }
        if (!glyphCommands && /\S/u.test(fragment.text)) return null;
        current(context);
        const factor = face.size / upem;
        return {
            async *commands(): AsyncGenerator<readonly PathCommand[]> {
                let commands: PathCommand[] = [], x = fragment.x, y = baseline;
                for (let i = 0; i < infos.length; i++) {
                    current(context);
                    const position = positions[i], originX = x + position.xOffset * factor, originY = y - position.yOffset * factor;
                    let px = 0, py = 0, startX = 0, startY = 0;
                    for (const part of glyphPath(entry, infos[i].codepoint)) {
                        const v = part.values, type = part.type;
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
                        if (commands.length >= COMMAND_CHUNK) {
                            yield commands;
                            commands = [];
                            current(context);
                            await context.slice();
                        }
                    }
                    x += position.xAdvance * factor; y -= position.yAdvance * factor;
                    if ((i & 127) === 127) await context.slice();
                }
                current(context);
                if (commands.length) yield commands;
            },
        };
    } catch {
        current(context);
        return null;
    }
}

/** Legacy consumers receive one path; streaming sinks can consume the same path in bounded chunks. */
export async function shapeTextFragment(fragment: PaintFragment, face: Face, baseline: number, context: WorkerContext): Promise<PathCommand[] | null> {
    const prepared = await prepareTextOutline(fragment, face, baseline, context);
    if (!prepared) return null;
    const commands: PathCommand[] = [];
    for await (const chunk of prepared.commands()) commands.push(...chunk);
    return commands;
}
