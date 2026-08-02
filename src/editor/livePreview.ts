import { EditorView, Decoration } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { RangeSet, RangeValue } from '@codemirror/state';
import type { EditorState, Extension, Range, Transaction } from '@codemirror/state';
import type { EditorMode } from '../types';
import { MathWidget } from './mathWidget';
import { analyzeDoc, firstMathFrom, overlapsMath, latexSourceDecorations } from './latexSource';
import { parseListMarker } from './lists';
import type { ListMarker } from './lists';
import { CopyCodeWidget } from './copyCodeWidget';
import { HorizontalRuleWidget } from './hrWidget';
import { ImageWidget, imageEmbedActions, imageEmbedKeymap } from './imageWidget';
import type { ImageContext, ImageEmbedActions } from './imageWidget';
import { embedPattern } from '../utils/assets';
import { TableWidget } from './tableWidget';
import { MermaidWidget } from './mermaidWidget';

/* ── Shared decoration values ──
   A Decoration is positionless and immutable — .range() produces the positioned
   value — so one instance can back every occurrence. Building them per call site
   per rebuild allocated a fresh spec object AND a fresh Decoration for each of
   ~10k-39k decorations per rebuild (measured), i.e. megabytes of identical
   garbage per keystroke. Sharing also lets CodeMirror's decoration diff
   short-circuit on instance identity, so it does less DOM work too. */
const HIDE = Decoration.replace({});
const BOLD = Decoration.mark({ class: 'cm-live-bold' });
const ITALIC = Decoration.mark({ class: 'cm-live-italic' });
const STRIKE = Decoration.mark({ class: 'cm-live-strikethrough' });
const INLINE_CODE = Decoration.mark({ class: 'cm-live-code' });
const LINK_MARK = Decoration.mark({ class: 'cm-live-link' });
const HIGHLIGHT = Decoration.mark({ class: 'cm-live-highlight' });
const LATEX_DELIM = Decoration.mark({ class: 'cm-latex-delim' });
const BLOCKQUOTE_LINE = Decoration.line({ class: 'cm-live-blockquote' });
const HR_REPLACE = Decoration.replace({ widget: new HorizontalRuleWidget() });
/** Indexed by heading level 1-6 (index 0 unused). */
const HEADING_LINE = [null, 1, 2, 3, 4, 5, 6].map(l =>
    l === null ? null : Decoration.line({ class: `cm-live-heading cm-live-heading-${l}` }));
/** Indexed by (isStart | isEnd << 1) — a one-line block is both. */
const CODEBLOCK_LINE = [0, 1, 2, 3].map(bits => Decoration.line({
    class: 'cm-live-codeblock'
        + (bits & 1 ? ' cm-live-codeblock-start' : '')
        + (bits & 2 ? ' cm-live-codeblock-end' : ''),
}));

/* The remaining decorations carry per-occurrence attributes, so they are cached
   by the value that varies. All three key spaces are small and repeat heavily
   within a document (indent is a small integer; markers and link targets recur).

   BOUNDED, like the mermaid SVG cache: the key spaces are small per document but
   accumulate across every document opened in a session — an ordered marker is
   "<n>." for every list position ever rendered, and a wikilink key is every
   distinct link target in the vault. A cache kept for its own sake in a memory
   pass should not itself be the thing that grows without limit; on overflow the
   whole map is dropped (these are cheap to rebuild, and a rebuild is one pass). */
const DEC_CACHE_MAX = 512;
function cachePut(cache: Map<string, Decoration>, key: string, dec: Decoration): Decoration {
    if (cache.size >= DEC_CACHE_MAX) cache.clear();
    cache.set(key, dec);
    return dec;
}

/* The looks a list line can have. `bullet`/`ordered` are rendered; the `raw-*`
   trio is the editing look, where the real `- ` / `1. ` shows instead of a drawn
   bullet. All three lift that revealed syntax OUT of the text flow (see
   .cm-live-list-marker) so the line keeps the rendered padding and the item's
   text never moves:
     raw-lift          — the marker sits in the drawn bullet's slot;
     raw-lift-ordered  — same, in the drawn number's (slightly wider) slot;
     raw-lift-start    — the cursor is inside the leading indentation, so that
                         shows too and the whole prefix is lifted as one, ending
                         where the content starts.
   `raw` is the fallback for a ListItem whose line has no parsable marker: it
   flows, so the line takes the narrow padding. */
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

/** The revealed `- ` / `1. `, lifted into the gutter by CSS. */
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

/** The single-argument, curried asset resolver the editor subsystem consumes. */
type GetAssetUrl = (fileName: string) => Promise<string | null>;

/** Structural shim for buildDecorations: the factory passes `{ state }`, not a full EditorView. */
type StateView = { state: EditorState };

/**
 * A caret sitting strictly BETWEEN from and to — never at either edge, and
 * never a selection.
 *
 * The one state in which an image embed shows its markdown. Because the range
 * is atomic (see below), no arrow key, click or drag can produce it; the only
 * thing that can is the keystrokes that typed the embed, where the caret is
 * left inside the brackets. So `![[a` keeps showing what is being typed
 * instead of collapsing into a broken picture on the first character, while a
 * finished embed stays a picture for good.
 */
function caretInsideRange(state: EditorState, from: number, to: number): boolean {
    for (const range of state.selection.ranges) {
        if (range.empty && range.from > from && range.from < to) return true;
    }
    return false;
}

/** Marks an image embed as one indivisible thing for the cursor to step over. */
class AtomicRange extends RangeValue {}
const ATOMIC = new AtomicRange();

/** What the live-preview field holds: the decorations to draw, the image ranges
 *  the cursor must treat as atomic, and whether one of them is the selection.
 *  All three come out of one pass. */
interface LivePreview {
    deco: DecorationSet;
    atoms: RangeSet<AtomicRange>;
    imageSelected: boolean;
}

/**
 * Check if the cursor (or any selection) overlaps the range [from, to].
 */
function cursorInRange(state: EditorState, from: number, to: number): boolean {
    for (const range of state.selection.ranges) {
        if (range.from <= to && range.to >= from) return true;
    }
    return false;
}

/**
 * Check if the cursor is on the same line as the given position range.
 */
function cursorOnLine(state: EditorState, from: number, to: number): boolean {
    const lineFrom = state.doc.lineAt(from).number;
    const lineTo = state.doc.lineAt(to).number;
    for (const range of state.selection.ranges) {
        const cursorLine = state.doc.lineAt(range.head).number;
        if (cursorLine >= lineFrom && cursorLine <= lineTo) return true;
    }
    return false;
}

/**
 * The Live Preview plugin — hides markdown syntax when cursor is away
 * and renders styled content, KaTeX math widgets, and Image widgets.
 */
function buildDecorations(view: StateView, imageCtx: ImageContext, editorMode: EditorMode): LivePreview {
    const { state } = view;
    const decorations: Range<Decoration>[] = [];
    const atoms: Range<AtomicRange>[] = [];

    // Math is located BEFORE the markdown pass so formula innards can be
    // exempted from markdown styling — "[x](y)" inside an equation is LaTeX,
    // not a link. Code ranges come first: a $ inside code is literal.
    //
    // All three derivations are memoized on (doc, tree) identity, so a
    // selection-only rebuild — which is every arrow key and click in edit mode
    // — reuses them instead of re-flattening the document and re-scanning it.
    const analysis = analyzeDoc(state);
    const { doc, codeRanges, mathRegions } = analysis;
    const intersectsMath = (a: number, b: number) => overlapsMath(analysis, a, b);

    syntaxTree(state).iterate({
        enter(node) {
            const { type, from, to } = node;
            const name = type.name;

            // A markdown construct inside (or straddling) a math region is
            // really LaTeX — skip it. Nodes that CONTAIN the whole region
            // (paragraph, list item, heading line…) still process normally.
            //
            // Binary-searched rather than scanned: this runs for EVERY node of
            // the whole tree, so a linear scan made it O(nodes x regions) —
            // ~186M comparisons and ~138ms per keystroke on a large math note.
            for (let i = firstMathFrom(analysis, from); i < mathRegions.length; i++) {
                const r = mathRegions[i];
                if (r.from >= to) break;
                if (!(from <= r.from && to >= r.to)) return false;
            }

            // === HEADINGS ===
            // ATXHeading1 through ATXHeading6
            if (name.startsWith('ATXHeading') && name.length === 11) {
                const level = parseInt(name[10], 10);
                if (!level || level < 1 || level > 6) return;

                const line = state.doc.lineAt(from);

                // Always style the entire heading line so it retains its size
                decorations.push(HEADING_LINE[level]!.range(line.from));

                // If editing and cursor is on the line, let the raw prefix `# ` show
                if (editorMode !== 'read' && cursorOnLine(state, from, to)) return;

                const headerText = line.text;
                const hashEnd = headerText.indexOf(' ') + 1; // position after "# "

                if (hashEnd > 0) {
                    // Hide the "# " prefix
                    decorations.push(HIDE.range(line.from, line.from + hashEnd));
                }

                // Recurse into children so inline syntax inside the heading
                // (emphasis, bold, code, links) is rendered rather than left raw.
                return;
            }

            // === EMPHASIS / STRONG (Asterisks handling via EmphasisMark) ===
            if (name === 'EmphasisMark') {
                const parent = node.node.parent;
                if (!parent) return;

                // Check if the cursor is anywhere within the entire Emphasis / Strong container
                if (editorMode !== 'read' && cursorInRange(state, parent.from, parent.to)) return;

                // If not, hide the markdown tokens entirely
                decorations.push(HIDE.range(from, to));
                return false;
            }

            // === EMPHASIS / STRONG styling ===
            // Style ONLY the inner text (between the markers), not the whole node.
            // A mark spanning [from, to] would overlap the EmphasisMark replace
            // decorations below and leave the `_` / `*` markers visible. By marking
            // just the content we keep bold/italic working while the markers still
            // hide cleanly. Iteration falls through to the EmphasisMark children,
            // which perform the hiding.
            if (name === 'Emphasis' || name === 'StrongEmphasis') {
                const mark = name === 'StrongEmphasis' ? BOLD : ITALIC;
                const innerFrom = node.node.firstChild ? node.node.firstChild.to : from;
                const innerTo = node.node.lastChild ? node.node.lastChild.from : to;
                if (innerTo > innerFrom) {
                    decorations.push(mark.range(innerFrom, innerTo));
                }
                return;
            }

            // === STRIKETHROUGH ===
            if (name === 'Strikethrough') {
                if (editorMode !== 'read' && cursorInRange(state, from, to)) return;

                decorations.push(HIDE.range(from, from + 2));
                decorations.push(HIDE.range(to - 2, to));
                decorations.push(STRIKE.range(from + 2, to - 2));

                return false;
            }

            // === INLINE CODE ===
            if (name === 'InlineCode') {
                // Find backtick boundaries
                const content = state.doc.sliceString(from, to);
                const openTicks = content.match(/^`+/)?.[0].length || 1;
                const closeTicks = openTicks;

                // The code styling is permanent — editing reveals just the
                // backticks, instead of the whole thing flashing to plain text.
                if (to - closeTicks > from + openTicks) {
                    decorations.push(INLINE_CODE.range(from + openTicks, to - closeTicks));
                }

                if (editorMode !== 'read' && cursorInRange(state, from, to)) return false;

                decorations.push(HIDE.range(from, from + openTicks));
                decorations.push(HIDE.range(to - closeTicks, to));

                return false;
            }

            // === FENCED CODE BLOCKS ===
            if (name === 'FencedCode') {
                const startLine = state.doc.lineAt(from);
                const endLine = state.doc.lineAt(to);
                const closed = endLine.number > startLine.number && endLine.text.trim().startsWith('```');

                const firstContent = startLine.number + 1;
                const lastContent = closed ? endLine.number - 1 : endLine.number;
                const code = firstContent <= lastContent
                    ? state.doc.sliceString(state.doc.line(firstContent).from, state.doc.line(lastContent).to)
                    : '';

                // === MERMAID DIAGRAMS ===
                // A closed ```mermaid block renders as a diagram widget while
                // the cursor is elsewhere; editing anywhere in it falls back
                // to the ordinary code panel so the source stays editable.
                const lang = startLine.text.trim().match(/^(?:`{3,}|~{3,})\s*(\S*)/)?.[1]?.toLowerCase() ?? '';
                if (lang === 'mermaid' && closed && code.trim() &&
                    (editorMode === 'read' || !cursorOnLine(state, from, to))) {
                    decorations.push(
                        Decoration.replace({ widget: new MermaidWidget(code) }).range(startLine.from, endLine.to)
                    );
                    return false;
                }

                // Copy button, pinned to the panel's top-right. The fence row
                // hosts it in every state (hidden = padding row, revealed =
                // the ``` line), so it never displaces code text.
                decorations.push(
                    Decoration.widget({ widget: new CopyCodeWidget(code), side: -1 }).range(startLine.from)
                );

                // The panel is permanent — every line gets it, fence lines
                // included, so the block reads as ONE rectangle whose (hidden)
                // fence rows double as top/bottom padding. Start/end classes
                // round just the outer corners.
                for (let i = startLine.number; i <= endLine.number; i++) {
                    const line = state.doc.line(i);
                    const bits = (i === startLine.number ? 1 : 0) | (i === endLine.number ? 2 : 0);
                    decorations.push(CODEBLOCK_LINE[bits].range(line.from));
                }

                // Editing anywhere in the block reveals the ``` fences (like a
                // heading's `#`), but the panel above stays put.
                if (editorMode !== 'read' && cursorOnLine(state, from, to)) return;

                // Hide the fence lines outright: the opening one (e.g.
                // ```javascript) and — only if the block is closed — the last.
                if (startLine.text.trim().startsWith('```')) {
                    decorations.push(HIDE.range(startLine.from, startLine.to));
                }
                if (closed) {
                    decorations.push(HIDE.range(endLine.from, endLine.to));
                }

                return false;
            }

            // === LINKS ===
            if (name === 'Link') {
                if (editorMode !== 'read' && cursorInRange(state, from, to)) return;

                const content = state.doc.sliceString(from, to);
                const match = content.match(/^\[([^\]]*)\]\(([^)]*)\)$/);
                if (!match) return;

                const linkText = match[1];
                const linkTextStart = from + 1; // after [
                const linkTextEnd = linkTextStart + linkText.length;

                // Hide [
                decorations.push(HIDE.range(from, from + 1));
                // Hide ](url)
                decorations.push(HIDE.range(linkTextEnd, to));
                // Style link text
                decorations.push(LINK_MARK.range(linkTextStart, linkTextEnd));

                return false;
            }

            // === BLOCKQUOTE ===
            if (name === 'Blockquote') {
                if (editorMode !== 'read' && cursorOnLine(state, from, to)) return;

                // Apply blockquote styling to each line in the quote
                const startLine = state.doc.lineAt(from).number;
                const endLine = state.doc.lineAt(to).number;

                for (let i = startLine; i <= endLine; i++) {
                    const line = state.doc.line(i);
                    const lineText = line.text;
                    const quotePrefix = lineText.match(/^>\s?/);
                    if (quotePrefix) {
                        // Hide "> " prefix
                        decorations.push(HIDE.range(line.from, line.from + quotePrefix[0].length));
                    }
                    // Style the line
                    decorations.push(BLOCKQUOTE_LINE.range(line.from));
                }

                // Don't return false — let children (emphasis, code, etc.) still be processed
            }

            // === LIST ITEMS ===
            if (name === 'ListItem') {
                const line = state.doc.lineAt(from);

                // A ListItem's range covers its NESTED items too. Revealing this
                // item's syntax because the cursor sits on a sub-point would
                // de-render a line the user isn't editing, so only the item's own
                // lines — everything before its first sub-list — count as "here".
                let ownTo = to;
                for (let child = node.node.firstChild; child; child = child.nextSibling) {
                    if (child.name === 'BulletList' || child.name === 'OrderedList') {
                        const subLine = state.doc.lineAt(child.from).number;
                        ownTo = subLine > line.number ? state.doc.line(subLine - 1).to : line.to;
                        break;
                    }
                }
                const cursorOnThisLine = editorMode !== 'read' && cursorOnLine(state, from, ownTo);

                // Calculate nesting depth by counting BulletList/OrderedList ancestors
                let depth = 0;
                let ancestor = node.node.parent;
                while (ancestor) {
                    if (ancestor.name === 'BulletList' || ancestor.name === 'OrderedList') {
                        depth++;
                    }
                    ancestor = ancestor.parent;
                }
                const indent = Math.max(0, depth - 1);

                // Same parse the Tab/Shift-Tab commands use, so a line that
                // renders as a bullet is exactly a line they will re-nest.
                const marker = parseListMarker(line.text);

                if (cursorOnThisLine) {
                    // Editing: keep the `- ` / `1. ` visible so the user edits real
                    // markdown. The revealed syntax is LIFTED out of the text flow
                    // into the slot the drawn bullet occupied, so it costs the item
                    // no indentation and moves none of its text (wrapped rows
                    // included) — only the glyph in the gutter changes.
                    // The leading indentation hides unless the cursor is inside it,
                    // so Backspacing through it stays visible; that case lifts the
                    // whole prefix instead, ending it where the content starts.
                    const wsLen = marker ? marker.ws.length : 0;
                    const wsRevealed = wsLen > 0 && cursorInRange(state, line.from, line.from + wsLen);
                    if (marker) {
                        if (wsLen > 0 && !wsRevealed) decorations.push(HIDE.range(line.from, line.from + wsLen));
                        decorations.push(LIST_MARKER
                            .range(wsRevealed ? line.from : line.from + wsLen, line.from + marker.prefixLen));
                    }
                    decorations.push(listLine(rawLook(marker, wsRevealed), indent).range(line.from));
                } else if (marker) {
                    // Rendered mode: hide the full marker and show the styled bullet/number.
                    decorations.push(HIDE.range(line.from, line.from + marker.prefixLen));
                    decorations.push(marker.ordered
                        // The source marker verbatim, so `3)` renders as "3)".
                        ? listLine('ordered', indent, marker.marker).range(line.from)
                        : listLine('bullet', indent).range(line.from));
                } else {
                    // A ListItem whose line has no marker to hide (a list inside
                    // a blockquote: `> - x`). Drawing a bullet would just add a
                    // SECOND marker beside the still-visible source one, so use
                    // the same flowing look the editing branch falls back to —
                    // which also means the line looks identical either way.
                    decorations.push(listLine('raw', indent).range(line.from));
                }

                // Don't return false — let children (emphasis, code, etc.) still be processed
            }

            // === HORIZONTAL RULE ===
            if (name === 'HorizontalRule') {
                if (editorMode !== 'read' && cursorOnLine(state, from, to)) return;

                // One shared widget: HorizontalRuleWidget.eq() is unconditionally
                // true, so every instance was already interchangeable.
                decorations.push(HR_REPLACE.range(from, to));

                return false;
            }
        },
    });

    // === MATH (LaTeX) ===
    // Regions come from findMathRegions (computed above). Cursor outside →
    // rendered KaTeX widget; cursor inside → the raw source stays visible and
    // gets Obsidian-style LaTeX syntax highlighting in Fira Code.
    let match: RegExpExecArray | null;
    for (const region of mathRegions) {
        if (editorMode !== 'read' && cursorInRange(state, region.from, region.to)) {
            decorations.push(...latexSourceDecorations(doc.slice(region.from, region.to), region.from));
            continue;
        }
        decorations.push(
            Decoration.replace({ widget: new MathWidget(region.latex, region.block) }).range(region.from, region.to)
        );
    }

    // Delimiter feedback while typing (Obsidian-style): a run of $s that isn't
    // part of a real math region yet turns blue as soon as it can pair up
    // ($$, $$$$ — even) and stays plain while unbalanced ($, $$$ — odd), so
    // you can see whether the next keystroke lands inside math mode.
    if (editorMode !== 'read') {
        const dollarRunRegex = /\$+/g;
        while ((match = dollarRunRegex.exec(doc)) !== null) {
            const from = match.index;
            const to = from + match[0].length;
            if (match[0].length % 2 !== 0) continue;
            if (doc[from - 1] === '\\') continue; // \$ — literal dollar
            if (intersectsMath(from, to)) continue;
            if (codeRanges.some(r => from < r.to && to > r.from)) continue;
            decorations.push(LATEX_DELIM.range(from, to));
        }
    }

    // === HIGHLIGHTS (==text==) ===
    // Matches: ==highlighted text==
    const highlightRegex = /(?<!=)==(?!=)(.+?)(?<!=)==(?!=)/g;
    while ((match = highlightRegex.exec(doc)) !== null) {
        const from = match.index;
        const to = from + match[0].length;

        if (intersectsMath(from, to)) continue;
        if (editorMode !== 'read' && cursorInRange(state, from, to)) continue;

        // Hide ==
        decorations.push(HIDE.range(from, from + 2));
        decorations.push(HIDE.range(to - 2, to));
        // Style inner content
        decorations.push(HIGHLIGHT.range(from + 2, to - 2));
    }

    // === IMAGES (Obsidian Syntax) ===
    // Matches: ![[filename.png]] or ![[filename.png | width]]
    // Group 1: filename, Group 2: width (optional)
    //
    // Unlike every other construct here, an image is NOT revealed by the cursor
    // being on it: it is an embedded object, selected and resized and deleted
    // as one, and the markdown behind it is not something the reader edits (see
    // imageWidget.ts). The single exception is a caret already strictly inside
    // — only reachable while typing the embed, which has to stay visible.
    const imageRegex = embedPattern();
    const selection = state.selection.main;
    let imageSelected = false;
    while ((match = imageRegex.exec(doc)) !== null) {
        const from = match.index;
        const to = from + match[0].length;
        const filename = match[1].trim();
        const width = match[2] ? parseInt(match[2].trim(), 10) : null;

        if (intersectsMath(from, to)) continue;
        // An embed written INSIDE code is being quoted, not embedded — a note
        // (the Help guide among them) documenting `![[picture.png]]` means the
        // text. It matters more here than for the other constructs: an image is
        // never revealed by the cursor and its range is atomic, so a quoted
        // embed rendered as a picture could not be read or edited back at all.
        if (codeRanges.some(r => from < r.to && to > r.from)) continue;
        if (editorMode !== 'read' && caretInsideRange(state, from, to)) continue;

        const selected = imageCtx.editable && selection.from === from && selection.to === to;
        imageSelected ||= selected;
        decorations.push(
            Decoration.replace({ widget: new ImageWidget(filename, width, imageCtx, selected) }).range(from, to)
        );
        // Only a rendered embed is atomic. The one being typed is plain text
        // for as long as the caret is in it, and has to stay steppable.
        atoms.push(ATOMIC.range(from, to));
    }

    // === WIKILINKS (Obsidian Syntax) ===
    // Matches: [[Note]], [[Note|alias]], [[Note#heading]]
    // The leading (!?) lets us skip image embeds ![[file.png]] (handled above).
    const wikiRegex = /(!?)\[\[([^\]\n]+?)\]\]/g;
    while ((match = wikiRegex.exec(doc)) !== null) {
        if (match[1] === '!') continue; // image embed, not a note link

        const from = match.index;
        const to = from + match[0].length;
        const inner = match[2];
        const pipeIndex = inner.indexOf('|');
        const target = (pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner).split('#')[0].trim();

        if (intersectsMath(from, to)) continue;
        // While editing, reveal the raw syntax when the cursor is inside it.
        if (editorMode !== 'read' && cursorInRange(state, from, to)) continue;

        const innerStart = from + 2;
        const innerEnd = to - 2;

        // Hide the surrounding [[ and ]].
        decorations.push(HIDE.range(from, innerStart));
        decorations.push(HIDE.range(innerEnd, to));

        const linkMark = wikiLinkMark(target);
        if (pipeIndex >= 0) {
            // Hide "target|" and show only the alias text.
            const pipePos = innerStart + pipeIndex;
            decorations.push(HIDE.range(innerStart, pipePos + 1));
            decorations.push(linkMark.range(pipePos + 1, innerEnd));
        } else {
            decorations.push(linkMark.range(innerStart, innerEnd));
        }
    }

    // === TABLES (GFM-style) ===
    // Match consecutive lines starting and ending with | that include a separator row
    const tableRegex = /(^\|.+\|[ \t]*\n)(^\|[\s:|-]+\|[ \t]*\n)((?:^\|.+\|[ \t]*\n?)+)/gm;
    while ((match = tableRegex.exec(doc)) !== null) {
        const from = match.index;
        const to = from + match[0].length;
        // Trim trailing newline from the range to avoid replacing it
        const trimmedTo = doc[to - 1] === '\n' ? to - 1 : to;

        if (editorMode !== 'read' && cursorInRange(state, from, trimmedTo)) continue;

        decorations.push(
            Decoration.replace({ widget: new TableWidget(match[0].trim()) }).range(from, trimmedTo)
        );
    }

    return {
        deco: Decoration.set(decorations, true),
        // Already in document order — the image scan is a single left-to-right pass.
        atoms: RangeSet.of(atoms),
        imageSelected,
    };
}

/**
 * Factory for creating the Live Preview CM6 extension.
 * Uses a StateField (not ViewPlugin) so that decorations are allowed
 * to replace ranges that span across line breaks (block math, images, code blocks).
 * Decorations are computed in update() and passively read via from() to avoid
 * viewport destabilization loops.
 */
import { StateField } from '@codemirror/state';

export function createLivePreviewPlugin(
    getAssetUrl: GetAssetUrl,
    editorMode: EditorMode,
    actions: ImageEmbedActions,
): Extension {
    // One per plugin instance, and compared by identity inside ImageWidget.eq —
    // which is why `getAssetUrl` and `actions` must themselves be stable for the
    // life of the pane (see EditorPane).
    const imageCtx: ImageContext = { getAssetUrl, actions, editable: editorMode !== 'read' };

    const field = StateField.define<LivePreview>({
        create(state: EditorState) {
            const viewShim = { state };
            return buildDecorations(viewShim, imageCtx, editorMode);
        },
        update(decorations: LivePreview, tr: Transaction) {
            // Markdown parses asynchronously: on a large document the tree only
            // covers a prefix when the file opens, and the parser keeps advancing
            // in idle time, dispatching otherwise-empty transactions as it goes.
            // Tree-derived decorations (headings, emphasis, code fences, links)
            // must rebuild on those, or everything past the initially-parsed
            // prefix stays raw until some other rebuild happens to fire.
            const treeAdvanced = syntaxTree(tr.state) !== syntaxTree(tr.startState);
            // In read mode, decorations are a pure function of the document — every
            // selection-dependent branch in buildDecorations is gated behind
            // editorMode !== 'read' — so skip rebuilds from selection-only changes.
            if (tr.docChanged || treeAdvanced || (tr.selection && editorMode !== 'read')) {
                const viewShim = { state: tr.state };
                return buildDecorations(viewShim, imageCtx, editorMode);
            }
            return decorations;
        },
        provide(field: StateField<LivePreview>) {
            return [
                EditorView.decorations.from(field, value => value.deco),
                // Makes each rendered image one indivisible step for the cursor:
                // arrow keys move over it rather than into it, a drag-selection
                // snaps to the whole embed, and a Backspace beside it takes the
                // embed with it instead of breaking the syntax into rubble.
                EditorView.atomicRanges.of(view => view.state.field(field, false)?.atoms ?? RangeSet.empty),
                // A selected picture wears its own ring, so the text-selection
                // band is turned off while one is selected — the selection is
                // the picture and nothing else, and the band would otherwise
                // show as a sliver past the widget (CodeMirror pads a replaced
                // range with zero-width buffer elements of its own).
                EditorView.editorAttributes.of(view =>
                    view.state.field(field, false)?.imageSelected ? { class: 'cm-image-selection' } : null),
            ];
        }
    });

    return [field, imageEmbedActions.of(actions), imageEmbedKeymap];
}

// The CodeMirror EditorView is created once and caches this decoration logic, so
// Vite's hot-update can't swap it in. Decline HMR for this module to force a full
// page reload on edit (dev-only — `import.meta.hot` is undefined in production).
if (import.meta.hot) {
    // `decline()` was removed from Vite's ViteHotContext type but remains a no-op
    // method on the runtime hot-context object, so the cast is type-only and the
    // emitted JS is unchanged.
    (import.meta.hot as unknown as { decline(): void }).decline();
}

