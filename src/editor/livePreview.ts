import { EditorView, Decoration } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range, Transaction } from '@codemirror/state';
import type { EditorMode } from '../types';
import { MathWidget } from './mathWidget';
import { findMathRegions, latexSourceDecorations, collectCodeRanges } from './latexSource';
import { CopyCodeWidget } from './copyCodeWidget';
import { HorizontalRuleWidget } from './hrWidget';
import { ImageWidget } from './imageWidget';
import { TableWidget } from './tableWidget';
import { MermaidWidget } from './mermaidWidget';

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
    const doc = state.doc.toString();

    // Math is located BEFORE the markdown pass so formula innards can be
    // exempted from markdown styling — "[x](y)" inside an equation is LaTeX,
    // not a link. Code ranges come first: a $ inside code is literal.
    const codeRanges = collectCodeRanges(state);
    const mathRegions = findMathRegions(doc, codeRanges);
    const intersectsMath = (a: number, b: number) => mathRegions.some(r => a < r.to && b > r.from);

    syntaxTree(state).iterate({
        enter(node) {
            const { type, from, to } = node;
            const name = type.name;

            // A markdown construct inside (or straddling) a math region is
            // really LaTeX — skip it. Nodes that CONTAIN the whole region
            // (paragraph, list item, heading line…) still process normally.
            for (const r of mathRegions) {
                if (from < r.to && to > r.from && !(from <= r.from && to >= r.to)) return false;
            }

            // === HEADINGS ===
            // ATXHeading1 through ATXHeading6
            if (name.startsWith('ATXHeading') && name.length === 11) {
                const level = parseInt(name[10], 10);
                if (!level || level < 1 || level > 6) return;

                const line = state.doc.lineAt(from);

                // Always style the entire heading line so it retains its size
                decorations.push(
                    Decoration.line({ class: `cm-live-heading cm-live-heading-${level}` }).range(line.from)
                );

                // If editing and cursor is on the line, let the raw prefix `# ` show
                if (editorMode !== 'read' && cursorOnLine(state, from, to)) return;

                const headerText = line.text;
                const hashEnd = headerText.indexOf(' ') + 1; // position after "# "

                if (hashEnd > 0) {
                    // Hide the "# " prefix
                    decorations.push(
                        Decoration.replace({}).range(line.from, line.from + hashEnd)
                    );
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
                decorations.push(Decoration.replace({}).range(from, to));
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
                const cls = name === 'StrongEmphasis' ? 'cm-live-bold' : 'cm-live-italic';
                const innerFrom = node.node.firstChild ? node.node.firstChild.to : from;
                const innerTo = node.node.lastChild ? node.node.lastChild.from : to;
                if (innerTo > innerFrom) {
                    decorations.push(Decoration.mark({ class: cls }).range(innerFrom, innerTo));
                }
                return;
            }

            // === STRIKETHROUGH ===
            if (name === 'Strikethrough') {
                if (editorMode !== 'read' && cursorInRange(state, from, to)) return;

                decorations.push(Decoration.replace({}).range(from, from + 2));
                decorations.push(Decoration.replace({}).range(to - 2, to));
                decorations.push(
                    Decoration.mark({ class: 'cm-live-strikethrough' }).range(from + 2, to - 2)
                );

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
                    decorations.push(
                        Decoration.mark({ class: 'cm-live-code' }).range(from + openTicks, to - closeTicks)
                    );
                }

                if (editorMode !== 'read' && cursorInRange(state, from, to)) return false;

                decorations.push(Decoration.replace({}).range(from, from + openTicks));
                decorations.push(Decoration.replace({}).range(to - closeTicks, to));

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
                    let cls = 'cm-live-codeblock';
                    if (i === startLine.number) cls += ' cm-live-codeblock-start';
                    if (i === endLine.number) cls += ' cm-live-codeblock-end';
                    decorations.push(Decoration.line({ class: cls }).range(line.from));
                }

                // Editing anywhere in the block reveals the ``` fences (like a
                // heading's `#`), but the panel above stays put.
                if (editorMode !== 'read' && cursorOnLine(state, from, to)) return;

                // Hide the fence lines outright: the opening one (e.g.
                // ```javascript) and — only if the block is closed — the last.
                if (startLine.text.trim().startsWith('```')) {
                    decorations.push(Decoration.replace({}).range(startLine.from, startLine.to));
                }
                if (closed) {
                    decorations.push(Decoration.replace({}).range(endLine.from, endLine.to));
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
                decorations.push(Decoration.replace({}).range(from, from + 1));
                // Hide ](url)
                decorations.push(Decoration.replace({}).range(linkTextEnd, to));
                // Style link text
                decorations.push(
                    Decoration.mark({ class: 'cm-live-link' }).range(linkTextStart, linkTextEnd)
                );

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
                        decorations.push(Decoration.replace({}).range(line.from, line.from + quotePrefix[0].length));
                    }
                    // Style the line
                    decorations.push(
                        Decoration.line({ class: 'cm-live-blockquote' }).range(line.from)
                    );
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
                            decorations.push(Decoration.replace({}).range(wsFrom, wsTo));
                        }
                    }
                    decorations.push(
                        Decoration.line({
                            class: 'cm-live-list-item cm-live-list-raw',
                            attributes: { style: `--list-indent: ${indent}` }
                        }).range(line.from)
                    );
                } else {
                    // Rendered mode: hide the full marker and show the styled bullet/number.
                    if (markerMatch) {
                        const prefixLen = markerMatch[0].length;
                        decorations.push(Decoration.replace({}).range(line.from, line.from + prefixLen));
                    }

                    if (isOrdered) {
                        const numMatch = lineText.match(/^\s*(\d+)[.)] /);
                        const num = numMatch ? numMatch[1] : '1';
                        decorations.push(
                            Decoration.line({
                                class: 'cm-live-list-item cm-live-list-ordered',
                                attributes: { 'data-marker': num + '.', style: `--list-indent: ${indent}` }
                            }).range(line.from)
                        );
                    } else {
                        decorations.push(
                            Decoration.line({
                                class: 'cm-live-list-item cm-live-list-bullet',
                                attributes: { style: `--list-indent: ${indent}` }
                            }).range(line.from)
                        );
                    }
                }

                // Don't return false — let children (emphasis, code, etc.) still be processed
            }

            // === HORIZONTAL RULE ===
            if (name === 'HorizontalRule') {
                if (editorMode !== 'read' && cursorOnLine(state, from, to)) return;

                decorations.push(
                    Decoration.replace({ widget: new HorizontalRuleWidget() }).range(from, to)
                );

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
            decorations.push(Decoration.mark({ class: 'cm-latex-delim' }).range(from, to));
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
        decorations.push(Decoration.replace({}).range(from, from + 2));
        decorations.push(Decoration.replace({}).range(to - 2, to));
        // Style inner content
        decorations.push(
            Decoration.mark({ class: 'cm-live-highlight' }).range(from + 2, to - 2)
        );
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
        decorations.push(Decoration.replace({}).range(from, innerStart));
        decorations.push(Decoration.replace({}).range(innerEnd, to));

        const linkAttrs = { class: 'cm-wikilink', attributes: { 'data-wikilink': target } };
        if (pipeIndex >= 0) {
            // Hide "target|" and show only the alias text.
            const pipePos = innerStart + pipeIndex;
            decorations.push(Decoration.replace({}).range(innerStart, pipePos + 1));
            decorations.push(Decoration.mark(linkAttrs).range(pipePos + 1, innerEnd));
        } else {
            decorations.push(Decoration.mark(linkAttrs).range(innerStart, innerEnd));
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

