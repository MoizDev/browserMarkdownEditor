import { EditorView, Decoration, keymap } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { countEditorSlice, countEditorTransaction, countEditorWindow, measureEditorRender, measureEditorWork } from './editorPerf';
import { docAnalysisField } from './docAnalysis';
import { planPreviewWindows } from './livePreviewWindows';
import type { PreviewWindow } from './livePreviewWindows';
import { incrementalEditorEnabled } from '../utils/engineRouting';
import type { SyntaxNode } from '@lezer/common';
import { EditorSelection, Facet, Prec, RangeSet, RangeValue, StateField } from '@codemirror/state';
import type { EditorState, Extension, Range, Transaction } from '@codemirror/state';
import type { EditorMode } from '../types';
import { MathWidget } from './mathWidget';
import { analyzeDoc, mathSkipsRange, latexSourceDecorations } from './latexSource';
import { containsRange, firstRangeEndingAfter } from '../utils/rangeSearch';
import { parseListMarker } from './lists';
import type { ListMarker } from './lists';
import { CopyCodeWidget } from './copyCodeWidget';
import { HorizontalRuleWidget } from './hrWidget';
import { ImageWidget, imageEmbedActions, imageEmbedKeymap } from './imageWidget';
import type { ImageContext, ImageEmbedActions } from './imageWidget';
import { TableWidget } from './tableWidget';
import { tableReadingSelection } from './tableReadingSelection';
import { blankRowText, cellAt, delimiterCellText, parseTableLayout, rowColumnCount, tableLayoutAt } from './tableModel';
import { focusTableCell, tableDomAt } from './tableEdit';
import { MermaidWidget } from './mermaidWidget';
import { HIDE } from './hiddenMarker';
import { canWrite } from './readingMode';
import { readingEmphasisFacet } from './readingEmphasisConfig';
import type { EmphasisRun, SourceFragment, Utf16Range } from '../utils/readingEmphasis';

const BOLD = Decoration.mark({ class: 'cm-live-bold' });
const ITALIC = Decoration.mark({ class: 'cm-live-italic' });
const STRIKE = Decoration.mark({ class: 'cm-live-strikethrough' });
const INLINE_CODE = Decoration.mark({ class: 'cm-live-code' });
const LINK_MARK = Decoration.mark({ class: 'cm-live-link' });
const HIGHLIGHT = Decoration.mark({ class: 'cm-live-highlight' });
const LATEX_DELIM = Decoration.mark({ class: 'cm-latex-delim' });
const BLOCKQUOTE_LINE = Decoration.line({ class: 'cm-live-blockquote' });
const HTML_VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const HR_REPLACE = Decoration.replace({ widget: new HorizontalRuleWidget() });
const HEADING_LINE = [null, 1, 2, 3, 4, 5, 6].map(l =>
    l === null ? null : Decoration.line({ class: `cm-live-heading cm-live-heading-${l}` }));
const CODEBLOCK_LINE = [0, 1, 2, 3].map(bits => Decoration.line({
    class: 'cm-live-codeblock'
        + (bits & 1 ? ' cm-live-codeblock-start' : '')
        + (bits & 2 ? ' cm-live-codeblock-end' : ''),
}));

const DEC_CACHE_MAX = 512;
function cachePut(cache: Map<string, Decoration>, key: string, dec: Decoration): Decoration {
    if (cache.size >= DEC_CACHE_MAX) cache.clear();
    cache.set(key, dec);
    return dec;
}

type ListLook = 'raw' | 'raw-lift' | 'raw-lift-ordered' | 'raw-lift-start' | 'bullet' | 'ordered';

const LIST_LOOK_CLASS: Record<ListLook, string> = {
    raw: 'cm-live-list-item cm-live-list-raw',
    'raw-lift': 'cm-live-list-item cm-live-list-lift',
    'raw-lift-ordered': 'cm-live-list-item cm-live-list-lift cm-live-list-lift-ordered',
    'raw-lift-start': 'cm-live-list-item cm-live-list-lift cm-live-list-lift-start',
    bullet: 'cm-live-list-item cm-live-list-bullet',
    ordered: 'cm-live-list-item cm-live-list-ordered',
};

function rawLook(marker: ListMarker | null, wsRevealed: boolean): ListLook {
    if (!marker) return 'raw';
    if (wsRevealed) return 'raw-lift-start';
    return marker.ordered ? 'raw-lift-ordered' : 'raw-lift';
}

const LIST_MARKER = Decoration.mark({ class: 'cm-live-list-marker' });

const listLineCache = new Map<string, Decoration>();
function listLine(look: ListLook, indent: number, marker?: string): Decoration {
    const key = `${look}\n${indent}\n${marker ?? ''}`;
    let dec = listLineCache.get(key);
    if (!dec) {
        const style = `--list-indent: ${indent}`;
        const cls = LIST_LOOK_CLASS[look];
        dec = look === 'ordered'
            ? Decoration.line({ class: cls, attributes: { 'data-marker': marker!, style } })
            : Decoration.line({ class: cls, attributes: { style } });
        cachePut(listLineCache, key, dec);
    }
    return dec;
}

const wikiLinkCache = new Map<string, Decoration>();
function wikiLinkMark(target: string): Decoration {
    let dec = wikiLinkCache.get(target);
    if (!dec) {
        dec = Decoration.mark({ class: 'cm-wikilink', attributes: { 'data-wikilink': target } });
        cachePut(wikiLinkCache, target, dec);
    }
    return dec;
}

const SAFE_PROTOCOLS = new Set(['https:', 'http:', 'mailto:', 'tel:']);
const BARE_EMAIL = /^[^\s@<>:]+@[^\s@<>:]+\.[^\s@<>]+$/;
const BARE_WWW = /^www\.[^\s<>]+$/i;

function externalHref(raw: string): string | null {
    const text = raw.trim();
    const candidate = BARE_WWW.test(text) ? `https://${text}`
        : BARE_EMAIL.test(text) ? `mailto:${text}`
            : text;
    let url: URL;
    try {
        url = new URL(candidate);
    } catch {
        return null;
    }
    return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
}

const externalLinkCache = new Map<string, Decoration>();
function externalLinkMark(href: string): Decoration {
    let dec = externalLinkCache.get(href);
    if (!dec) {
        dec = Decoration.mark({
            tagName: 'a',
            class: 'cm-live-link cm-external-link',
            // CodeMirror sets these with setAttribute, so no note text is ever
            // parsed as markup on the way in — this is not a second innerHTML
            // sink, and must not become one.
            //
            // `noopener` is load-bearing rather than habit: without it the page
            // that opens gets a `window.opener` handle on THIS origin, the one
            // holding the vault's directory permission.
            attributes: { href, target: '_blank', rel: 'noopener noreferrer' },
        });
        cachePut(externalLinkCache, href, dec);
    }
    return dec;
}

function linkTextMark(state: EditorState, url: SyntaxNode | null, readMode: boolean): Decoration {
    if (!readMode || !url) return LINK_MARK;
    const dest = previewSlice(state, url.from, url.to).replace(/^<([^]*)>$/, '$1');
    const href = externalHref(dest);
    return href ? externalLinkMark(href) : LINK_MARK;
}

const URL_WRAPPERS = new Set(['Link', 'Autolink', 'Image', 'LinkReference']);

function insideLinkLabel(node: SyntaxNode): boolean {
    for (let p = node.parent; p; p = p.parent) {
        if (p.name === 'Link') return true;
    }
    return false;
}

type StateView = { state: EditorState };

function caretInsideRange(state: EditorState, from: number, to: number): boolean {
    for (const range of state.selection.ranges) {
        if (range.empty && range.from > from && range.from < to) return true;
    }
    return false;
}

class AtomicRange extends RangeValue {}
const ATOMIC = new AtomicRange();

interface LivePreview {
    deco: DecorationSet;
    atoms: RangeSet<AtomicRange>;
    imageSelected: boolean;
    images: readonly { from: number; to: number }[];
    tables: readonly { from: number; to: number }[];
    tableSelected: boolean;
    analysisRev: number;
}

function cursorInRange(state: EditorState, from: number, to: number): boolean {
    for (const range of state.selection.ranges) {
        if (range.from <= to && range.to >= from) return true;
    }
    return false;
}

function cursorOnLine(state: EditorState, from: number, to: number): boolean {
    const lineFrom = state.doc.lineAt(from).number;
    const lineTo = state.doc.lineAt(to).number;
    for (const range of state.selection.ranges) {
        const cursorLine = state.doc.lineAt(range.head).number;
        if (cursorLine >= lineFrom && cursorLine <= lineTo) return true;
    }
    return false;
}

function previewSlice(state: EditorState, from: number, to: number): string {
    if (__BME_BENCH__) countEditorSlice(to - from);
    return state.sliceDoc(from, to);
}

function* inWindow<T extends { from: number; to: number }>(items: readonly T[], window: PreviewWindow): Iterable<T> {
    for (let i = firstRangeEndingAfter(items, window.from); i < items.length && items[i].from < window.to; i++) yield items[i];
}

function buildDecorations(view: StateView, imageCtx: ImageContext, editorMode: EditorMode,
    window: PreviewWindow = { from: 0, to: view.state.doc.length + 1 }): LivePreview {
    const { state } = view;
    const decorations: Range<Decoration>[] = [];
    const atoms: Range<AtomicRange>[] = [];

    const analysis = analyzeDoc(state);
    const { mathRegions } = analysis;

    syntaxTree(state).iterate({
        from: window.from, to: Math.min(state.doc.length, window.to),
        enter(node) {
            const { type, from, to } = node;
            const name = type.name;

            if (mathSkipsRange(analysis, from, to)) return false;

            if (name.startsWith('ATXHeading') && name.length === 11) {
                const level = parseInt(name[10], 10);
                if (!level || level < 1 || level > 6) return;

                const line = state.doc.lineAt(from);

                decorations.push(HEADING_LINE[level]!.range(line.from));

                if (editorMode !== 'read' && cursorOnLine(state, from, to)) return;

                const heading = node.node;
                const open = heading.firstChild;
                if (!open || open.name !== 'HeaderMark') return;
                const last = heading.lastChild;
                const close = last && last.name === 'HeaderMark' && last.from > open.from ? last : null;

                const lineEnd = Math.min(to, line.to);
                const text = line.text;
                const blank = (pos: number) => {
                    const c = text.charCodeAt(pos - line.from);
                    return c === 32 || c === 9;
                };
                const contentEnd = close ? close.from : lineEnd;
                let titleFrom = open.to;
                while (titleFrom < contentEnd && blank(titleFrom)) titleFrom++;
                let titleTo = contentEnd;
                while (titleTo > titleFrom && blank(titleTo - 1)) titleTo--;

                const hideFrom = heading.parent?.name === 'Document' ? line.from : open.from;

                if (titleFrom >= titleTo) {
                    decorations.push(HIDE.range(hideFrom, lineEnd));
                    return false;
                }
                decorations.push(HIDE.range(hideFrom, titleFrom));
                if (titleTo < lineEnd) decorations.push(HIDE.range(titleTo, lineEnd));

                return;
            }

            if (name === 'EmphasisMark') {
                const parent = node.node.parent;
                if (!parent) return;

                if (editorMode !== 'read' && cursorInRange(state, parent.from, parent.to)) return;

                decorations.push(HIDE.range(from, to));
                return false;
            }

            if (name === 'Emphasis' || name === 'StrongEmphasis') {
                const mark = name === 'StrongEmphasis' ? BOLD : ITALIC;
                const innerFrom = node.node.firstChild ? node.node.firstChild.to : from;
                const innerTo = node.node.lastChild ? node.node.lastChild.from : to;
                if (innerTo > innerFrom) {
                    decorations.push(mark.range(innerFrom, innerTo));
                }
                return;
            }

            if (name === 'Strikethrough') {
                if (editorMode !== 'read' && cursorInRange(state, from, to)) return;

                decorations.push(HIDE.range(from, from + 2));
                decorations.push(HIDE.range(to - 2, to));
                decorations.push(STRIKE.range(from + 2, to - 2));

                return false;
            }

            if (name === 'InlineCode') {
                const content = previewSlice(state, from, to);
                const openTicks = content.match(/^`+/)?.[0].length || 1;
                const closeTicks = openTicks;

                if (to - closeTicks > from + openTicks) {
                    decorations.push(INLINE_CODE.range(from + openTicks, to - closeTicks));
                }

                if (editorMode !== 'read' && cursorInRange(state, from, to)) return false;

                decorations.push(HIDE.range(from, from + openTicks));
                decorations.push(HIDE.range(to - closeTicks, to));

                return false;
            }

            if (name === 'FencedCode') {
                const opening = node.node.firstChild;
                const last = node.node.lastChild;
                if (opening?.name !== 'CodeMark') return false;
                const closing = last?.name === 'CodeMark' && last.from > opening.to ? last : null;
                const startLine = state.doc.lineAt(opening.from);
                const endLine = state.doc.lineAt(closing?.from ?? to);
                if (opening.to > startLine.to) return false;
                const closed = closing !== null && endLine.number > startLine.number && closing.to <= endLine.to;

                const lang = startLine.text.trim().match(/^(?:`{3,}|~{3,})\s*(\S*)/)?.[1]?.toLowerCase() ?? '';
                if (lang === 'mermaid' && closed && (editorMode === 'read' || !cursorOnLine(state, from, to))) {
                    const firstContent = startLine.number + 1, lastContent = endLine.number - 1;
                    const code = firstContent <= lastContent
                        ? previewSlice(state, state.doc.line(firstContent).from, state.doc.line(lastContent).to) : '';
                    if (code.trim()) {
                        decorations.push(
                            Decoration.replace({ widget: new MermaidWidget(code) }).range(startLine.from, endLine.to)
                        );
                        return false;
                    }
                }

                decorations.push(
                    Decoration.widget({ widget: new CopyCodeWidget(), side: -1 }).range(startLine.from)
                );

                for (let i = Math.max(startLine.number, state.doc.lineAt(window.from).number);
                    i <= Math.min(endLine.number, state.doc.lineAt(Math.min(state.doc.length, window.to - 1)).number); i++) {
                    const line = state.doc.line(i);
                    const bits = (i === startLine.number ? 1 : 0) | (i === endLine.number ? 2 : 0);
                    decorations.push(CODEBLOCK_LINE[bits].range(line.from));
                }

                if (editorMode !== 'read' && cursorOnLine(state, from, to)) return;

                decorations.push(HIDE.range(startLine.from, startLine.to));
                if (closed) {
                    decorations.push(HIDE.range(endLine.from, endLine.to));
                }

                return false;
            }

            if (name === 'Link') {
                if (editorMode !== 'read' && cursorInRange(state, from, to)) return;

                const marks = node.node.getChildren('LinkMark');
                if (marks.length < 4) return;

                const linkTextStart = from + 1;
                const linkTextEnd = marks[1].from;
                if (linkTextEnd <= linkTextStart) return;

                // The destination is the URL after the `(` — NOT getChild('URL').
                // GFM autolinks a bare URL inside the LABEL too, and that one is
                // an earlier direct child of this very Link node, so the first
                // URL child of `[see https://a](https://b)` is https://a. Taking
                // it would hand the reader an href chosen by the label text: the
                // exact substitution the scheme allowlist exists to prevent.
                // `[label]()` has a `(…)` group and no URL in it, hence the null.
                const after = marks[2].nextSibling;
                const url = after?.name === 'URL' ? after : null;

                decorations.push(HIDE.range(from, linkTextStart));
                decorations.push(HIDE.range(linkTextEnd, to));
                decorations.push(linkTextMark(state, url, editorMode === 'read').range(linkTextStart, linkTextEnd));

                return;
            }

            if (name === 'Autolink') {
                if (editorMode !== 'read' && cursorInRange(state, from, to)) return;

                const url = node.node.getChild('URL');
                if (!url) return;

                decorations.push(HIDE.range(from, url.from));
                decorations.push(HIDE.range(url.to, to));
                const anchor = editorMode === 'read' && !insideLinkLabel(node.node);
                decorations.push(linkTextMark(state, url, anchor).range(url.from, url.to));

                return false;
            }

            if (name === 'URL') {
                if (editorMode !== 'read') return false;
                if (URL_WRAPPERS.has(node.node.parent?.name ?? '')) return false;
                if (insideLinkLabel(node.node)) return false;

                const href = externalHref(previewSlice(state, from, to));
                if (href) decorations.push(externalLinkMark(href).range(from, to));
                return false;
            }

            if (name === 'Blockquote') {
                if (editorMode !== 'read' && cursorOnLine(state, from, to)) return;

                const startLine = state.doc.lineAt(from).number;
                const endLine = state.doc.lineAt(to).number;

                for (let i = Math.max(startLine, state.doc.lineAt(window.from).number);
                    i <= Math.min(endLine, state.doc.lineAt(Math.min(state.doc.length, window.to - 1)).number); i++) {
                    const line = state.doc.line(i);
                    const lineText = line.text;
                    const quotePrefix = lineText.match(/^>\s?/);
                    if (quotePrefix) {
                        decorations.push(HIDE.range(line.from, line.from + quotePrefix[0].length));
                    }
                    decorations.push(BLOCKQUOTE_LINE.range(line.from));
                }
            }

            if (name === 'ListItem') {
                const line = state.doc.lineAt(from);

                let ownTo = to;
                for (let child = node.node.firstChild; child; child = child.nextSibling) {
                    if (child.name === 'BulletList' || child.name === 'OrderedList') {
                        const subLine = state.doc.lineAt(child.from).number;
                        ownTo = subLine > line.number ? state.doc.line(subLine - 1).to : line.to;
                        break;
                    }
                }
                const cursorOnThisLine = editorMode !== 'read' && cursorOnLine(state, from, ownTo);

                let depth = 0;
                let ancestor = node.node.parent;
                while (ancestor) {
                    if (ancestor.name === 'BulletList' || ancestor.name === 'OrderedList') {
                        depth++;
                    }
                    ancestor = ancestor.parent;
                }
                const indent = Math.max(0, depth - 1);

                const marker = parseListMarker(line.text);

                if (cursorOnThisLine) {
                    const wsLen = marker ? marker.ws.length : 0;
                    const wsRevealed = wsLen > 0 && cursorInRange(state, line.from, line.from + wsLen);
                    if (marker) {
                        if (wsLen > 0 && !wsRevealed) decorations.push(HIDE.range(line.from, line.from + wsLen));
                        decorations.push(LIST_MARKER
                            .range(wsRevealed ? line.from : line.from + wsLen, line.from + marker.prefixLen));
                    }
                    decorations.push(listLine(rawLook(marker, wsRevealed), indent).range(line.from));
                } else if (marker) {
                    decorations.push(HIDE.range(line.from, line.from + marker.prefixLen));
                    decorations.push(marker.ordered
                        ? listLine('ordered', indent, marker.marker).range(line.from)
                        : listLine('bullet', indent).range(line.from));
                } else {
                    decorations.push(listLine('raw', indent).range(line.from));
                }
            }

            if (name === 'HorizontalRule') {
                if (editorMode !== 'read' && cursorOnLine(state, from, to)) return;

                decorations.push(HR_REPLACE.range(from, to));

                return false;
            }
        },
    });

    for (const region of inWindow(mathRegions, window)) {
        if (editorMode !== 'read' && cursorInRange(state, region.from, region.to)) {
            decorations.push(...latexSourceDecorations(previewSlice(state, region.from, region.to), region.from));
            continue;
        }
        decorations.push(
            Decoration.replace({ widget: new MathWidget(region.latex, region.block) }).range(region.from, region.to)
        );
    }

    if (editorMode !== 'read') {
        for (const match of inWindow(analysis.dollarRuns, window)) {
            const { from, to } = match;
            if (!match.accepted) continue;
            decorations.push(LATEX_DELIM.range(from, to));
        }
    }

    for (const match of inWindow(analysis.highlights, window)) {
        const { from, to } = match;

        if (!match.accepted) continue;
        if (editorMode !== 'read' && cursorInRange(state, from, to)) continue;

        decorations.push(HIDE.range(from, from + 2));
        decorations.push(HIDE.range(to - 2, to));
        decorations.push(HIGHLIGHT.range(from + 2, to - 2));
    }

    const selection = state.selection.main;
    const editable = editorMode !== 'read';
    let imageSelected = false;
    const images: { from: number; to: number }[] = [];
    const tables: { from: number; to: number }[] = [];
    let tableSelected = false;
    for (const match of inWindow(analysis.objects.embeds, window)) {
        const { from, to, filename, width } = match;

        if (!match.accepted) continue;
        if (editorMode !== 'read' && caretInsideRange(state, from, to)) continue;

        const selected = imageCtx.editable && selection.from === from && selection.to === to;
        imageSelected ||= selected;
        images.push({ from, to });
        decorations.push(
            Decoration.replace({ widget: new ImageWidget(filename, width, imageCtx, selected) }).range(from, to)
        );
        atoms.push(ATOMIC.range(from, to));
    }

    for (const match of inWindow(analysis.wikilinks, window)) {
        if (!match.accepted) continue;

        const { from, to } = match;
        const inner = match.groups[1];
        const pipeIndex = inner.indexOf('|');
        const target = (pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner).split('#')[0].trim();

        if (editorMode !== 'read' && cursorInRange(state, from, to)) continue;

        const innerStart = from + 2;
        const innerEnd = to - 2;

        decorations.push(HIDE.range(from, innerStart));
        decorations.push(HIDE.range(innerEnd, to));

        const mark = wikiLinkMark(target);
        // `[[a|]]` has an empty alias: hiding `a|` would leave an empty mark,
        // which CodeMirror throws on ("Mark decorations may not be empty") and
        // which blanked the whole app. Show it as written instead.
        if (pipeIndex >= 0 && innerStart + pipeIndex + 1 < innerEnd) {
            const pipePos = innerStart + pipeIndex;
            decorations.push(HIDE.range(innerStart, pipePos + 1));
            decorations.push(mark.range(pipePos + 1, innerEnd));
        } else {
            decorations.push(mark.range(innerStart, innerEnd));
        }
    }

    // findTables returns only spans parseGrid accepts, and that is what keeps
    // the atom below and the editable widget in step: an atomic, never-revealed
    // range with no contenteditable cell in it would be a block of the user's
    // own text with no way to put a caret in it at all.
    for (const span of inWindow(analysis.objects.tables, window)) {
        if (!span.accepted) continue;
        const selected = editable && selection.from === span.from && selection.to === span.to;
        tableSelected ||= selected;
        decorations.push(
            Decoration.replace({
                widget: new TableWidget(previewSlice(state, span.from, span.to), editable, selected,
                    state.facet(readingEmphasisFacet)),
            }).range(span.from, span.to)
        );
        atoms.push(ATOMIC.range(span.from, span.to));
        tables.push(span);
    }

    return {
        deco: Decoration.set(decorations.filter(range => range.from >= window.from && range.from < window.to), true),
        // SORTED: images and tables are each a left-to-right pass, but tables
        // are appended after images, so the two runs interleave in the document
        // and the combined array is not in order. (This comment used to say the
        // opposite and was right at the time — it is exactly the kind of stale
        // claim that would make a later reader delete the `true`.)
        atoms: RangeSet.of(atoms.filter(range => range.from >= window.from && range.from < window.to), true),
        imageSelected,
        images,
        tables,
        tableSelected,
        analysisRev: analysis.rev,
    };
}

interface ReadingProjection {
    blocks: readonly Utf16Range[];
    hidden: readonly Utf16Range[];
    barriers: readonly Utf16Range[];
    strong: readonly Utf16Range[];
}
const readingDecorations = Facet.define<DecorationSet, DecorationSet | null>({
    combine: values => values[values.length - 1] ?? null,
});
function mergeProjectionRanges(input: readonly Utf16Range[]): Utf16Range[] {
    const sorted = [...input].sort((a, b) => a.from - b.from || a.to - b.to);
    const out: Utf16Range[] = [];
    for (const range of sorted) {
        const last = out[out.length - 1];
        if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
        else out.push({ from: range.from, to: range.to });
    }
    return out;
}
function buildReadingProjection(state: EditorState, decorations: DecorationSet, from: number, to: number): ReadingProjection {
    const tree = syntaxTree(state), analysis = analyzeDoc(state);
    for (;;) {
        const blocks: Utf16Range[] = [], strong: Utf16Range[] = [], html: Utf16Range[] = [];
        const hidden: Utf16Range[] = [], barriers: Utf16Range[] = [];
        const htmlOpen: { name: string; from: number; blockFrom: number; blockTo: number }[] = [];
        let nextFrom = from, nextTo = to;
        const extend = (range: Utf16Range) => {
            nextFrom = Math.min(nextFrom, range.from);
            nextTo = Math.max(nextTo, range.to);
        };
        tree.iterate({
            from, to,
            enter(node) {
                const { name, from: a, to: z } = node;
                if (z <= from || a >= to || mathSkipsRange(analysis, a, z)) return false;
                if (name === 'Paragraph') {
                    blocks.push({ from: a, to: z }); extend({ from: a, to: z });
                }
                if (name === 'StrongEmphasis') strong.push({ from: a, to: z });
                if (name === 'HTMLBlock' || name === 'Comment' || name === 'Image') html.push({ from: a, to: z });
                if (name === 'HTMLTag') {
                    html.push({ from: a, to: z });
                    const text = state.sliceDoc(a, z), tag = /^<\s*(\/?)\s*([a-z][a-z0-9:-]*)/i.exec(text);
                    let block = node.node.parent;
                    while (block && block.name !== 'Paragraph') block = block.parent;
                    if (tag && block) {
                        const name = tag[2].toLowerCase();
                        if (tag[1]) {
                            for (let i = htmlOpen.length - 1; i >= 0; i--) {
                                const open = htmlOpen[i];
                                if (open.name === name && open.blockFrom === block.from) {
                                    html.push({ from: open.from, to: z }); htmlOpen.splice(i, 1); break;
                                }
                            }
                        } else if (!/\/\s*>$/.test(text) && !HTML_VOID.has(name)) {
                            htmlOpen.push({ name, from: a, blockFrom: block.from, blockTo: block.to });
                        }
                    }
                }
                if (name === 'Strikethrough' || name === 'InlineCode' || name === 'FencedCode'
                    || name === 'Autolink' || name === 'URL' || name === 'HorizontalRule' || name === 'EmphasisMark') return false;
            },
        });
        for (const open of htmlOpen) html.push({ from: open.from, to: open.blockTo });
        decorations.between(from, to, (a, z, value) => {
            if (a >= to || z <= from || a >= z) return;
            if (value === HIDE) { hidden.push({ from: a, to: z }); extend({ from: a, to: z }); }
            else if (value.spec.widget) { barriers.push({ from: a, to: z }); extend({ from: a, to: z }); }
        });
        for (const ranges of [analysis.codeRanges, analysis.mathRegions]) {
            for (let i = firstRangeEndingAfter(ranges, from); i < ranges.length && ranges[i].from < to; i++) {
                barriers.push(ranges[i]); extend(ranges[i]);
            }
        }
        for (const range of html) { barriers.push(range); extend(range); }
        if (nextFrom === from && nextTo === to) {
            return { blocks, hidden: mergeProjectionRanges(hidden), barriers: mergeProjectionRanges(barriers),
                strong: mergeProjectionRanges(strong) };
        }
        from = nextFrom; to = nextTo;
    }
}

export interface ReadingProseRun { run: EmphasisRun; fragments: readonly SourceFragment[] }

export function readingProseRuns(state: EditorState, from: number, to: number): readonly ReadingProseRun[] {
    const decorations = state.facet(readingDecorations);
    if (!decorations || from >= to) return [];
    const frontier = Math.min(syntaxTree(state).length, state.doc.length);
    from = Math.max(0, Math.min(from, frontier));
    to = Math.min(frontier, to, from + 8192);
    const startLimit = Math.max(0, from - 4096), endLimit = Math.min(frontier, to + 4096);
    const sourceFrom = Math.max(0, startLimit - 1);
    const source = state.sliceDoc(sourceFrom, Math.min(frontier, endLimit + 1));
    const charAt = (pos: number) => source.charAt(pos - sourceFrom);
    while (from > startLimit && !/\s/u.test(charAt(from - 1))) from--;
    if (from === startLimit && from > 0 && !/\s/u.test(charAt(from - 1))) {
        while (from < to && !/\s/u.test(charAt(from))) from++;
    }
    while (to < endLimit && !/\s/u.test(charAt(to))) to++;
    if (to === endLimit && to < frontier && !/\s/u.test(charAt(to))) {
        while (to > from && !/\s/u.test(charAt(to - 1))) to--;
    }
    if (from >= to) return [];
    const meta = buildReadingProjection(state, decorations, from, to);
    const result: ReadingProseRun[] = [];
    for (let b = firstRangeEndingAfter(meta.blocks, from); b < meta.blocks.length && meta.blocks[b].from < to; b++) {
        const block = meta.blocks[b];
        const end = Math.min(block.to, to);
        let cursor = Math.max(block.from, from);
        const barriers = meta.barriers;
        const project = (a: number, z: number): void => {
            if (a >= z) return;
            const fragments: SourceFragment[] = [];
            let text = '', p = a;
            for (let i = firstRangeEndingAfter(meta.hidden, a); i < meta.hidden.length && meta.hidden[i].from < z; i++) {
                const h = meta.hidden[i], until = Math.min(h.from, z);
                if (p < until) {
                    fragments.push({ runFrom: text.length, runTo: text.length + until - p, sourceFrom: p, sourceTo: until });
                    text += source.slice(p - sourceFrom, until - sourceFrom);
                }
                p = Math.max(p, h.to);
            }
            if (p < z) {
                fragments.push({ runFrom: text.length, runTo: text.length + z - p, sourceFrom: p, sourceTo: z });
                text += source.slice(p - sourceFrom, z - sourceFrom);
            }
            const exclusions: Utf16Range[] = [];
            for (let i = firstRangeEndingAfter(meta.strong, a); i < meta.strong.length && meta.strong[i].from < z; i++) {
                const strong = meta.strong[i];
                for (const f of fragments) {
                    const x = Math.max(f.sourceFrom, strong.from), y = Math.min(f.sourceTo, strong.to);
                    if (x < y) exclusions.push({ from: f.runFrom + x - f.sourceFrom, to: f.runFrom + y - f.sourceFrom });
                }
            }
            if (text) result.push({ run: { text, exclusions }, fragments });
        };
        for (let i = firstRangeEndingAfter(barriers, cursor); i < barriers.length && barriers[i].from < end; i++) {
            project(cursor, Math.min(end, barriers[i].from));
            cursor = Math.max(cursor, barriers[i].to);
        }
        project(cursor, end);
    }
    return result;
}

function splicePreview(previous: LivePreview, tr: Transaction, windows: readonly PreviewWindow[],
    parts: readonly LivePreview[], imageCtx: ImageContext, editorMode: EditorMode): LivePreview {
    let deco = previous.deco.map(tr.changes), atoms = previous.atoms.map(tr.changes);
    let images = previous.images.map(span => ({ from: tr.changes.mapPos(span.from, 1), to: tr.changes.mapPos(span.to, -1) }));
    let tables = previous.tables.map(span => ({ from: tr.changes.mapPos(span.from, 1), to: tr.changes.mapPos(span.to, -1) }));
    for (let i = 0; i < windows.length; i++) {
        const w = windows[i], part = parts[i], limit = Math.min(tr.state.doc.length, w.to);
        const additions: Range<Decoration>[] = [], atomAdditions: Range<AtomicRange>[] = [];
        part.deco.between(w.from, limit, (from, to, value) => { additions.push(value.range(from, to)); });
        part.atoms.between(w.from, limit, (from, to, value) => { atomAdditions.push(value.range(from, to)); });
        const keep = (from: number) => from < w.from || from >= w.to;
        deco = deco.update({ filterFrom: w.from, filterTo: limit, filter: keep, add: additions, sort: true });
        atoms = atoms.update({ filterFrom: w.from, filterTo: limit, filter: keep, add: atomAdditions, sort: true });
        images = images.filter(span => keep(span.from)).concat(part.images.filter(span => !keep(span.from)));
        tables = tables.filter(span => keep(span.from)).concat(part.tables.filter(span => !keep(span.from)));
    }
    images.sort((a, b) => a.from - b.from); tables.sort((a, b) => a.from - b.from);
    const selection = tr.state.selection.main;
    const atSelection = (spans: readonly { from: number; to: number }[]) => {
        let lo = 0, hi = spans.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (spans[mid].from < selection.from) lo = mid + 1; else hi = mid; }
        const span = spans[lo];
        return !!span && span.from === selection.from && span.to === selection.to;
    };
    return { deco, atoms, images, tables, imageSelected: imageCtx.editable && atSelection(images),
        tableSelected: editorMode !== 'read' && atSelection(tables), analysisRev: tr.state.field(docAnalysisField).rev };
}

export const imageContextFacet = Facet.define<ImageContext, ImageContext | null>({
    combine: values => values[0] ?? null,
});
const modeOf = (state: EditorState): EditorMode => state.facet(EditorView.editable) ? 'edit' : 'read';

export const livePreviewField = StateField.define<LivePreview>({
        create(state: EditorState) {
            const viewShim = { state };
            const imageCtx = state.facet(imageContextFacet)!;
            const editorMode = modeOf(state);
            if (__BME_BENCH__) {
                return measureEditorRender(state, 'create', state.doc.length, () => buildDecorations(viewShim, imageCtx, editorMode));
            }
            return buildDecorations(viewShim, imageCtx, editorMode);
        },
        update(decorations: LivePreview, tr: Transaction) {
            if (__BME_BENCH__) { countEditorTransaction(tr.state); }
            const imageCtx = tr.state.facet(imageContextFacet)!;
            const editorMode = modeOf(tr.state);
            const modeChanged = editorMode !== modeOf(tr.startState);
            const treeAdvanced = syntaxTree(tr.state) !== syntaxTree(tr.startState);
            const selectionChanged = editorMode !== 'read' && !tr.state.selection.eq(tr.startState.selection);
            if (tr.docChanged || treeAdvanced || selectionChanged || modeChanged) {
                const state = tr.state, viewShim = { state };
                const full = (reason: 'mode' | 'coverage' | 'revGap' | 'error') => __BME_BENCH__
                    ? measureEditorRender(state, reason, state.doc.length, () => buildDecorations(viewShim, imageCtx, editorMode))
                    : buildDecorations(viewShim, imageCtx, editorMode);
                if (modeChanged) return full('mode');
                if (!incrementalEditorEnabled() || imageCtx !== tr.startState.facet(imageContextFacet) ||
                    state.facet(readingEmphasisFacet) !== tr.startState.facet(readingEmphasisFacet)) return full('coverage');
                const analysis = state.field(docAnalysisField, false);
                if (!analysis || analysis.rev < decorations.analysisRev || analysis.rev > decorations.analysisRev + 1 ||
                    (analysis.rev !== decorations.analysisRev && analysis.delta?.forRev !== analysis.rev)) return full('revGap');
                try {
                    const windows = planPreviewWindows(tr, analysis, editorMode !== 'read', analysis.rev !== decorations.analysisRev);
                    if (windows.reduce((sum, window) => sum + window.to - window.from, 0) > (state.doc.length + 1) / 2) return full('coverage');
                    const render = () => {
                        const parts = windows.map(window => {
                            if (__BME_BENCH__) countEditorWindow(window.to - window.from);
                            return buildDecorations(viewShim, imageCtx, editorMode, window);
                        });
                        return splicePreview(decorations, tr, windows, parts, imageCtx, editorMode);
                    };
                    return __BME_BENCH__ ? measureEditorWork(state, render) : render();
                } catch {
                    return full('error');
                }
            }
            if (imageCtx !== tr.startState.facet(imageContextFacet)) {
                let deco = decorations.deco;
                for (const span of decorations.images) {
                    let image: ImageWidget | undefined;
                    deco.between(span.from, span.to, (from, to, value) => {
                        if (from === span.from && to === span.to && value.spec.widget instanceof ImageWidget) image = value.spec.widget;
                    });
                    if (!image) continue;
                    const next = Decoration.replace({ widget: new ImageWidget(image.filename, image.width, imageCtx, image.selected) }).range(span.from, span.to);
                    deco = deco.update({ filterFrom: span.from, filterTo: span.to,
                        filter: (from, to, value) => !(from === span.from && to === span.to && value.spec.widget instanceof ImageWidget), add: [next] });
                }
                decorations = { ...decorations, deco };
            }
            if (tr.state.facet(readingEmphasisFacet) !== tr.startState.facet(readingEmphasisFacet)) {
                if (!decorations.tables.length) return decorations;
                let deco = decorations.deco;
                for (const span of decorations.tables) {
                    let table: TableWidget | undefined;
                    deco.between(span.from, span.to, (from, to, value) => {
                        if (from === span.from && to === span.to && value.spec.widget instanceof TableWidget) table = value.spec.widget;
                    });
                    if (!table) continue;
                    const next = Decoration.replace({ widget: new TableWidget(table.rawTable, table.canEdit,
                        table.selected, tr.state.facet(readingEmphasisFacet)) }).range(span.from, span.to);
                    deco = deco.update({ filterFrom: span.from, filterTo: span.to,
                        filter: (from, to, value) => !(from === span.from && to === span.to && value.spec.widget instanceof TableWidget),
                        add: [next],
                    });
                }
                return { ...decorations, deco };
            }
            return decorations;
        },
        provide(field: StateField<LivePreview>) {
            return [
                readingDecorations.from(field, value => value.deco),
                EditorView.decorations.from(field, value => value.deco),
                EditorView.atomicRanges.of(view => view.state.field(field, false)?.atoms ?? RangeSet.empty),
                EditorView.editorAttributes.of(view => {
                    const value = view.state.field(field, false);
                    return value && (value.imageSelected || value.tableSelected)
                        ? { class: 'cm-image-selection' }
                        : null;
                }),
            ];
        }
    });

export function createLivePreviewPlugin(imageCtx: ImageContext, actions: ImageEmbedActions): Extension {
    return [
        imageContextFacet.of(imageCtx),
        tableReadingSelection,
        imageEmbedActions.of(actions),
        imageEmbedKeymap,
        tableEntryKeymap(),
        tableAdoptListener(),
    ];
}

function loneCaret(state: EditorState): number | null {
    const { ranges, main } = state.selection;
    if (ranges.length !== 1 || !main.empty) return null;
    return main.head;
}

function tableAt(view: EditorView, position: number, edge: 'from' | 'to' | 'inside') {
    const tables = analyzeDoc(view.state).objects.tables;
    let lo = 0, hi = tables.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const key = edge === 'from' ? tables[mid].from : tables[mid].to;
        if (key < position || (edge === 'inside' && key === position)) lo = mid + 1;
        else hi = mid;
    }
    const table = tables[lo];
    if (!table?.accepted) return undefined;
    if (edge === 'inside') return table.from < position && position < table.to ? table : undefined;
    return table[edge] === position ? table : undefined;
}

function enterTable(view: EditorView, from: number, edge: 'first' | 'last', x: number | null): boolean {
    const dom = tableDomAt(view, from);
    if (!dom) return false;
    const layout = parseTableLayout(view.state.doc, from);
    if (!layout) return false;
    const row = edge === 'first' ? 0 : layout.rows.length - 1;
    if (x === null) {
        return focusTableCell(dom, row, edge === 'first' ? 0 : layout.columns - 1,
            edge === 'first' ? 'start' : 'end');
    }
    let col = 0;
    for (let i = 0; i < layout.columns; i++) {
        const cell = dom.querySelector(`.cm-table-cell[data-row="${row}"][data-col="${i}"]`);
        const rect = cell?.getBoundingClientRect();
        if (rect && x >= rect.left) col = i;
    }
    return focusTableCell(dom, row, col, { x });
}

function tableEntryKeymap(): Extension {
    const leavesLine = (view: EditorView, pos: number, forward: boolean): boolean => {
        const line = view.state.doc.lineAt(pos);
        const target = view.moveVertically(EditorSelection.cursor(pos), forward).head;
        return forward ? target > line.to : target < line.from;
    };

    const enterFromLineAbove = (view: EditorView): boolean => {
        if (!canWrite(view.state)) return false;
        const pos = loneCaret(view.state);
        if (pos === null) return false;
        const line = view.state.doc.lineAt(pos);
        if (line.number >= view.state.doc.lines) return false;
        const next = view.state.doc.line(line.number + 1).from;
        const table = tableAt(view, next, 'from');
        if (!table || !leavesLine(view, pos, true)) return false;
        return enterTable(view, table.from, 'first', view.coordsAtPos(pos)?.left ?? null);
    };

    const enterFromLineBelow = (view: EditorView): boolean => {
        if (!canWrite(view.state)) return false;
        const pos = loneCaret(view.state);
        if (pos === null) return false;
        const line = view.state.doc.lineAt(pos);
        if (line.number <= 1) return false;
        const previous = view.state.doc.line(line.number - 1).to;
        const table = tableAt(view, previous, 'to');
        if (!table || !leavesLine(view, pos, false)) return false;
        return enterTable(view, table.from, 'last', view.coordsAtPos(pos)?.left ?? null);
    };

    const enterFromEdge = (view: EditorView, side: 'from' | 'to'): boolean => {
        if (!canWrite(view.state)) return false;
        const pos = loneCaret(view.state);
        if (pos === null) return false;
        const table = tableAt(view, pos, side);
        if (!table) return false;
        return enterTable(view, table.from, side === 'from' ? 'first' : 'last', null);
    };

    const selectBeside = (view: EditorView, side: 'from' | 'to'): boolean => {
        if (!canWrite(view.state)) return false;
        const pos = loneCaret(view.state);
        if (pos === null) return false;
        const table = tableAt(view, pos, side);
        if (!table) return false;
        view.dispatch({ selection: EditorSelection.single(table.from, table.to) });
        return true;
    };

    const completeHeaderRow = (view: EditorView): boolean => {
        const { state } = view;
        if (!canWrite(state)) return false;
        const pos = loneCaret(state);
        if (pos === null) return false;
        const line = state.doc.lineAt(pos);
        if (pos !== line.to) return false;
        const columns = rowColumnCount(line.text);
        if (columns === 0 || /^\|[\s:|-]+\|\s*$/.test(line.text)) return false;
        if (line.number < state.doc.lines && state.doc.line(line.number + 1).text.startsWith('|')) return false;
        if (tableLayoutAt(state.doc, pos)) return false;
        if (containsRange(analyzeDoc(state).codeRanges, line.from, line.to)) return false;

        const insert = '\n|' + ` ${delimiterCellText(null)} |`.repeat(columns) + '\n' + blankRowText(columns);
        view.dispatch({ changes: { from: line.to, insert }, userEvent: 'input' });
        const dom = tableDomAt(view, line.from);
        if (dom) focusTableCell(dom, 1, 0, 'start');
        return true;
    };

    return Prec.high(keymap.of([
        { key: 'Enter', run: completeHeaderRow },
        { key: 'ArrowDown', run: enterFromLineAbove },
        { key: 'ArrowUp', run: enterFromLineBelow },
        { key: 'ArrowRight', run: view => enterFromEdge(view, 'from') },
        { key: 'ArrowLeft', run: view => enterFromEdge(view, 'to') },
        { key: 'Backspace', run: view => selectBeside(view, 'to') },
        { key: 'Delete', run: view => selectBeside(view, 'from') },
    ]));
}

function tableAdoptListener(): Extension {
    return EditorView.updateListener.of((update) => {
        const { view } = update;
        if (!view.hasFocus || !canWrite(view.state)) return;
        const pos = loneCaret(view.state);
        if (pos === null) return;

        {
            const table = tableAt(view, pos, 'inside');
            if (table) {
            const dom = tableDomAt(view, table.from);
            const layout = dom ? parseTableLayout(view.state.doc, table.from) : null;
            const cell = layout ? cellAt(layout, pos) : null;
                if (dom && cell) focusTableCell(dom, cell.row, cell.col, 'end');
                return;
            }
        }

        if (!update.transactions.some(tr => tr.isUserEvent('input.type'))) return;
        const insertionEnds = new Set<number>();
        for (const tr of update.transactions) {
            tr.changes.iterChanges((_fromA, _toA, _fromB, toB) => { insertionEnds.add(toB); });
        }
        {
            const table = tableAt(view, pos, 'to');
            if (!table || !insertionEnds.has(table.to)) return;
            const dom = tableDomAt(view, table.from);
            const layout = dom ? parseTableLayout(view.state.doc, table.from) : null;
            const lastRow = layout?.rows[layout.rows.length - 1];
            if (dom && layout && lastRow && lastRow.cells.length >= layout.columns) {
                focusTableCell(dom, layout.rows.length - 1, layout.columns - 1, 'end');
            }
            return;
        }
    });
}

if (import.meta.hot) {
    (import.meta.hot as unknown as { decline(): void }).decline();
}

