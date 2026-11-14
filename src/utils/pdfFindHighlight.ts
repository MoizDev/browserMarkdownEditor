import type { PdfFindHit } from './pdfFind';
import type { ReaderToken } from '../types/reading';

export interface PdfFindMemory { open: boolean; query: string }
type FindIdentity = Pick<ReaderToken, 'vaultId' | 'vaultEpoch' | 'documentId'>;
const memories = new Map<string, PdfFindMemory>();
const owners = new WeakMap<PdfFindMemory, object>();
let vaultScope = '';
const scopeOf = (identity: FindIdentity) => JSON.stringify([identity.vaultId, identity.vaultEpoch]);
const keyOf = (identity: FindIdentity) => JSON.stringify([identity.vaultId, identity.documentId]);

/** Reading during render is side-effect-free; ownership begins after commit. */
export function peekPdfFindMemory(identity: FindIdentity): PdfFindMemory | undefined {
    return vaultScope === scopeOf(identity) ? memories.get(keyOf(identity)) : undefined;
}

/** A byte-generation remount keeps just the query/open bit, never old offsets.
 * The microtask distinguishes that replacement (and StrictMode replay) from a
 * real close. The cap also bounds abandoned/uncommitted host lifetimes. */
export function retainPdfFindMemory(identity: FindIdentity, memory: PdfFindMemory): () => void {
    const scope = scopeOf(identity), key = keyOf(identity), owner = {};
    if (vaultScope !== scope) { memories.clear(); vaultScope = scope; }
    memories.delete(key); memories.set(key, memory); owners.set(memory, owner);
    while (memories.size > 32) memories.delete(memories.keys().next().value!);
    return () => queueMicrotask(() => {
        if (owners.get(memory) !== owner) return;
        if (memories.get(key) === memory) memories.delete(key);
        owners.delete(memory);
    });
}

export interface PdfFindTextSpan {
    from: number; to: number; div?: number; br?: number;
    /** Display-page points, captured from the raw text stream, never a DOM guess. */
    x: number; y: number;
}
export interface PdfFindBoundary { node: Node; offset: number }
export interface PdfFindTextLayer {
    container: HTMLElement; divs: readonly HTMLElement[]; spans: readonly PdfFindTextSpan[];
    breaks: readonly PdfFindBoundary[];
}

/** Cache child offsets once; setEndAfter on thousands of BR siblings would
 * otherwise repeatedly count the same long child list. */
export function pdfFindBreaks(container: HTMLElement): PdfFindBoundary[] {
    const breaks = [...container.querySelectorAll('br')];
    const boundaries = new Map<Node, PdfFindBoundary>();
    for (const parent of new Set(breaks.map(br => br.parentNode!))) {
        let offset = 0;
        for (const child of parent.childNodes) {
            if (child.nodeName === 'BR') boundaries.set(child, { node: parent, offset });
            offset++;
        }
    }
    return breaks.map(br => boundaries.get(br)!);
}

export function pdfFindSpan(spans: readonly PdfFindTextSpan[], offset: number): PdfFindTextSpan | undefined {
    let low = 0, high = spans.length;
    while (low < high) { const mid = (low + high) >>> 1; if (spans[mid].to <= offset) low = mid + 1; else high = mid; }
    return spans[low];
}
function point(div: HTMLElement, offset: number): { node: Text; offset: number } | undefined {
    const walker = div.ownerDocument.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    let node: Node | null, last: Text | undefined;
    while ((node = walker.nextNode())) {
        last = node as Text;
        if (offset <= last.length) return { node: last, offset };
        offset -= last.length;
    }
    return last ? { node: last, offset: last.length } : undefined;
}

/** TextLayer and the canonical model see identical raw strings/EOLs. Capture
 * their short intervals while the layer consumes its own stream: highlighting
 * 300 already-built pages must not re-extract 300 full canonical geometry maps. */
export function pdfFindRange(layer: PdfFindTextLayer, hit: Pick<PdfFindHit, 'from' | 'to'>): Range | undefined {
    const { spans, divs, breaks, container } = layer;
    let low = 0, high = spans.length;
    while (low < high) { const mid = (low + high) >>> 1; if (spans[mid].to <= hit.from) low = mid + 1; else high = mid; }
    let first = low;
    low = first; high = spans.length;
    while (low < high) { const mid = (low + high) >>> 1; if (spans[mid].from < hit.to) low = mid + 1; else high = mid; }
    let last = low - 1;
    const usable = (index: number) => {
        const span = spans[index];
        if (!span || span.to <= span.from) return false;
        if (span.br !== undefined) return !!breaks[span.br] && container.contains(breaks[span.br].node);
        const div = span.div === undefined ? undefined : divs[span.div];
        return !!div && container.contains(div) && !!div.textContent;
    };
    while (first <= last && !usable(first)) first++;
    while (last >= first && !usable(last)) last--;
    if (first > last) return;
    const a = spans[first], b = spans[last];
    const start = a.br !== undefined ? breaks[a.br] : point(divs[a.div!], Math.max(0, hit.from - a.from));
    const end = b.br !== undefined ? { node: breaks[b.br].node, offset: breaks[b.br].offset + 1 }
        : point(divs[b.div!], Math.min(b.to - b.from, hit.to - b.from));
    if (!start || !end) return;
    const range = container.ownerDocument.createRange();
    range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
    return range.collapsed ? undefined : range;
}

const all = new Highlight(), current = new Highlight();
current.priority = 1;
function publish() {
    if (all.size) CSS.highlights.set('pdf-find', all); else CSS.highlights.delete('pdf-find');
    if (current.size) CSS.highlights.set('pdf-find-current', current); else CSS.highlights.delete('pdf-find-current');
}

/** Each retained viewer removes only its own ranges. Clearing one pane must
 * not erase the neighbouring PDF's find, including its orange current hit. */
export function createPdfFindHighlights() {
    const pages = new Map<number, readonly Range[]>();
    let active: Range | undefined;
    function setCurrent(range?: Range) {
        if (active) current.delete(active);
        active = range;
        if (range) current.add(range);
        publish();
    }
    function clearPage(index: number) {
        const ranges = pages.get(index);
        if (!ranges) return;
        for (const range of ranges) all.delete(range);
        pages.delete(index);
        if (active && ranges.includes(active)) setCurrent();
        publish();
    }
    return {
        setPage(index: number, ranges: readonly Range[]) {
            clearPage(index); pages.set(index, ranges);
            for (const range of ranges) all.add(range);
            publish();
        },
        setCurrent,
        clearPage,
        clear() {
            for (const ranges of pages.values()) for (const range of ranges) all.delete(range);
            pages.clear(); setCurrent();
        },
    };
}
