import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import type { Extension, Text } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { Tree } from '@lezer/common';
import { emphasisRanges, mapEmphasisRanges } from '../utils/readingEmphasis';
import type { Utf16Range } from '../utils/readingEmphasis';
import { readingProseRuns } from './livePreview';
import { headingFoldField } from './headingFold';
import { readingEmphasisFacet } from './readingEmphasisConfig';
export { readingEmphasisCompartment, readingEmphasisOptions } from './readingEmphasisConfig';
export type { ReadingEmphasisOptions } from './readingEmphasisConfig';

const PREFIX = Decoration.mark({ class: 'cm-reading-prefix', inclusive: false });
const CHUNK = 8192;
const MAX_CHUNKS = 128, MAX_UNITS = 256 * 1024;
interface Chunk { ranges: readonly Utf16Range[]; units: number }
interface Memo { tree: Tree; locale: string; chunks: Map<number, Chunk>; units: number }
const memo = new WeakMap<Text, Memo>();

class ReadingEmphasisView {
    decorations: DecorationSet = Decoration.none;
    constructor(view: EditorView) { this.build(view); }
    update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged
            || syntaxTree(update.state) !== syntaxTree(update.startState)
            || update.state.facet(readingEmphasisFacet) !== update.startState.facet(readingEmphasisFacet)
            || update.state.field(headingFoldField, false)?.deco !== update.startState.field(headingFoldField, false)?.deco) {
            this.build(update.view);
        }
    }
    private build(view: EditorView): void {
        const options = view.state.facet(readingEmphasisFacet);
        // Neither projection nor segmentation runs Off/in Edit. The extension
        // may be installed in every prose state without touching code/chat.
        if (!options.enabled || options.mode !== 'read' || view.composing) {
            this.decorations = Decoration.none;
            return;
        }
        const { state } = view, tree = syntaxTree(state);
        let cache = memo.get(state.doc);
        if (!cache || cache.tree !== tree || cache.locale !== options.locale) {
            cache = { tree, locale: options.locale, chunks: new Map(), units: 0 };
            memo.set(state.doc, cache);
        }
        const chunks = new Set<number>();
        for (const range of view.visibleRanges) {
            for (let from = Math.floor(range.from / CHUNK) * CHUNK; from < range.to; from += CHUNK) chunks.add(from);
        }
        const ranges = new Map<string, Utf16Range>();
        const folds = state.field(headingFoldField, false)?.deco;
        for (const from of chunks) {
            let chunk = cache.chunks.get(from);
            if (!chunk) {
                const runs = readingProseRuns(state, from, Math.min(state.doc.length, from + CHUNK));
                const mapped: Utf16Range[] = [];
                let units = 0;
                for (const { run, fragments } of runs) {
                    units += run.text.length;
                    mapped.push(...mapEmphasisRanges(emphasisRanges({ ...run, locale: options.locale }), fragments));
                }
                chunk = { ranges: mapped, units: Math.max(units, 1) };
                cache.chunks.set(from, chunk); cache.units += chunk.units;
                while (cache.chunks.size > MAX_CHUNKS || cache.units > MAX_UNITS) {
                    const key = cache.chunks.keys().next().value!;
                    cache.units -= cache.chunks.get(key)!.units;
                    cache.chunks.delete(key);
                }
            } else {
                cache.chunks.delete(from); cache.chunks.set(from, chunk);
            }
            for (const r of chunk.ranges) {
                if (!view.visibleRanges.some(v => v.from < r.to && v.to > r.from)) continue;
                let folded = false;
                folds?.between(r.from, r.to, () => { folded = true; });
                if (!folded) ranges.set(`${r.from}:${r.to}`, r);
            }
        }
        this.decorations = Decoration.set([...ranges.values()].map(r => PREFIX.range(r.from, r.to)), true);
    }
}

/** Singleton outside the options compartment; cached states keep its identity. */
export const readingEmphasis: Extension = [
    ViewPlugin.fromClass(ReadingEmphasisView, { decorations: plugin => plugin.decorations }),
    EditorView.baseTheme({
        '.cm-reading-prefix, .cm-table-reading-prefix': { fontWeight: '700' },
    }),
];

interface DeferredConfiguration { apply: () => void; frame: number; ended: () => void }
const pending = new WeakMap<EditorView, DeferredConfiguration>();
/** Integrator uses this for BOTH mode and preference reconfiguration. Latest
 * requested state wins, without committing/cancelling an in-flight composition. */
export function deferReadingConfiguration(view: EditorView, apply: () => void): void {
    const previous = pending.get(view);
    if (previous) { previous.apply = apply; return; }
    if (!view.composing && !view.compositionStarted) { apply(); return; }
    const item: DeferredConfiguration = { apply, frame: 0, ended: () => {
        item.frame = requestAnimationFrame(() => {
            if (view.composing || view.compositionStarted) { item.ended(); return; }
            cancelReadingConfiguration(view);
            item.apply();
        });
    } };
    pending.set(view, item);
    view.contentDOM.addEventListener('compositionend', item.ended, { once: true });
}
export function cancelReadingConfiguration(view: EditorView): void {
    const item = pending.get(view);
    if (!item) return;
    cancelAnimationFrame(item.frame);
    view.contentDOM.removeEventListener('compositionend', item.ended);
    pending.delete(view);
}

if (import.meta.hot) (import.meta.hot as unknown as { decline(): void }).decline();
