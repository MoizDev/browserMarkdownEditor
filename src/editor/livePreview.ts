import { EditorView, Decoration, keymap } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { EditorSelection, Prec, RangeSet, RangeValue } from '@codemirror/state';
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
import { cellAt, findTables, parseTableLayout } from './tableModel';
import { focusTableCell, tableDomAt } from './tableEdit';
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

/* ── Following an external link ───────────────────────────────────────────
 *
 * In READING mode the three outward-pointing link forms — `[label](url)`,
 * `<url>` and a bare `https://…` — are marked up as real <a> elements, so a
 * click is the browser's own navigation and the affordances that come with it
 * (⌘-click, middle-click, the status-bar preview) work without this app
 * implementing any of them. One is missing rather than declined: this pane
 * preventDefaults `contextmenu` to raise the app's own menu, which has no "Copy
 * link address" row yet. Adding one there is what closes that gap.
 *
 * Editing mode keeps the plain span it has always had: there, contenteditable
 * owns the click, and a link is text being written rather than a target being
 * followed.
 *
 * The destination is therefore the whole of the security story, and it is not
 * a theoretical one: this origin holds the vault's directory handle with
 * permission already granted, so a `javascript:` href in someone else's note
 * would run with read/write over every file in the vault, and a page opened
 * without `noopener` gets a window handle on that same origin. Everything below
 * restates only what is specific to it; this is the premise under all of it.
 */
const SAFE_PROTOCOLS = new Set(['https:', 'http:', 'mailto:', 'tel:']);
/** CommonMark's `<a@b.com>` and GFM's bare `a@b.com` both mean `mailto:`. The
 *  colon exclusion is load-bearing: `mailto:a@b.com` satisfies every other part
 *  of this shape, and would otherwise be handed a second `mailto:`. */
const BARE_EMAIL = /^[^\s@<>:]+@[^\s@<>:]+\.[^\s@<>]+$/;
/** GFM autolinks a bare `www.` host too, with the scheme left implicit. Nothing
 *  schemed can start with `www.`, so this is safe to test before the parse. */
const BARE_WWW = /^www\.[^\s<>]+$/i;

/**
 * The href to hand the reader, or null for anything that must stay inert text.
 *
 * The check IS the parse, and that is the whole design. Chromium drops tab, LF
 * and CR from a URL before reading its scheme, so `java<LF>script:` navigates as
 * `javascript:` while the document text shows no such scheme — so any test that
 * reads one string and links another is wrong for that entire class of input,
 * not just for the characters someone remembered to strip. `new URL()` runs the
 * same WHATWG parse the navigator will, and the href handed on is the one it
 * produced, so the two cannot disagree. It normalizes on the way through — a
 * bare origin gains its trailing slash, a space becomes %20 — which is
 * invisible in the note and correct in the status bar.
 *
 * Relative destinations (`notes/other.md`, `#heading`, `../x`) have no scheme
 * and throw here, which is the wanted answer rather than an accident: an <a>
 * pointing at one navigates the single-page app itself away, taking the vault's
 * granted directory handle with it. `[[wikilinks]]` are this app's in-app link
 * and have their own click path in DocumentPane; a relative path has no handler
 * at all, so it is left looking exactly as it did before.
 */
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

/* Cached by href for the same reason wikilinks are cached by target: one note
   repeats a handful of destinations, and the key space accumulates only across
   documents opened in a session (see DEC_CACHE_MAX above). */
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

/** The mark a link's visible text wears: a real anchor when the destination is
 *  one a reader can safely be sent to, and the inert accent styling otherwise. */
function linkTextMark(state: EditorState, url: SyntaxNode | null, readMode: boolean): Decoration {
    if (!readMode || !url) return LINK_MARK;
    // CommonMark allows an angle-bracket wrapper on the destination: [a](<b c>).
    const dest = state.doc.sliceString(url.from, url.to).replace(/^<([^]*)>$/, '$1');
    const href = externalHref(dest);
    return href ? externalLinkMark(href) : LINK_MARK;
}

/** The nodes that own a `URL` child and decorate it themselves. One list,
 *  because the bare-URL branch's exclusion test and the branches that handle
 *  those nodes are the same fact stated twice: a fourth wrapper form reaching
 *  only one of them decorates a URL twice, or silently stops linking it. */
const URL_WRAPPERS = new Set(['Link', 'Autolink', 'Image', 'LinkReference']);

/**
 * Is this node somewhere inside a `[label](url)` — i.e. under a link that has
 * already decided where a click on it goes?
 *
 * The companion to URL_WRAPPERS, and the reason it is not enough on its own.
 * A link's label wears ONE mark for its whole width — a real `<a>` in reading
 * mode — and nothing beneath it may mint a second, because a nested anchor
 * takes its href from the LABEL TEXT: `[click here <https://evil.example>](https://good.example)`
 * renders the destination the reader was shown, wrapped around an anchor to the
 * one the label chose, and a click lands on the INNER one. That is exactly the
 * substitution the scheme allowlist and URL_WRAPPERS exist to prevent, arriving
 * through the door neither watches — `Autolink` is not a `URL`, so URL_WRAPPERS
 * never sees it. (An HTML parser refuses to nest two `<a>`s; CodeMirror builds
 * decorations with createElement, so here they really do nest. Verified.)
 *
 * ANCESTORS, not `node.parent`: an autolink or a bare URL can sit under an
 * Emphasis under the Link — `[a **<https://evil.example>** b](https://good.example)`
 * — and a parent-only test reads `StrongEmphasis` and waves it through. The walk
 * is a handful of steps up a shallow inline tree and runs only on the two link
 * branches, so a document with no autolinks in it pays nothing for this.
 *
 * ANY `Link` ancestor counts, including one whose own destination was rejected
 * or never parsed (a reference link, `[a <url> b][ref]`). That costs a clickable
 * URL in a construct nobody writes, and buys a rule with no exceptions in it: a
 * URL inside a link's label is never separately followable. The narrower version
 * would have to re-derive, at every ancestor, whether that link ended up wearing
 * an anchor — which is the kind of condition that drifts out of step with the
 * branch it is mirroring.
 */
function insideLinkLabel(node: SyntaxNode): boolean {
    for (let p = node.parent; p; p = p.parent) {
        if (p.name === 'Link') return true;
    }
    return false;
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

/** What the live-preview field holds: the decorations to draw, the image and
 *  table ranges the cursor must treat as atomic, where the rendered tables are
 *  (so the entry keymap and the adoption rule can find one beside the caret),
 *  and whether an object of either kind is the selection. All of it comes out
 *  of one pass. */
interface LivePreview {
    deco: DecorationSet;
    atoms: RangeSet<AtomicRange>;
    imageSelected: boolean;
    tables: readonly { from: number; to: number }[];
    tableSelected: boolean;
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
    // The same question asked of code, named for the same reason: four regex
    // passes below need it, and a hand-copied half-open comparison at each is
    // how the copies drift apart. The highlight pass is the evidence — it never
    // had a copy at all, so `==x==` inside backticks rendered as a highlight and
    // no note could print the syntax it was documenting. The table pass keeps
    // its own CONTAINMENT test: a different question, and it says so where it
    // asks it.
    const intersectsCode = (a: number, b: number) => codeRanges.some(r => a < r.to && b > r.from);

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

            // === LINKS: [label](url) ===
            if (name === 'Link') {
                if (editorMode !== 'read' && cursorInRange(state, from, to)) return;

                // Geometry comes from the tree, not from a regex over the node's
                // text. The regex this replaced was /^\[([^\]]*)\]\(([^)]*)\)$/,
                // which a destination containing a parenthesis could not match —
                // so a Wikipedia link, `[Foo](https://en.wikipedia.org/wiki/Foo_(bar))`,
                // stayed raw markdown even in reading mode. A title was mangled
                // the other way: match[2] on `[t](url "T")` was `url "T"`, which
                // would become a broken href the moment anything read it.
                //
                // The LinkMark children are `[ ] ( )` in document order. All
                // four means a real destination group; fewer means there is
                // none at all — a reference link (`[a][ref]`), a shortcut link
                // (`[a]`), or the stray Link that `[[wikilink]]` parses into —
                // and each is left to whatever really owns it. Counting the
                // marks is what the old regex's `\]\(` was testing for.
                const marks = node.node.getChildren('LinkMark');
                if (marks.length < 4) return;

                const linkTextStart = from + 1;    // after [
                const linkTextEnd = marks[1].from; // the ] closing the label
                // A mark decoration may not be empty, and hiding both sides of
                // an empty one would erase `[](url)` from the view outright.
                // Showing it as written is the honest failure.
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

                // Hide [
                decorations.push(HIDE.range(from, linkTextStart));
                // Hide ](url)
                decorations.push(HIDE.range(linkTextEnd, to));
                // Style link text — and, in reading mode, make it a real anchor.
                decorations.push(linkTextMark(state, url, editorMode === 'read').range(linkTextStart, linkTextEnd));

                // DESCEND — the label is inline Markdown like any other run of
                // text, and `[a **b** c](url)` showed its literal asterisks for
                // as long as this branch returned false. The parser had already
                // built the StrongEmphasis node; the walk simply never reached
                // it. `return` hands the label's children to the same emphasis /
                // strikethrough / inline-code branches above, so a label formats
                // exactly as the same text would outside a link.
                //
                // Three things make descending safe rather than merely tempting,
                // and each is worth knowing before touching this:
                //
                //  1. The tail `](url)` is walked too, and must decorate NOTHING
                //     — it sits under the HIDE just pushed, so anything drawn
                //     there is invisible work at best. It decorates nothing
                //     because `LinkMark` and `LinkTitle` have no branch, and the
                //     destination `URL` is excluded by URL_WRAPPERS, which lists
                //     `Link` precisely so a URL its wrapper already handled is
                //     not handled twice.
                //  2. Nothing under the label may mint a SECOND anchor, because
                //     a nested one takes its href from the label text and is the
                //     one a click actually lands on. A label can hold exactly
                //     two things that would: a bare `URL`, which GFM autolinks
                //     as a direct child, and an `Autolink`. `URL_WRAPPERS` stops
                //     the first where it sits; `insideLinkLabel` stops both
                //     wherever they sit, including under an emphasis, which is
                //     the case a `node.parent` test waves through. A `Link`
                //     cannot nest inside a `Link` at all — the outer one simply
                //     does not parse — so there is no third.
                //  3. The hidden `**` markers land strictly inside the label's
                //     own mark. A replace nested in a mark is ordinary for
                //     CodeMirror (the mark simply wraps the pieces either side),
                //     and the emphasis branches place their marks on the INNER
                //     text only, so nothing here overlaps a hide.
                //
                // Edit mode already proved the shape: the revealed-by-caret
                // early return above is a plain `return`, so a link under the
                // caret has descended into its label since before this branch
                // used the tree at all. The cost is measured, not assumed: five
                // extra `enter` calls for a plain link, eight for a bolded one,
                // fifteen for the worst realistic label — purely additive, with
                // no per-node scan, on a walk that already visits every node in
                // the document.
                return;
            }

            // === ANGLE AUTOLINKS: <https://example.com> ===
            // CommonMark's bracketed form. The angle brackets are syntax like
            // any other, so they hide once the caret leaves — the URL itself is
            // already the label, so nothing else changes.
            if (name === 'Autolink') {
                if (editorMode !== 'read' && cursorInRange(state, from, to)) return;

                const url = node.node.getChild('URL');
                if (!url) return;

                decorations.push(HIDE.range(from, url.from));
                decorations.push(HIDE.range(url.to, to));
                // Inside a link's LABEL the angle brackets still hide — that is
                // cosmetic and harmless — but no anchor is minted, because the
                // enclosing link already owns the click. See insideLinkLabel:
                // the nested `<a>` would be the one a reader actually followed,
                // with an href the label picked.
                const anchor = editorMode === 'read' && !insideLinkLabel(node.node);
                decorations.push(linkTextMark(state, url, anchor).range(url.from, url.to));

                return false;
            }

            // === BARE URLS: https://example.com, www.example.com, a@b.com ===
            // What GFM's autolinker leaves on running prose: a URL node with no
            // wrapper of any kind. `Autolink` returns false above once it has a
            // URL child, and `Link` DESCENDS into its label — where GFM leaves a
            // bare URL as a direct child of the Link itself — so both a wrapper's
            // own URL and a label's stray one arrive here and must be declined.
            if (name === 'URL') {
                // Nothing to hide and nothing to reveal, so edit mode is left
                // exactly as it was: bare text the syntax highlighter colours —
                // and the guard comes first, so a URL-dense note pays nothing
                // per keystroke for a branch that would do nothing anyway.
                if (editorMode !== 'read') return false;
                if (URL_WRAPPERS.has(node.node.parent?.name ?? '')) return false;
                // The parent test above catches a URL sitting DIRECTLY under the
                // link; this catches `[a **https://evil.example** b](https://good.example)`,
                // where the parent it reads is `StrongEmphasis`. Same rule, one
                // level further out — see insideLinkLabel.
                if (insideLinkLabel(node.node)) return false;

                const href = externalHref(state.doc.sliceString(from, to));
                if (href) decorations.push(externalLinkMark(href).range(from, to));
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
            if (intersectsCode(from, to)) continue;
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
        // The third regex pass that has to re-derive by hand what the parser
        // already knows: Lezer does not inline-parse inside a code span, so the
        // TREE branches get code-skipping for free, but a regex over the raw
        // text does not and matches straight through the backticks. Without
        // this, `==x==` written in code rendered as a highlight — so the one
        // note that most needs to print the syntax, the Help guide's own
        // Markdown reference, was the one note that could not.
        if (intersectsCode(from, to)) continue;
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
    const editable = editorMode !== 'read';
    let imageSelected = false;
    const tables: { from: number; to: number }[] = [];
    let tableSelected = false;
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
        if (intersectsCode(from, to)) continue;
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
        // A wikilink written inside code is being QUOTED, not linked — the same
        // rule the image pass above applies, and for a weaker but real version
        // of the same reason: a note documenting the syntax (the Help guide is
        // one) would otherwise show the rendered link where the brackets it is
        // explaining ought to be, and the reader is never shown what to type.
        if (intersectsCode(from, to)) continue;
        // While editing, reveal the raw syntax when the cursor is inside it.
        if (editorMode !== 'read' && cursorInRange(state, from, to)) continue;

        const innerStart = from + 2;
        const innerEnd = to - 2;

        // Hide the surrounding [[ and ]].
        decorations.push(HIDE.range(from, innerStart));
        decorations.push(HIDE.range(innerEnd, to));

        const mark = wikiLinkMark(target);
        if (pipeIndex >= 0) {
            // Hide "target|" and show only the alias text.
            const pipePos = innerStart + pipeIndex;
            decorations.push(HIDE.range(innerStart, pipePos + 1));
            decorations.push(mark.range(pipePos + 1, innerEnd));
        } else {
            decorations.push(mark.range(innerStart, innerEnd));
        }
    }

    // === TABLES (GFM-style) ===
    // A rendered table is an OBJECT, like an embedded image: never revealed by
    // the cursor, atomic, and edited through its own contenteditable cells (see
    // tableWidget.ts and tableEdit.ts). It has no equivalent of the image's
    // typing exception, because a table cannot half-exist — the pattern needs
    // three complete lines — so entry is an explicit keymap plus a caret
    // adoption rule instead (tableEntryKeymap / tableAdoptListener below).
    //
    // findTables returns only spans parseGrid accepts, and that is what keeps
    // the atom below and the editable widget in step: an atomic, never-revealed
    // range with no contenteditable cell in it would be a block of the user's
    // own text with no way to put a caret in it at all.
    for (const span of findTables(doc)) {
        // A table written inside code is being QUOTED, not tabulated — and it
        // matters more here than for any other construct, exactly as it does
        // for images: an object that is never revealed and whose range is
        // atomic could not be read or edited back out of a fence at all.
        //
        // CONTAINMENT, not the image pass's intersection test above.
        // collectCodeRanges also collects InlineCode, and a table spans several
        // lines — so an intersection test would reject any table with one
        // `code` span in one cell. A fence contains the whole table; an inline
        // span inside a cell never can.
        if (codeRanges.some(r => r.from <= span.from && r.to >= span.to)) continue;
        // No math guard, deliberately: overlapsMath is an intersection too, so
        // it would reject any table containing $x$, and a containment version
        // could only fire for a table wholly inside a math region, which cannot
        // occur. Adding nothing is exactly today's behaviour.
        const selected = editable && selection.from === span.from && selection.to === span.to;
        tableSelected ||= selected;
        decorations.push(
            Decoration.replace({
                widget: new TableWidget(doc.slice(span.from, span.to), editable, selected),
            }).range(span.from, span.to)
        );
        atoms.push(ATOMIC.range(span.from, span.to));
        tables.push(span);
    }

    return {
        deco: Decoration.set(decorations, true),
        // SORTED: images and tables are each a left-to-right pass, but tables
        // are appended after images, so the two runs interleave in the document
        // and the combined array is not in order. (This comment used to say the
        // opposite and was right at the time — it is exactly the kind of stale
        // claim that would make a later reader delete the `true`.)
        atoms: RangeSet.of(atoms, true),
        imageSelected,
        tables,
        tableSelected,
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
                // A selected object wears its own ring, so the text-selection
                // band is turned off while one is selected — the selection is
                // the picture (or the table) and nothing else, and the band
                // would otherwise show as a sliver past the widget (CodeMirror
                // pads a replaced range with zero-width buffer elements of its
                // own). The class covers both kinds; renaming it would touch
                // three files for nothing.
                EditorView.editorAttributes.of(view => {
                    const value = view.state.field(field, false);
                    return value && (value.imageSelected || value.tableSelected)
                        ? { class: 'cm-image-selection' }
                        : null;
                }),
            ];
        }
    });

    return [
        field,
        imageEmbedActions.of(actions),
        imageEmbedKeymap,
        tableEntryKeymap(field),
        tableAdoptListener(field),
    ];
}

/* ── Getting into (and out of) a table ────────────────────────────────────
 *
 * A table's range is atomic, so CodeMirror's own motion parks the caret on its
 * `from` or its `to` and never strictly inside — in both axes, moveVertically
 * included. That is exactly what we want for stepping OVER one; entering it is
 * therefore a separate, deliberate act, and these two extensions are the two
 * halves of it.
 */

/** The house predicate for "may this document be written to" — see tableEdit's
 *  canWrite. EditorState.readOnly is never set anywhere in src/. */
function writable(state: EditorState): boolean {
    return !state.readOnly && state.facet(EditorView.editable);
}

/** The one empty caret, or null — every binding below wants exactly that. */
function loneCaret(state: EditorState): number | null {
    const { ranges, main } = state.selection;
    if (ranges.length !== 1 || !main.empty) return null;
    return main.head;
}

function tablesIn(view: EditorView, field: StateField<LivePreview>): readonly { from: number; to: number }[] {
    return view.state.field(field, false)?.tables ?? [];
}

/** Put the caret in a cell of the table drawn at `from`, choosing the column
 *  from an x coordinate so vertical motion feels continuous. */
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
    // The column under the caret's own x, so arrowing down lands where the eye
    // expects rather than always in the first cell.
    let col = 0;
    for (let i = 0; i < layout.columns; i++) {
        const cell = dom.querySelector(`.cm-table-cell[data-row="${row}"][data-col="${i}"]`);
        const rect = cell?.getBoundingClientRect();
        if (rect && x >= rect.left) col = i;
    }
    return focusTableCell(dom, row, col, { x });
}

/**
 * ArrowDown / ArrowUp / ArrowRight / ArrowLeft beside a table step INTO it.
 *
 * Prec.high so it runs before the default keymap, and every branch returns
 * false unless the caret is exactly on a table's edge — so ordinary motion is
 * untouched. Backspace and Delete are here too: the range is atomic, so
 * @codemirror/commands would widen through the whole table and swallow it in
 * one keystroke with nothing to show for it. Selecting it first is the same
 * "a click selects the object" treatment a picture gets; a second press then
 * deletes the selection through the default command.
 */
function tableEntryKeymap(field: StateField<LivePreview>): Extension {
    /**
     * Would an ordinary ArrowDown/ArrowUp leave this LOGICAL line?
     *
     * `lineWrapping` is on, so a paragraph is usually several visual rows and a
     * logical line above a table may be three of them. Testing the logical line
     * alone made ↓ from the first row of such a paragraph jump straight into
     * the table, skipping two rows of the user's own text with no way back to
     * them from above. `moveVertically` is visual-line aware, so asking it
     * where the caret would actually go answers the question exactly.
     *
     * Deliberately NOT "does it land on the table's edge": moveVertically runs
     * through skipAtoms, and skipAtomicRanges (@codemirror/view:3690-3705) moves
     * a position strictly inside an atomic range to its FAR side — `to` when
     * moving down (bias +1, :3729-3732) — so a downward move over a table
     * reports `table.to`, never `table.from`. Whether it leaves the line is the
     * robust question; where the skip parks is not.
     */
    const leavesLine = (view: EditorView, pos: number, forward: boolean): boolean => {
        const line = view.state.doc.lineAt(pos);
        const target = view.moveVertically(EditorSelection.cursor(pos), forward).head;
        return forward ? target > line.to : target < line.from;
    };

    const enterFromLineAbove = (view: EditorView): boolean => {
        if (!writable(view.state)) return false;
        const pos = loneCaret(view.state);
        if (pos === null) return false;
        const line = view.state.doc.lineAt(pos);
        if (line.number >= view.state.doc.lines) return false;
        const next = view.state.doc.line(line.number + 1).from;
        const table = tablesIn(view, field).find(t => t.from === next);
        if (!table || !leavesLine(view, pos, true)) return false;
        return enterTable(view, table.from, 'first', view.coordsAtPos(pos)?.left ?? null);
    };

    const enterFromLineBelow = (view: EditorView): boolean => {
        if (!writable(view.state)) return false;
        const pos = loneCaret(view.state);
        if (pos === null) return false;
        const line = view.state.doc.lineAt(pos);
        if (line.number <= 1) return false;
        const previous = view.state.doc.line(line.number - 1).to;
        const table = tablesIn(view, field).find(t => t.to === previous);
        if (!table || !leavesLine(view, pos, false)) return false;
        return enterTable(view, table.from, 'last', view.coordsAtPos(pos)?.left ?? null);
    };

    const enterFromEdge = (view: EditorView, side: 'from' | 'to'): boolean => {
        if (!writable(view.state)) return false;
        const pos = loneCaret(view.state);
        if (pos === null) return false;
        const table = tablesIn(view, field).find(t => (side === 'from' ? t.from : t.to) === pos);
        if (!table) return false;
        return enterTable(view, table.from, side === 'from' ? 'first' : 'last', null);
    };

    const selectBeside = (view: EditorView, side: 'from' | 'to'): boolean => {
        if (!writable(view.state)) return false;
        const pos = loneCaret(view.state);
        // Already exactly a table? Then this is the second press: let the
        // default command delete the selection.
        if (pos === null) return false;
        const table = tablesIn(view, field).find(t => (side === 'to' ? t.to : t.from) === pos);
        if (!table) return false;
        view.dispatch({ selection: EditorSelection.single(table.from, table.to) });
        return true;
    };

    return Prec.high(keymap.of([
        { key: 'ArrowDown', run: enterFromLineAbove },
        { key: 'ArrowUp', run: enterFromLineBelow },
        { key: 'ArrowRight', run: view => enterFromEdge(view, 'from') },
        { key: 'ArrowLeft', run: view => enterFromEdge(view, 'to') },
        { key: 'Backspace', run: view => selectBeside(view, 'to') },
        { key: 'Delete', run: view => selectBeside(view, 'from') },
    ]));
}

/**
 * The caret ended up somewhere a keypress could not have put it — adopt it into
 * the cell it belongs in.
 *
 * Two jobs, and they are both narrow.
 *
 *  (a) A caret STRICTLY INSIDE a rendered table. Atomic ranges close every
 *      motion path CodeMirror runs through skipAtoms, but moveToLineBoundary —
 *      Home/End with line wrapping on — is not one of them, and an undo or a
 *      programmatic dispatch can leave a caret anywhere.
 *  (b) A table TYPED INTO EXISTENCE. The pattern's last body row may have no
 *      trailing newline, so after typing the closing `|` the caret sits exactly
 *      on the new table's `to`. Left alone the next character lands after that
 *      pipe, the row stops matching, and the table flips back to source — a
 *      render/de-render flicker per keystroke. Adopting into the last cell
 *      removes it, and is what "as soon as it renders, keep typing in it" means.
 *      It waits for the row to be COMPLETE, though — see the check below, and
 *      the file the early version wrote.
 *
 * Boundaries are otherwise never adopted, because `from` and `to` are exactly
 * where every documented way OUT of a table parks the caret. That is why (b) is
 * gated on `input.type`, which excludes a paste (criterion: the caret is left
 * after a pasted table, not trapped in it) and every write this feature makes.
 *
 * Legal to dispatch from here: updateListener handlers run after CodeMirror has
 * reset updateState to Idle, unlike updateDOM and destroy.
 */
function tableAdoptListener(field: StateField<LivePreview>): Extension {
    return EditorView.updateListener.of((update) => {
        const { view } = update;
        // hasFocus requires the contentDOM to be the active element, so this is
        // also what keeps the listener out of the way while a cell is focused —
        // including the moment right after a write-back, when Chromium has
        // blurred the cell to BODY and the repair has not run yet.
        if (!view.hasFocus || !writable(view.state)) return;
        const tables = view.state.field(field, false)?.tables ?? [];
        if (tables.length === 0) return;
        const pos = loneCaret(view.state);
        if (pos === null) return;

        for (const table of tables) {
            if (pos <= table.from || pos >= table.to) continue;
            const dom = tableDomAt(view, table.from);
            const layout = dom ? parseTableLayout(view.state.doc, table.from) : null;
            const cell = layout ? cellAt(layout, pos) : null;
            if (dom && cell) focusTableCell(dom, cell.row, cell.col, 'end');
            return;
        }

        if (!update.transactions.some(tr => tr.isUserEvent('input.type'))) return;
        const insertionEnds = new Set<number>();
        for (const tr of update.transactions) {
            tr.changes.iterChanges((_fromA, _toA, _fromB, toB) => { insertionEnds.add(toB); });
        }
        for (const table of tables) {
            if (pos !== table.to || !insertionEnds.has(table.to)) continue;
            const dom = tableDomAt(view, table.from);
            const layout = dom ? parseTableLayout(view.state.doc, table.from) : null;
            const lastRow = layout?.rows[layout.rows.length - 1];
            // ...and only once that row is FINISHED. The pattern's body group is
            // `(?:^\|.+\|[ \t]*\n?)+`, so a body row matches as soon as it has
            // ONE cell: typing `| a | b |` ⏎ `| --- | --- |` ⏎ `| c | d |` makes
            // a table at the `|` after `c`, two keystrokes early. Adopting there
            // pulled the caret into the empty last cell, and the user's own
            // closing `|` was then a keystroke INSIDE a cell — correctly escaped
            // (criterion 8) and written to the file as `| c | d \| |`. Measured,
            // 4/4. A row whose segments have not reached the header's column
            // count is still being typed, so the caret is left in the document
            // and adoption waits for the keystroke that really does finish it —
            // which is exactly what "the moment the third line completes" means.
            if (dom && layout && lastRow && lastRow.cells.length >= layout.columns) {
                focusTableCell(dom, layout.rows.length - 1, layout.columns - 1, 'end');
            }
            return;
        }
    });
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

