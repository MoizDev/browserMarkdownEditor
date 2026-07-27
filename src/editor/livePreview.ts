import { EditorView, Decoration } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range, Transaction } from '@codemirror/state';
import type { EditorMode } from '../types';
import { MathWidget } from './mathWidget';
import { analyzeDoc, firstMathFrom, overlapsMath, latexSourceDecorations } from './latexSource';
import { CopyCodeWidget } from './copyCodeWidget';
import { HorizontalRuleWidget } from './hrWidget';
import { ImageWidget } from './imageWidget';
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

const listLineCache = new Map<string, Decoration>();
function listLine(kind: 'raw' | 'bullet' | 'ordered', indent: number, marker?: string): Decoration {
    const key = `${kind}\n${indent}\n${marker ?? ''}`;
    let dec = listLineCache.get(key);
    if (!dec) {
        const style = `--list-indent: ${indent}`;
        dec = kind === 'raw'
            ? Decoration.line({ class: 'cm-live-list-item cm-live-list-raw', attributes: { style } })
            : kind === 'ordered'
                ? Decoration.line({
                    class: 'cm-live-list-item cm-live-list-ordered',
                    attributes: { 'data-marker': marker!, style },
                })
                : Decoration.line({ class: 'cm-live-list-item cm-live-list-bullet', attributes: { style } });
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
function buildDecorations(view: StateView, getAssetUrl: GetAssetUrl, editorMode: EditorMode): DecorationSet {
    const { state } = view;
    const decorations: Range<Decoration>[] = [];

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
                const cursorOnThisLine = editorMode !== 'read' && cursorOnLine(state, from, to);

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

                const isOrdered = node.node.parent?.name === 'OrderedList';
                const lineText = line.text;
                const markerMatch = lineText.match(/^(\s*)([-*]|\d+[.)]) /);

                if (cursorOnThisLine) {
                    // Raw mode: keep the `- ` / `1. ` visible so the user edits real markdown,
                    // but preserve the nested indent via padding so the line doesn't jump left.
                    // Leading whitespace hides only when the cursor isn't inside it, so
                    // dedent edits (Backspace/Shift-Tab) stay visible while in progress.
                    if (markerMatch && markerMatch[1].length > 0) {
                        const wsFrom = line.from;
                        const wsTo = line.from + markerMatch[1].length;
                        if (!cursorInRange(state, wsFrom, wsTo)) {
                            decorations.push(HIDE.range(wsFrom, wsTo));
                        }
                    }
                    decorations.push(listLine('raw', indent).range(line.from));
                } else {
                    // Rendered mode: hide the full marker and show the styled bullet/number.
                    if (markerMatch) {
                        const prefixLen = markerMatch[0].length;
                        decorations.push(HIDE.range(line.from, line.from + prefixLen));
                    }

                    if (isOrdered) {
                        const numMatch = lineText.match(/^\s*(\d+)[.)] /);
                        const num = numMatch ? numMatch[1] : '1';
                        decorations.push(listLine('ordered', indent, num + '.').range(line.from));
                    } else {
                        decorations.push(listLine('bullet', indent).range(line.from));
                    }
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
    const imageRegex = /!\[\[([^\]|]+)(?:\s*\|\s*(\d+))?\]\]/g;
    while ((match = imageRegex.exec(doc)) !== null) {
        const from = match.index;
        const to = from + match[0].length;
        const filename = match[1].trim();
        const width = match[2] ? parseInt(match[2].trim(), 10) : null;

        if (intersectsMath(from, to)) continue;
        if (editorMode !== 'read' && cursorInRange(state, from, to)) continue;

        decorations.push(
            Decoration.replace({ widget: new ImageWidget(filename, width, getAssetUrl) }).range(from, to)
        );
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

    return Decoration.set(decorations, true);
}

/**
 * Factory for creating the Live Preview CM6 extension.
 * Uses a StateField (not ViewPlugin) so that decorations are allowed
 * to replace ranges that span across line breaks (block math, images, code blocks).
 * Decorations are computed in update() and passively read via from() to avoid
 * viewport destabilization loops.
 */
import { StateField } from '@codemirror/state';

export function createLivePreviewPlugin(getAssetUrl: GetAssetUrl, editorMode: EditorMode): StateField<DecorationSet> {
    const field = StateField.define<DecorationSet>({
        create(state: EditorState) {
            const viewShim = { state };
            return buildDecorations(viewShim, getAssetUrl, editorMode);
        },
        update(decorations: DecorationSet, tr: Transaction) {
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
                return buildDecorations(viewShim, getAssetUrl, editorMode);
            }
            return decorations;
        },
        provide(field: StateField<DecorationSet>) {
            return EditorView.decorations.from(field);
        }
    });
    return field;
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

