import type { PdfTextAnchor } from '../types/reading';
import { LINE_HYPHEN, TOKEN_BREAK, matchPage, projectionChunks } from './pdfFind';
import type { PdfFindPageText } from './pdfFind';

export interface PdfTextAnchorResolution { anchor: PdfTextAnchor; exact: boolean }
export interface PdfTextAnchorOptions { sameSchema: boolean; signal?: AbortSignal }
const skeletonUnit = (unit: string) => unit !== ' ' && unit !== TOKEN_BREAK && unit !== LINE_HYPHEN;
const cancelled = () => new DOMException('PDF anchor restoration cancelled', 'AbortError');

/** Shares find's folding, break markers and automaton. Offsets and skeleton
 * ranks are built together; repeated quotes never rescan the page for context. */
export async function resolvePdfTextAnchor(page: PdfFindPageText & { physicalPageIndex: number }, anchor: PdfTextAnchor,
    { sameSchema, signal = new AbortController().signal }: PdfTextAnchorOptions): Promise<PdfTextAnchorResolution> {
    let deadline = performance.now() + 4;
    async function pause() {
        if (signal.aborted) throw cancelled();
        if (performance.now() >= deadline) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            deadline = performance.now() + 4;
            if (signal.aborted) throw cancelled();
        }
    }
    if (signal.aborted) throw cancelled();
    const result = (offset: number, exact: boolean): PdfTextAnchorResolution => ({
        anchor: { ...anchor, physicalPageIndex: page.physicalPageIndex, offsetUTF16: offset }, exact,
    });
    const offset = anchor.offsetUTF16;
    if (sameSchema && anchor.quote && offset >= anchor.before.length &&
        page.text.slice(offset, offset + anchor.quote.length) === anchor.quote &&
        page.text.slice(offset - anchor.before.length, offset) === anchor.before) return { anchor, exact: true };
    function folded(text: string) {
        let key = '', skeleton = '';
        for (const chunk of projectionChunks({ text, tokenBreaks: [], quality: 'available' })) {
            for (const unit of chunk.key) {
                // A v1 line-end hyphen can disappear in v2. Breaks are optional
                // in the page automaton, not mandatory units in a saved quote.
                if (unit !== LINE_HYPHEN && unit !== TOKEN_BREAK) key += unit;
                if (skeletonUnit(unit)) skeleton += unit;
            }
        }
        return { key: key.trim(), skeleton };
    }
    const quote = folded(anchor.quote), before = folded(anchor.before), after = folded(anchor.after);
    if (!quote.skeleton.length) return result(0, true);
    const keys: string[] = [], skeletons: string[] = [], maps: Uint32Array[] = [], ranks: Uint32Array[] = [];
    let length = 0, skeletonLength = 0;
    for (const chunk of projectionChunks(page, 256)) {
        keys.push(chunk.key); maps.push(Uint32Array.from(chunk.offsets));
        const rank = new Uint32Array(chunk.key.length);
        let skeleton = '';
        for (let i = 0; i < chunk.key.length; i++) {
            rank[i] = skeletonLength;
            if (skeletonUnit(chunk.key[i])) { skeleton += chunk.key[i]; skeletonLength++; }
        }
        ranks.push(rank); skeletons.push(skeleton); length += chunk.key.length;
        await pause();
    }
    const map = new Uint32Array(length + 1), rank = new Uint32Array(length + 1);
    let position = 0;
    for (let i = 0; i < maps.length; i++) {
        map.set(maps[i], position); rank.set(ranks[i], position); position += maps[i].length;
        await pause();
    }
    map[length] = page.text.length; rank[length] = skeletonLength;
    const key = keys.join(''), skeleton = skeletons.join('');
    const oldLength = Math.max(anchor.before.length + anchor.quote.length + anchor.after.length,
        offset + anchor.quote.length + anchor.after.length, 1);
    const target = offset * (page.text.length / oldLength);
    const canonicalEnd = (end: number) => {
        const start = map[end - 1];
        while (end < length && map[end] === start) end++;
        return map[end];
    };
    let best: { offset: number; score: number; distance: number } | undefined, count = 0;
    for await (const match of matchPage(key, quote.key, signal, { overlap: true, maxUnits: 512 })) {
        if (++count > 1000) { best = undefined; break; }
        let score = 0;
        for (let n = 1; n <= before.skeleton.length && rank[match.from] >= n; n++) {
            if (skeleton[rank[match.from] - n] !== before.skeleton[before.skeleton.length - n]) break;
            score++;
        }
        for (let n = 0; n < after.skeleton.length && rank[match.to] + n < skeleton.length; n++) {
            if (skeleton[rank[match.to] + n] !== after.skeleton[n]) break;
            score++;
        }
        const candidate = map[match.from], distance = Math.abs(candidate - target);
        if (!best || score > best.score || score === best.score && distance < best.distance) best = { offset: candidate, score, distance };
        await pause();
    }
    if (best) return result(best.offset, true);
    for (const [context, atEnd] of [[before, true], [after, false]] as const) {
        if (!context.skeleton.length) continue;
        let nearest: { offset: number; distance: number } | undefined, occurrences = 0;
        for await (const match of matchPage(key, context.key, signal, { overlap: true, maxUnits: 512 })) {
            if (++occurrences > 1000) break;
            const candidate = atEnd ? canonicalEnd(match.to) : map[match.from], distance = Math.abs(candidate - target);
            if (!nearest || distance < nearest.distance) nearest = { offset: candidate, distance };
            await pause();
        }
        if (nearest) return result(nearest.offset, false);
    }
    return result(0, false);
}
