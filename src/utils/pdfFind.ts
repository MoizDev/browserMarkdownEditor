export interface PdfFindHit { page: number; from: number; to: number }
export interface PdfFindProgress {
    queryId: number; hits: readonly PdfFindHit[]; pagesDone: number; pagesTotal: number;
    done: boolean; capped: boolean; textlessPages: number; failedPages: readonly number[];
    partialPages: readonly number[];
}
export interface PdfFindPageText { text: string; tokenBreaks: readonly number[]; quality: 'available' | 'partial' | 'none' }
export interface PdfFindSource {
    pageCount(signal: AbortSignal): Promise<number>;
    page(index0: number, signal: AbortSignal): Promise<PdfFindPageText>;
}
export interface PdfFindEngine {
    search(query: string, startPage: number, signal: AbortSignal): AsyncIterable<PdfFindProgress>;
    /** Each projected UTF-16 unit maps to its canonical start; the final entry
     * is the canonical length. Expansions (ﬁ → fi) share their source start. */
    project(page: PdfFindPageText): { key: string; map: Uint32Array };
    /** Canonical text is budgeted alongside keys so result snippets/refinements
     * do not cycle the reader's small geometry cache. */
    pageText(index0: number, signal: AbortSignal): Promise<PdfFindPageText>;
    clearIndex(): void;
    dispose(): void;
}
const TOKEN_BREAK = '\uE000', LINE_HYPHEN = '\uE001';
const DOCUMENT_BYTES = 32 * 1024 * 1024, APP_BYTES = 64 * 1024 * 1024, HIT_LIMIT = 10_000;
const encoder = new TextEncoder(), decoder = new TextDecoder();
const abort = () => new DOMException('PDF find cancelled', 'AbortError');
const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const isSpace = (c: string) => c.trim().length === 0;
const isBreak = (c: string) => c === TOKEN_BREAK || c === LINE_HYPHEN;
function droppedMark(code: number): boolean {
    return (code >= 0x0300 && code <= 0x036f) || (code >= 0x1ab0 && code <= 0x1aff) ||
        (code >= 0x1dc0 && code <= 0x1dff) || (code >= 0x20d0 && code <= 0x20ff) ||
        (code >= 0xfe20 && code <= 0xfe2f) || (code >= 0x064b && code <= 0x065f) ||
        code === 0x0670 || (code >= 0x0591 && code <= 0x05c7);
}
function fold(c: string): string {
    let out = '';
    for (const unit of c.normalize('NFKC').normalize('NFD')) if (!droppedMark(unit.codePointAt(0)!)) out += unit;
    return out.toLowerCase();
}
function queryUnits(query: string): string {
    let key = '', space = false;
    for (const char of query) {
        for (const c of fold(char)) {
            if (c === '\u00ad') continue;
            if (isSpace(c)) { space = key.length > 0; continue; }
            if (space) key += ' ';
            key += c; space = false;
        }
    }
    return key;
}

type ProjectionChunk = { key: string; offsets: number[] };
/** One producer serves synchronous reveal maps and sliced background indexing.
 * A page can contain a million units; projection must yield as well as matching. */
function* projectionChunks(page: PdfFindPageText): Generator<ProjectionChunk> {
    let key = '', offsets: number[] = [], breaks = 0, space = false, visited = 0;
    const emit = (text: string, source: number) => {
        key += text;
        for (let n = 0; n < text.length; n++) offsets.push(source);
    };
    for (let i = 0; i < page.text.length;) {
        while (breaks < page.tokenBreaks.length && page.tokenBreaks[breaks] < i) breaks++;
        if (page.tokenBreaks[breaks] === i) { emit(TOKEN_BREAK, i); breaks++; space = false; }
        const start = i, char = String.fromCodePoint(page.text.codePointAt(i)!);
        i += char.length;
        if (char === '\u0002' || char === '\ufffe') { emit(LINE_HYPHEN, start); space = false; }
        else {
            let end = i, lineEnd = false;
            if (char === '-' || char === '\u2010' || char === '\u2011' || char === '\u00ad') {
                while (end < page.text.length && isSpace(page.text[end])) {
                    if (page.text[end] === '\n' || page.text[end] === '\r') lineEnd = true;
                    end++;
                    // A long whitespace tail (or dropped-mark page below) can
                    // emit no key units. Bound source work, not just output.
                    if (++visited >= 4096) { yield { key, offsets }; key = ''; offsets = []; visited = 0; }
                }
            }
            if (lineEnd) { emit(LINE_HYPHEN, start); i = end; space = false; }
            else if (char !== '\u00ad') {
                for (const c of fold(char)) {
                    if (isSpace(c)) { if (!space) emit(' ', start); space = true; }
                    else { emit(c, start); space = false; }
                }
            }
        }
        if (++visited >= 4096 || offsets.length >= 4096) { yield { key, offsets }; key = ''; offsets = []; visited = 0; }
    }
    yield { key, offsets };
}
function project(page: PdfFindPageText): { key: string; map: Uint32Array } {
    const keys: string[] = [], offsets: number[] = [];
    for (const chunk of projectionChunks(page)) { keys.push(chunk.key); for (const offset of chunk.offsets) offsets.push(offset); }
    offsets.push(page.text.length);
    return { key: keys.join(''), map: Uint32Array.from(offsets) };
}

type IndexedPage = { bytes: Uint8Array; canonical: Uint8Array; tokenBreaks: Uint32Array; runs: Uint32Array; length: number; canonicalLength: number;
    quality: PdfFindPageText['quality']; failed: boolean; cost: number };
type DocumentCache = { pages: Map<number, IndexedPage>; bytes: number };
// In insertion order: evict a whole document, not an arbitrary set of its pages.
// The pane's visibility owner calls clearIndex after 60 s hidden; disposal of
// the document session releases it immediately, including on a vault switch.
const documents = new Map<DocumentCache, true>();
let appBytes = 0;
function clearCache(cache: DocumentCache) { appBytes -= cache.bytes; cache.bytes = 0; cache.pages.clear(); }
function touch(cache: DocumentCache) { documents.delete(cache); documents.set(cache, true); }
async function indexPage(page: PdfFindPageText, signal: AbortSignal): Promise<IndexedPage> {
    const keys: string[] = [], runs: number[] = [];
    let position = 0, lastDelta = Number.NaN, deadline = performance.now() + 4;
    for (const chunk of projectionChunks(page)) {
        if (signal.aborted) throw abort();
        keys.push(chunk.key);
        for (const canonical of chunk.offsets) {
            const delta = canonical - position;
            if (delta !== lastDelta) { runs.push(position, canonical); lastDelta = delta; }
            position++;
        }
        if (performance.now() >= deadline) { await yieldTask(); deadline = performance.now() + 4; }
    }
    const bytes = encoder.encode(keys.join('')), compact = Uint32Array.from(runs);
    const canonical = encoder.encode(page.text), tokenBreaks = Uint32Array.from(page.tokenBreaks);
    return { bytes, canonical, tokenBreaks, runs: compact, length: position, canonicalLength: page.text.length,
        quality: page.quality, failed: false, cost: bytes.byteLength + canonical.byteLength + tokenBreaks.byteLength + compact.byteLength + 64 };
}
function canonicalAt(page: IndexedPage, position: number): number {
    if (position >= page.length) return page.canonicalLength;
    let low = 0, high = page.runs.length / 2;
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (page.runs[mid * 2] <= position) low = mid; else high = mid; }
    return page.runs[low * 2 + 1] + position - page.runs[low * 2];
}
function canonicalEnd(page: IndexedPage, end: number): number {
    const start = canonicalAt(page, end - 1);
    // A partial match of a compatibility expansion still selects the whole
    // original glyph, never a zero-width slice or half a surrogate pair.
    while (end < page.length && canonicalAt(page, end) === start) end++;
    return canonicalAt(page, end);
}

type Automaton = { masks: Map<string, Uint32Array>; skip: Uint32Array; words: number; lastWord: number; lastBit: number };
function automaton(units: string): Automaton {
    const words = Math.ceil(units.length / 32), masks = new Map<string, Uint32Array>(), skip = new Uint32Array(words);
    function bit(char: string, index: number) {
        let mask = masks.get(char); if (!mask) { mask = new Uint32Array(words); masks.set(char, mask); }
        mask[index >>> 5] |= 1 << (index & 31);
    }
    for (let j = 0; j < units.length; j++) {
        const char = units[j]; bit(char, j);
        if (char === ' ') bit(TOKEN_BREAK, j);
        if (char === '-') bit(LINE_HYPHEN, j);
        if (j + 1 < units.length && char !== ' ' && units[j + 1] !== ' ') skip[j >>> 5] |= 1 << (j & 31);
    }
    return { masks, skip, words, lastWord: (units.length - 1) >>> 5, lastBit: 1 << ((units.length - 1) & 31) };
}
function advance(state: Uint32Array, machine: Automaton, char: string, seed: number): boolean {
    const mask = machine.masks.get(char), breaks = isBreak(char);
    let carry = seed, live = 0;
    for (let w = 0; w < machine.words; w++) {
        const old = state[w], shifted = (old << 1) | carry;
        carry = old >>> 31;
        state[w] = (shifted & (mask?.[w] ?? 0)) | (breaks ? old & machine.skip[w] : 0);
        live |= state[w];
    }
    return live !== 0;
}
async function* matchPage(key: string, units: string, signal: AbortSignal): AsyncGenerator<{ from: number; to: number }> {
    const forward = automaton(units), reverse = automaton(units.split('').reverse().join(''));
    const state = new Uint32Array(forward.words), backwards = new Uint32Array(forward.words);
    let previousEnd = 0, ticks = 0, deadline = performance.now() + 4;
    async function pause() {
        if (signal.aborted) throw abort();
        if (performance.now() >= deadline) { await yieldTask(); deadline = performance.now() + 4; }
    }
    for (let i = 0; i < key.length; i++) {
        if ((++ticks & 4095) === 0) await pause();
        advance(state, forward, key[i], 1);
        if (!(state[forward.lastWord] & forward.lastBit)) continue;
        const end = i + 1;
        let from = i;
        backwards.fill(0);
        for (let j = i; j >= previousEnd; j--) {
            if ((++ticks & 4095) === 0) await pause();
            const live = advance(backwards, reverse, key[j], j === i ? 1 : 0);
            if (backwards[reverse.lastWord] & reverse.lastBit) from = j;
            if (!live) break;
        }
        if (signal.aborted) throw abort();
        yield { from, to: end };
        previousEnd = end; state.fill(0);
    }
}

export function createPdfFindEngine(source: PdfFindSource, budget = { indexBytes: DOCUMENT_BYTES }): PdfFindEngine {
    const cache: DocumentCache = { pages: new Map(), bytes: 0 };
    const lifetime = new AbortController();
    let current: AbortController | undefined, serial = 0;
    const maxBytes = Math.max(0, Math.min(DOCUMENT_BYTES, Number.isFinite(budget.indexBytes) ? budget.indexBytes : DOCUMENT_BYTES));
    async function getPage(index: number, signal: AbortSignal) {
        const cached = cache.pages.get(index);
        if (cached) { touch(cache); return cached; }
        let page: IndexedPage;
        try { page = await indexPage(await source.page(index, signal), signal); }
        catch (error) {
            if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
            page = { bytes: new Uint8Array(), canonical: new Uint8Array(), tokenBreaks: new Uint32Array(), runs: new Uint32Array(), length: 0, canonicalLength: 0, quality: 'none', failed: true, cost: 64 };
        }
        if (signal.aborted) throw abort();
        const shared = cache.pages.get(index);
        if (shared) { touch(cache); return shared; }
        if (cache.bytes + page.cost <= maxBytes) {
            touch(cache);
            while (appBytes + page.cost > APP_BYTES) {
                const victim = [...documents.keys()].find(document => document !== cache);
                if (!victim) break;
                clearCache(victim); documents.delete(victim);
            }
            cache.pages.set(index, page); cache.bytes += page.cost; appBytes += page.cost;
        }
        return page;
    }
    return {
        project,
        async pageText(index, externalSignal) {
            const signal = AbortSignal.any([externalSignal, lifetime.signal]);
            const page = await getPage(index, signal);
            if (page.failed) throw new Error(`Could not read physical page ${index + 1}`);
            return { text: decoder.decode(page.canonical), tokenBreaks: Array.from(page.tokenBreaks), quality: page.quality };
        },
        clearIndex() { clearCache(cache); },
        async *search(query, startPage, externalSignal) {
            current?.abort();
            const controller = new AbortController(); current = controller;
            const signal = AbortSignal.any([externalSignal, lifetime.signal, controller.signal]);
            const queryId = ++serial, units = queryUnits(query);
            if (signal.aborted) throw abort();
            const pagesTotal = await source.pageCount(signal);
            const hits: PdfFindHit[] = [], failedPages: number[] = [], partialPages: number[] = [];
            let pagesDone = 0, textlessPages = 0, capped = false, lastPublish = performance.now(), deadline = lastPublish + 4;
            const progress = (done: boolean): PdfFindProgress => ({ queryId, hits: [...hits].sort((a, b) => a.page - b.page || a.from - b.from), pagesDone, pagesTotal,
                done, capped, textlessPages, failedPages: [...failedPages].sort((a, b) => a - b), partialPages: [...partialPages].sort((a, b) => a - b) });
            try {
                if (!units.length || units.length > 256) { yield progress(true); return; }
                const start = Math.max(0, Math.min(pagesTotal - 1, Number.isFinite(startPage) ? Math.floor(startPage) : 0));
                for (let offset = 0; offset < pagesTotal; offset++) {
                    if (signal.aborted) throw abort();
                    const index = (start + offset) % pagesTotal, page = await getPage(index, signal);
                    if (signal.aborted) throw abort();
                    if (page.failed) failedPages.push(index);
                    else {
                        if (page.quality === 'none') textlessPages++;
                        else if (page.quality === 'partial') partialPages.push(index);
                        for await (const match of matchPage(decoder.decode(page.bytes), units, signal)) {
                            const from = canonicalAt(page, match.from), to = canonicalEnd(page, match.to);
                            // Compatibility expansions can produce two projected hits
                            // on one glyph. Canonical ranges still never overlap.
                            const previous = hits.at(-1);
                            if (!previous || previous.page !== index || previous.to <= from) hits.push({ page: index, from, to });
                            if (hits.length >= HIT_LIMIT) { capped = true; break; }
                        }
                    }
                    pagesDone++;
                    if (capped) break;
                    // Cached short pages have no worker await to yield input.
                    // The slice budget spans page boundaries, not just a page.
                    if (performance.now() >= deadline) { await yieldTask(); deadline = performance.now() + 4; }
                    if (performance.now() - lastPublish >= 16 && pagesDone < pagesTotal) { yield progress(false); lastPublish = performance.now(); }
                }
                if (signal.aborted) throw abort();
                yield progress(true);
            } finally { if (current === controller) current = undefined; }
        },
        dispose() { lifetime.abort(); current?.abort(); clearCache(cache); documents.delete(cache); },
    };
}
