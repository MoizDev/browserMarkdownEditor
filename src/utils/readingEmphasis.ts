/** Optional visual heuristic, not a reading-speed or language-support claim.
 * Coordinates always refer to the original, unnormalised UTF-16 string. */
export const EMPHASIS_ALGORITHM = 'latin-prefix-v1' as const;
export interface Utf16Range { from: number; to: number }
export interface EmphasisRun {
    text: string;
    locale?: string;
    exclusions: readonly Utf16Range[];
    tokenBreaks?: readonly number[];
}
export interface SourceFragment { runFrom: number; runTo: number; sourceFrom: number; sourceTo: number }

const EMPTY: readonly Utf16Range[] = Object.freeze([]);
const LATIN = /^\p{Script=Latin}$/u;
const LETTER = /^\p{Letter}$/u;
const MARK = /^\p{Mark}$/u;
const INHERITED = /^\p{Script=Inherited}$/u;
const JOIN = /^[’']$/u;
// Technical tokens are protected BEFORE word segmentation; otherwise ICU turns
// a URL/identifier into plausible English words and decorates their fragments.
// eslint-disable-next-line no-misleading-character-class -- explicit format/variation code points are WHOLE-token exclusions, never grapheme splitting.
const PROTECTED = /(?:[a-z][a-z\d+.-]*:|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,}|@|[\\/_`<>]|\p{Number}|[\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]|[\u{e0100}-\u{e01ef}])/iu;
const segmenters = new Map<string, { word: Intl.Segmenter; grapheme: Intl.Segmenter }>();

function getSegmenters(locale?: string): { word: Intl.Segmenter; grapheme: Intl.Segmenter } | null {
    if (typeof Intl.Segmenter !== 'function') return null;
    let language: string | undefined;
    try { language = locale ? Intl.getCanonicalLocales(locale)[0] : undefined; } catch { /* browser default */ }
    const key = language ?? '';
    const cached = segmenters.get(key);
    if (cached) return cached;
    try {
        const pair = {
            word: new Intl.Segmenter(language, { granularity: 'word' }),
            grapheme: new Intl.Segmenter(language, { granularity: 'grapheme' }),
        };
        if (segmenters.size >= 16) segmenters.delete(segmenters.keys().next().value!);
        segmenters.set(key, pair);
        return pair;
    } catch { return null; }
}

function latinCluster(cluster: string): boolean {
    let first = true;
    for (const char of cluster) {
        if (first) {
            if (!LETTER.test(char) || !LATIN.test(char)) return false;
            first = false;
        } else if (!MARK.test(char) || !(INHERITED.test(char) || LATIN.test(char))) return false;
    }
    return !first;
}

/** All input ranges are half open. Invalid exclusions fail closed. */
export function emphasisRanges(run: EmphasisRun): readonly Utf16Range[] {
    const { text } = run;
    if (!text || run.exclusions.some(r => !Number.isSafeInteger(r.from) || !Number.isSafeInteger(r.to)
        || r.from < 0 || r.to < r.from || r.to > text.length)) return EMPTY;
    const breaks = [...new Set(run.tokenBreaks ?? [])].sort((a, b) => a - b);
    if (breaks.some(n => !Number.isSafeInteger(n) || n < 0 || n > text.length)) return EMPTY;
    const excludes = [...run.exclusions].filter(r => r.from < r.to).sort((a, b) => a.from - b.from);
    const pair = getSegmenters(run.locale);
    const out: Utf16Range[] = [];
    let exclusionIndex = 0;
    function prefix(from: number, to: number, letters: readonly Utf16Range[]): void {
        while (exclusionIndex < excludes.length && excludes[exclusionIndex].to <= from) exclusionIndex++;
        if (excludes[exclusionIndex]?.from < to || letters.length <= 2) return;
        const count = Math.min(letters.length - 1, Math.max(1, Math.round(.45 * letters.length)));
        for (let i = 0; i < count; i++) {
            const r = letters[i], last = out[out.length - 1];
            if (last && last.to === r.from) last.to = r.to;
            else out.push({ from: r.from, to: r.to });
        }
    }
    const ends = [...breaks.filter(n => n > 0 && n < text.length), text.length];
    let start = 0;
    for (const end of ends) {
        const part = text.slice(start, end);
        for (const token of part.matchAll(/\S+/gu)) {
            const raw = token[0], base = start + token.index;
            if (raw.length > 16384 || PROTECTED.test(raw)) continue;
            let unicodeWorked = false;
            if (pair) {
                // Segmenter may fail while iterating as well as constructing.
                // Build the candidate list before emitting any ranges so the
                // conservative fallback cannot duplicate partial work.
                try {
                    const segments = [...pair.word.segment(raw)];
                    const candidates: { from: number; to: number; letters: Utf16Range[] }[] = [];
                    for (let i = 0; i < segments.length; i++) {
                        const segment = segments[i];
                        if (!segment.isWordLike) continue;
                        let word = segment.segment;
                        while (i + 2 < segments.length && JOIN.test(segments[i + 1].segment)
                            && segments[i + 2].isWordLike) {
                            word += segments[i + 1].segment + segments[i + 2].segment;
                            i += 2;
                        }
                        const from = segment.index, to = from + word.length;
                        // Do not detach a Latin prefix from an adjacent unknown
                        // script/combining continuation that ICU split apart.
                        const previousUnit = raw.charCodeAt(from - 1);
                        const before = raw.slice(from - (previousUnit >= 0xdc00 && previousUnit <= 0xdfff ? 2 : 1), from);
                        const afterCode = raw.codePointAt(to);
                        const after = afterCode === undefined ? '' : String.fromCodePoint(afterCode);
                        if (LETTER.test(before) || MARK.test(before) || LETTER.test(after) || MARK.test(after)) continue;
                        const letters: Utf16Range[] = [];
                        let valid = true;
                        for (const g of pair.grapheme.segment(word)) {
                            if (JOIN.test(g.segment)) continue;
                            if (!latinCluster(g.segment)) { valid = false; break; }
                            letters.push({ from: base + from + g.index, to: base + from + g.index + g.segment.length });
                        }
                        if (valid) candidates.push({ from: base + from, to: base + to, letters });
                    }
                    for (const c of candidates) prefix(c.from, c.to, c.letters);
                    unicodeWorked = true;
                } catch { /* bounded ASCII path below */ }
            }
            if (!unicodeWorked && /^[\x21-\x7e]+$/.test(raw)) {
                for (const match of raw.matchAll(/[A-Za-z]+(?:'[A-Za-z]+)*/g)) {
                    const letters: Utf16Range[] = [];
                    for (let i = 0; i < match[0].length; i++) {
                        if (match[0][i] !== "'") letters.push({ from: base + match.index + i, to: base + match.index + i + 1 });
                    }
                    prefix(base + match.index, base + match.index + match[0].length, letters);
                }
            }
        }
        start = end;
    }
    return out.length ? out : EMPTY;
}

/** Map only real, equal-length fragments; never map through hidden syntax.
 * Fragment order is projection order. Invalid maps fail closed. */
export function mapEmphasisRanges(ranges: readonly Utf16Range[], fragments: readonly SourceFragment[]): readonly Utf16Range[] {
    let previousRun = 0, previousSource = 0;
    for (const f of fragments) {
        if (![f.runFrom, f.runTo, f.sourceFrom, f.sourceTo].every(Number.isSafeInteger)
            || f.runFrom < previousRun || f.sourceFrom < previousSource || f.runTo < f.runFrom
            || f.sourceTo - f.sourceFrom !== f.runTo - f.runFrom) return EMPTY;
        previousRun = f.runTo; previousSource = f.sourceTo;
    }
    const out: Utf16Range[] = [];
    let fragmentIndex = 0;
    for (const r of [...ranges].sort((a, b) => a.from - b.from || a.to - b.to)) {
        if (!Number.isSafeInteger(r.from) || !Number.isSafeInteger(r.to) || r.from < 0 || r.to <= r.from) return EMPTY;
        let covered = 0;
        while (fragmentIndex < fragments.length && fragments[fragmentIndex].runTo <= r.from) fragmentIndex++;
        for (let i = fragmentIndex; i < fragments.length; i++) {
            const f = fragments[i];
            if (f.runFrom >= r.to) break;
            const from = Math.max(r.from, f.runFrom), to = Math.min(r.to, f.runTo);
            if (to > from) {
                covered += to - from;
                out.push({ from: f.sourceFrom + from - f.runFrom, to: f.sourceFrom + to - f.runFrom });
            }
        }
        if (covered !== r.to - r.from) return EMPTY;
    }
    return out.length ? out : EMPTY;
}
