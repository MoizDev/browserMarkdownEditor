import { GENERATED, LINE_HYPHEN, OUTSIDE, boxAt, character, differentLine, strongRtl, validBox } from './types';
import type { FigureTag, LineTable, RawPageText } from './types';

/** Canonical-order line runs and page-space unions; no engine or DOM objects. */
export function buildLines(raw: RawPageText, charU16: Uint32Array): LineTable {
    const lines: number[] = [], boxes: number[] = [], dirs: number[] = [], bidi: number[] = [], clusters: number[] = [];
    const headingLevels = new Map<number, 1 | 2 | 3 | 4 | 5 | 6>();
    const roles = new Map<number, number>();
    raw.struct?.mcids.forEach((id, i) => roles.set(id, raw.struct!.roles[i]));
    let first = 0, box: number[] | undefined, firstInk = -1, lastInk = -1, base: number | undefined, heading: 1 | 2 | 3 | 4 | 5 | 6 | undefined;
    let clusterFirst = -1, clusterBox: readonly number[] | undefined, clusterCount = 0;
    const finishCluster = () => { if (clusterCount > 1 && clusterFirst >= 0) clusters.push(clusterFirst); clusterFirst = -1; clusterCount = 0; clusterBox = undefined; };
    const finish = (end: number) => {
        finishCluster();
        if (end <= first || !box || firstInk < 0) { first = end; box = undefined; firstInk = lastInk = -1; base = undefined; heading = undefined; return; }
        let dx = raw.origin[lastInk * 2] - raw.origin[firstInk * 2], dy = raw.origin[lastInk * 2 + 1] - raw.origin[firstInk * 2 + 1];
        if (Math.hypot(dx, dy) < 1e-6) { dx = raw.matrix[firstInk * 4] || 1; dy = raw.matrix[firstInk * 4 + 1] || 0; }
        const length = Math.hypot(dx, dy) || 1;
        const line = lines.length / 2;
        lines.push(first, end); boxes.push(...box); dirs.push(dx / length, dy / length); bidi.push(base ?? 0);
        if (heading) headingLevels.set(line, heading);
        first = end; box = undefined; firstInk = lastInk = -1; base = undefined; heading = undefined;
    };
    for (let i = 0; i < raw.n; i++) {
        const cp = raw.codepoints[i], flags = raw.flags[i];
        if ((flags & GENERATED) && (cp === 10 || cp === 13)) { finish(i); first = i + 1; continue; }
        const r = boxAt(raw, i), ink = !(flags & OUTSIDE) && validBox(r);
        if (ink && box && lastInk >= 0 && differentLine(raw, lastInk, i)) finish(i);
        if (ink) {
            if (!box) box = [...r];
            else { box[0] = Math.min(box[0], r[0]); box[1] = Math.min(box[1], r[1]); box[2] = Math.max(box[2], r[2]); box[3] = Math.max(box[3], r[3]); }
            if (firstInk < 0) firstInk = i;
            lastInk = i;
            if (clusterBox && clusterBox.every((v, n) => v === r[n])) clusterCount++;
            else { finishCluster(); clusterFirst = i; clusterCount = 1; clusterBox = r; }
        } else if (clusterCount) clusterCount++;
        if (base === undefined && /\p{Letter}/u.test(character(cp))) base = strongRtl(cp) ? 1 : 0;
        const object = raw.object[i], mcid = object >= 0 ? raw.objects.mcid[object] : -1, role = roles.get(mcid);
        if (!heading && role !== undefined && role >= 4 && role <= 10) heading = (role === 4 ? 2 : role - 4) as 1 | 2 | 3 | 4 | 5 | 6;
        if (flags & LINE_HYPHEN) finish(i + 1);
    }
    finish(raw.n);

    const figures: FigureTag[] = [];
    for (const [mcid, alt] of raw.struct?.alt ?? []) {
        if (roles.get(mcid) !== 11 || !alt) continue;
        const tagged = raw.struct?.figures?.find(figure => figure.mcid === mcid);
        let bounds: number[] | undefined = tagged && validBox(tagged.box) ? [...tagged.box] : undefined;
        let anchor = tagged?.charIndex;
        if (!bounds) for (let i = 0; i < raw.n; i++) {
            const object = raw.object[i];
            if (object < 0 || raw.objects.mcid[object] !== mcid || (raw.flags[i] & OUTSIDE)) continue;
            const r = boxAt(raw, i);
            if (!validBox(r)) continue;
            if (anchor === undefined) anchor = i;
            if (!bounds) bounds = [...r];
            else { bounds[0] = Math.min(bounds[0], r[0]); bounds[1] = Math.min(bounds[1], r[1]); bounds[2] = Math.max(bounds[2], r[2]); bounds[3] = Math.max(bounds[3], r[3]); }
        }
        if (!bounds) continue;
        const index = Math.max(0, Math.min(raw.n, anchor ?? 0));
        figures.push({ box: { x: bounds[0], y: bounds[1], width: bounds[2] - bounds[0], height: bounds[3] - bounds[1] }, alt, offset: charU16[index] });
    }
    figures.sort((a, b) => a.offset - b.offset);
    return { lines: Uint32Array.from(lines), lineBox: Float32Array.from(boxes), lineDir: Float32Array.from(dirs),
        lineBidi: Uint8Array.from(bidi), clusters: Uint32Array.from(clusters), headingLevels, figures };
}
