// An agent's reply, rendered the way the editor renders a note in Reading mode.
//
// Why a CodeMirror view and not a markdown-to-HTML renderer: AGENTS.md allows
// exactly two places that turn note text into `innerHTML` (the table cell
// renderer and mermaid's DOMPurify pass) and forbids a third, and a reply is
// text an agent wrote from whatever it read — web pages included. Reading mode
// already draws headings, lists, code, KaTeX, mermaid and tables through those
// two audited sinks and nothing else, so a reply gets them all with no new one.
//
// React-free like the rest of src/editor/: the panel owns a view per reply
// (only while it is near the viewport — the caller virtualizes) and destroys it
// on unmount.
//
// Cost (the live-preview skill's rule): the decoration field rebuilds on every
// doc change, i.e. once per appended batch. `appendReply` coalesces deltas to
// one transaction per animation frame, so a streaming reply costs at most one
// rebuild per frame over a document of a few KB — the memoized analyzeDoc keys
// on each new Text, so nothing is re-flattened for the OTHER replies on screen.

import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { Compartment, EditorState, RangeSetBuilder } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, LanguageDescription, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { obsidianDarkTheme, obsidianHighlightStyle, obsidianLightTheme } from './cmTheme';
import { createLivePreviewPlugin } from './livePreview';
import type { ImageEmbedActions } from './imageWidget';
import { modeExtensions } from './readingMode';
import type { Theme } from '../types';

/* ONE resolver and ONE actions object for every reply, for the app's life:
   ImageWidget.eq() compares them by identity (see EditorPane), and a reply
   has no folder to resolve `![[picture.png]]` against — an agent that writes
   one gets the same "not found" box a note would. */
const noAsset = (): Promise<string | null> => Promise.resolve(null);
const noImageActions: ImageEmbedActions = { confirmDelete: () => {} };

/** Shared by every reply view; a Compartment is an identity key, not state. */
const themeCompartment = new Compartment();

/* The editor chrome follows the theme, the token palette does not: a reply's
   code blocks are dark in BOTH panel themes (the panel's
   --va-code-bg), and the light palette's inks are drawn for a white page —
   on the dark block they measured near-invisible. The prose spans the
   palette also colours (headings, bold, links) are re-inked by the panel's
   CSS, so only code tokens reach the screen from here. */
function themeExtensions(theme: Theme) {
    return [theme === 'light' ? obsidianLightTheme : obsidianDarkTheme, obsidianHighlightStyle, replyCodeInk];
}

/* Three of that palette's inks are too faint on the reply's code block:
   comments and meta #666 (2.97:1 on the dark theme's #1C1C1A, 2.47:1 on the
   light theme's #2B2B29), the processing-instruction grey (3.68:1) and the
   One Dark red of names (4.44:1 light). The panel re-inks them (≥ 5:1 on
   both, conversation.css) through these stable class names — the palette's
   own are generated. This is the code half of cmTheme's obsidianHighlightStyle
   tag for tag, in its order, because a highlighter resolves each token to its
   most specific rule: a class on `name` alone would also land on
   `definition(name)` and every other name the palette draws in another ink.
   Change the two together. */
const replyCodeInk = syntaxHighlighting(HighlightStyle.define([
    { tag: tags.meta, class: 'va-ink-quiet' },
    { tag: tags.comment, class: 'va-ink-quiet' },
    { tag: tags.processingInstruction, class: 'va-ink-quiet' },
    { tag: tags.keyword, class: 'va-ink-keyword' },
    { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], class: 'va-ink-name' },
    { tag: [tags.function(tags.variableName), tags.labelName], class: 'va-ink-function' },
    { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], class: 'va-ink-constant' },
    { tag: [tags.definition(tags.name), tags.separator, tags.punctuation, tags.bracket], class: 'va-ink-punctuation' },
    { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace], class: 'va-ink-type' },
    { tag: [tags.operator, tags.operatorKeyword, tags.escape, tags.regexp, tags.special(tags.string)], class: 'va-ink-operator' },
    { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], class: 'va-ink-atom' },
    { tag: [tags.string, tags.inserted], class: 'va-ink-string' },
]));

/* A code block's header row names its language, and the fence that says it is
   hidden in Reading mode (livePreview's HIDE), so CSS cannot read it. This
   puts it back as an ATTRIBUTE on the fence row (`data-lang`, drawn by the
   panel's CSS with `content: attr()`) — text, never markup, so no new sink.
   Reply-only: a note's code block keeps its corner button and no header. */
const langDecorations = new Map<string, Decoration>();
function langLine(lang: string): Decoration {
    let deco = langDecorations.get(lang);
    if (!deco) {
        deco = Decoration.line({ attributes: { 'data-lang': lang } });
        // Bounded by what agents write after ``` — a few dozen names — but a
        // reply can say anything, so the cache is not allowed to grow forever.
        if (langDecorations.size < 64) langDecorations.set(lang, deco);
    }
    return deco;
}

function fenceLanguages(state: EditorState): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    syntaxTree(state).iterate({
        enter: node => {
            if (node.name !== 'FencedCode') return;
            const line = state.doc.lineAt(node.from);
            const lang = line.text.trim().match(/^(?:`{3,}|~{3,})\s*([^\s`]*)/)?.[1] ?? '';
            builder.add(line.from, line.from, langLine(lang));
            return false;
        },
    });
    return builder.finish();
}

/* The note's copy button is never a tab stop (copyCodeWidget.ts says why: a
   note's scroller holds the keyboard). A reply is not a note — Tab walks the
   panel, and every affordance in it must be reachable — so here it is one. */
function makeCopyButtonsTabbable(view: EditorView): void {
    view.requestMeasure({
        read: () => null,
        write: () => {
            for (const button of view.contentDOM.querySelectorAll<HTMLElement>('.cm-codeblock-copy[tabindex="-1"]')) {
                button.tabIndex = 0;
            }
        },
    });
}

const replyCodeBlocks = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
        this.decorations = fenceLanguages(view.state);
        makeCopyButtonsTabbable(view);
    }
    update(update: ViewUpdate) {
        // The tree advances in idle time as well as on edits (livePreview's
        // own rebuild rule), and a fence is only known once it is parsed.
        if (!update.docChanged && syntaxTree(update.startState) === syntaxTree(update.state)) return;
        this.decorations = fenceLanguages(update.state);
        makeCopyButtonsTabbable(update.view);
    }
}, { decorations: plugin => plugin.decorations });

/** Built once: the field is a pure function of the document in read mode. */
const readPreview = createLivePreviewPlugin(noAsset, 'read', noImageActions);

function replyState(text: string, theme: Theme): EditorState {
    return EditorState.create({
        doc: text,
        extensions: [
            EditorView.lineWrapping,
            // The same fence resolution as DocumentPane: an info string is
            // often a file extension (```py), which matchLanguageName ignores.
            markdown({
                base: markdownLanguage,
                codeLanguages: (info: string) =>
                    LanguageDescription.matchLanguageName(languages, info, true)
                    ?? LanguageDescription.matchFilename(languages, `x.${info}`),
            }),
            themeCompartment.of(themeExtensions(theme)),
            modeExtensions('read'),
            readPreview,
            replyCodeBlocks,
            EditorView.contentAttributes.of({ 'aria-label': 'Agent reply' }),
        ],
    });
}

interface PendingAppend {
    text: string;
    frame: number;
}

const pendingAppends = new WeakMap<EditorView, PendingAppend>();

/** A read-only view of `text` inside `parent`. The caller destroys it.
 *  Built detached and attached after: the constructor sets the content's
 *  attributes, and `contenteditable` set on a CONNECTED element forced a
 *  style recalc of the document each time — measured in a 40-turn chat
 *  scrolled end to end, 74 view mounts spent ~0.9s per pass in setAttribute
 *  (14ms detached). */
export function createReplyView(parent: HTMLElement, text: string, theme: Theme): EditorView {
    const view = new EditorView({ state: replyState(text, theme) });
    parent.appendChild(view.dom);
    return view;
}

/**
 * Append streamed text. Deltas arriving within one frame land as ONE
 * transaction, so the decoration rebuild runs at most once per frame however
 * finely the agent streams (Claude sends a delta every few characters).
 */
export function appendReply(view: EditorView, delta: string): void {
    if (!delta) return;
    const pending = pendingAppends.get(view);
    if (pending) { pending.text += delta; return; }
    const entry: PendingAppend = {
        text: delta,
        frame: requestAnimationFrame(() => {
            pendingAppends.delete(view);
            flush(view, entry.text);
        }),
    };
    pendingAppends.set(view, entry);
}

function flush(view: EditorView, text: string): void {
    // A view destroyed with a frame in flight (destroy() detaches its DOM)
    // has nothing to update.
    if (!view.dom.parentNode) return;
    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, insert: text } });
}

/** The text the view WILL hold once any pending append lands. */
export function replyText(view: EditorView): string {
    const pending = pendingAppends.get(view);
    return view.state.doc.toString() + (pending ? pending.text : '');
}

/** Replace the whole reply (a reply the stream did not simply extend). */
export function setReplyText(view: EditorView, text: string): void {
    cancelPending(view);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

export function setReplyTheme(view: EditorView, theme: Theme): void {
    view.dispatch({ effects: themeCompartment.reconfigure(themeExtensions(theme)) });
}

function cancelPending(view: EditorView): void {
    const pending = pendingAppends.get(view);
    if (pending) {
        cancelAnimationFrame(pending.frame);
        pendingAppends.delete(view);
    }
}

export function destroyReplyView(view: EditorView): void {
    cancelPending(view);
    view.destroy();
}
