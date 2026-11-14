import { emphasisRanges } from '../../utils/readingEmphasis';
import type { RawPageText } from '../engine/types';
import { GENERATED, INVISIBLE, LINE_HYPHEN, OUTSIDE, UNICODE_ERROR, character, differentLine, strongRtl } from '../text/types';
import { emphasisGlyphCell } from './cell';
import { EmphasisInkIndex } from './collision';
import type { EmphasisCell, EmphasisPoint } from './composite';

export interface EmphasisPlan {
    candidates: number;
    eligibleGlyphs: number;
    objectIndexes: Int32Array;
    cells: EmphasisCell[];
}
interface GlyphCluster { first: number; end: number; token: number; ambiguous: boolean }
interface Candidate { token: number; glyphs: number[]; objects: number[]; cells: EmphasisCell[] }

/** Plan from worker-owned metadata. Text here is a policy projection only; canonical text is unchanged. */
export function buildEmphasisPlan(raw: RawPageText, options: { locale: string; deviceScale: number }): EmphasisPlan {
    const n = raw.n, obj = raw.objects, objectCount = obj.renderMode.length;
    if (!Number.isSafeInteger(n) || n < 0 || n > 200_000 || raw.truncated ||
        raw.codepoints.length !== n || raw.flags.length !== n || raw.object.length !== n ||
        raw.origin.length !== 2 * n || raw.tight.length !== 4 * n || raw.loose.length !== 4 * n ||
        raw.matrix.length !== 4 * n || raw.textMatrix.length !== 6 * n || raw.fontSize.length !== n ||
        obj.fill.length !== objectCount || obj.font.length !== objectCount || obj.mcid.length !== objectCount ||
        obj.sourceFontSize.length !== objectCount || obj.opacity.length !== objectCount || obj.hasTransparency.length !== objectCount ||
        raw.fontAscent.length !== raw.fontNames.length || raw.fontDescent.length !== raw.fontNames.length ||
        !Number.isFinite(options.deviceScale) || options.deviceScale <= 0) throw new RangeError('Incomplete emphasis metadata');

    const offsets = new Uint32Array(n + 1), tokens = new Int32Array(n).fill(-1), breaks: number[] = [];
    const parts: string[] = [];
    let length = 0, token = -1, inToken = false, previous = -1;
    for (let i = 0; i < n; i++) {
        const flags = raw.flags[i], cp = raw.codepoints[i];
        const text = flags & LINE_HYPHEN ? '-' : character(cp);
        const boundary = previous >= 0 && differentLine(raw, previous, i);
        if (boundary || (flags & GENERATED)) { breaks.push(length); inToken = false; }
        offsets[i] = length;
        parts.push(text); length += text.length;
        if (/\s/u.test(text)) inToken = false;
        else {
            if (!inToken) { token++; inToken = true; }
            tokens[i] = token;
        }
        if (flags & (GENERATED | LINE_HYPHEN)) { breaks.push(length); inToken = false; previous = -1; }
        else previous = i;
    }
    offsets[n] = length;
    const text = parts.join('');
    const ranges = emphasisRanges({ text, locale: options.locale, exclusions: [], tokenBreaks: breaks });
    const selection = new Uint8Array(n);
    let rangeIndex = 0;
    for (let i = 0; i < n; i++) {
        while (rangeIndex < ranges.length && ranges[rangeIndex].to <= offsets[i]) rangeIndex++;
        const range = ranges[rangeIndex];
        if (range && range.from < offsets[i + 1] && range.to > offsets[i]) {
            selection[i] = range.from <= offsets[i] && range.to >= offsets[i + 1] ? 1 : 2;
        }
    }
    if (!ranges.length) return { candidates: 0, eligibleGlyphs: 0, objectIndexes: new Int32Array(), cells: [] };

    const finiteBox = (i: number): boolean => {
        const p = i * 4, b = raw.tight;
        return [b[p], b[p + 1], b[p + 2], b[p + 3]].every(Number.isFinite) && b[p + 2] > b[p] && b[p + 3] > b[p + 1];
    };
    const near = (a: number, b: number): boolean => Number.isFinite(a) && Number.isFinite(b) &&
        Math.abs(a - b) <= Math.max(1e-4, 1e-6 * Math.max(Math.abs(a), Math.abs(b)));
    const related = (a: number, b: number): boolean => {
        const sameOrigin = near(raw.origin[a * 2], raw.origin[b * 2]) && near(raw.origin[a * 2 + 1], raw.origin[b * 2 + 1]);
        const sameBox = finiteBox(a) && finiteBox(b) && [0, 1, 2, 3].every(k => near(raw.tight[a * 4 + k], raw.tight[b * 4 + k]));
        return sameOrigin || sameBox;
    };
    const compatible = (a: number, b: number): boolean => raw.object[a] === raw.object[b] &&
        [0, 1, 2, 3].every(k => near(raw.textMatrix[a * 6 + k], raw.textMatrix[b * 6 + k]));
    const clusters: GlyphCluster[] = [];
    for (let i = 0; i < n;) {
        let end = i + 1, ambiguous = false;
        if (!(raw.flags[i] & GENERATED)) while (end < n && tokens[end] === tokens[i] &&
            !(raw.flags[end] & GENERATED) && related(end - 1, end)) {
            if (!compatible(i, end)) ambiguous = true;
            if (finiteBox(end - 1) && finiteBox(end)) {
                const a = (end - 1) * 4, b = end * 4;
                if (raw.tight[a + 2] < raw.tight[b] || raw.tight[b + 2] < raw.tight[a] ||
                    raw.tight[a + 3] < raw.tight[b + 1] || raw.tight[b + 3] < raw.tight[a + 1]) ambiguous = true;
            }
            end++;
        }
        clusters.push({ first: i, end, token: tokens[i], ambiguous });
        i = end;
    }
    const ink = [];
    for (let i = 0; i < n; i++) {
        if (raw.flags[i] & GENERATED) continue;
        if (!finiteBox(i)) continue;
        const k = i * 4, object = raw.object[i], size = obj.sourceFontSize[object];
        const m = i * 6, scale = Math.max(Math.hypot(raw.textMatrix[m], raw.textMatrix[m + 1]), Math.hypot(raw.textMatrix[m + 2], raw.textMatrix[m + 3]));
        ink.push({ glyph: i, box: { x: raw.tight[k], y: raw.tight[k + 1], width: raw.tight[k + 2] - raw.tight[k], height: raw.tight[k + 3] - raw.tight[k + 1] },
            strokeRadius: Number.isFinite(size * scale) && size > 0 ? size * scale * 0.035 / 2 : 0 });
    }
    const index = new EmphasisInkIndex(ink, options.deviceScale);
    const byToken = new Map<number, Candidate>(), rejected = new Set<number>();
    for (let i = 0; i < n; i++) {
        const t = tokens[i];
        if (t < 0) continue;
        const cp = raw.codepoints[i];
        if (raw.flags[i] & (INVISIBLE | UNICODE_ERROR | OUTSIDE) || cp === 0 || cp > 0x10ffff ||
            (cp >= 0xd800 && cp <= 0xdfff) || strongRtl(cp)) rejected.add(t);
        if (i === 0 || tokens[i - 1] !== t || related(i - 1, i)) continue;
        const p = (i - 1) * 6, object = raw.object[i - 1], size = obj.sourceFontSize[object];
        const a = raw.textMatrix[p] * size, b = raw.textMatrix[p + 1] * size;
        const c = raw.textMatrix[p + 2] * size, d = raw.textMatrix[p + 3] * size, det = a * d - b * c;
        const dx = raw.origin[i * 2] - raw.origin[(i - 1) * 2], dy = raw.origin[i * 2 + 1] - raw.origin[(i - 1) * 2 + 1];
        const along = (d * dx - c * dy) / det, across = (-b * dx + a * dy) / det;
        if (!Number.isFinite(along) || along <= 0 || !Number.isFinite(across) || Math.abs(across) > 0.2) rejected.add(t);
    }
    for (const cluster of clusters) {
        const { first, end } = cluster;
        const selected = selection.subarray(first, end);
        if (!selected.some(Boolean)) continue;
        const t = cluster.token, object = raw.object[first], font = obj.font[object], size = obj.sourceFontSize[object];
        if (t < 0 || cluster.ambiguous || selected.some(v => v !== 1) || object < 0 || object >= objectCount ||
            !Number.isInteger(font) || font >= raw.fontNames.length || !Number.isFinite(size) || size <= 0 ||
            obj.renderMode[object] !== 0 || (obj.fill[object] & 255) !== 255 || obj.opacity[object] !== 1 || obj.hasTransparency[object] !== 0 ||
            !finiteBox(first) || Array.from({ length: end - first }, (_, k) => raw.flags[first + k]).some(flags => flags & (GENERATED | INVISIBLE | UNICODE_ERROR | OUTSIDE))) {
            rejected.add(t); continue;
        }
        const m = first * 6, origin = { x: raw.origin[first * 2], y: raw.origin[first * 2 + 1] };
        const basis: [number, number, number, number] = [raw.textMatrix[m] * size, raw.textMatrix[m + 1] * size,
            raw.textMatrix[m + 2] * size, raw.textMatrix[m + 3] * size];
        const k = first * 4, box = raw.tight;
        const corners: EmphasisPoint[] = [{ x: box[k], y: box[k + 1] }, { x: box[k + 2], y: box[k + 1] },
            { x: box[k + 2], y: box[k + 3] }, { x: box[k], y: box[k + 3] }];
        const next = end < n && tokens[end] === t && !(raw.flags[end] & GENERATED) && compatible(first, end)
            ? { x: raw.origin[end * 2], y: raw.origin[end * 2 + 1] } : null;
        const cell = emphasisGlyphCell({ origin, basis, ascent: raw.fontAscent[font], descent: raw.fontDescent[font] }, next, corners);
        if (!cell) { rejected.add(t); continue; }
        let candidate = byToken.get(t);
        if (!candidate) { candidate = { token: t, glyphs: [], objects: [], cells: [] }; byToken.set(t, candidate); }
        for (let i = first; i < end; i++) candidate.glyphs.push(i);
        candidate.objects.push(object); candidate.cells.push(cell);
    }
    let active = [...byToken.values()].filter(candidate => !rejected.has(candidate.token));
    const unknownObjects = new Set<number>();
    for (let i = 0; i < n; i++) {
        if (!(raw.flags[i] & GENERATED) && !/\s/u.test(character(raw.codepoints[i])) && !finiteBox(i)) unknownObjects.add(raw.object[i]);
    }
    active = active.filter(candidate => !candidate.objects.some(object => unknownObjects.has(object)));
    // A rejected object's stroked suffix is no longer selected. Recheck until removal cannot expose one.
    for (let pass = 0; pass < 16; pass++) {
        const selected = new Set(active.flatMap(candidate => candidate.glyphs));
        const remaining = active.filter(candidate => !candidate.cells.some(cell => index.overlaps(cell, selected)));
        if (remaining.length === active.length) break;
        active = remaining;
        if (pass === 15) throw new RangeError('Emphasis collision plan did not settle');
    }
    return { candidates: ranges.length, eligibleGlyphs: active.reduce((sum, candidate) => sum + candidate.cells.length, 0),
        objectIndexes: Int32Array.from(new Set(active.flatMap(candidate => candidate.objects))),
        cells: active.flatMap(candidate => candidate.cells) };
}
