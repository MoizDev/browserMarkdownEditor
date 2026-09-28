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

import { EditorView } from '@codemirror/view';
import { Compartment, EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { LanguageDescription } from '@codemirror/language';
import { obsidianDarkTheme, obsidianHighlightStyle, obsidianLightTheme, obsidianLightHighlightStyle } from './cmTheme';
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

function themeExtensions(theme: Theme) {
    return theme === 'light'
        ? [obsidianLightTheme, obsidianLightHighlightStyle]
        : [obsidianDarkTheme, obsidianHighlightStyle];
}

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
            EditorView.contentAttributes.of({ 'aria-label': 'Agent reply' }),
        ],
    });
}

interface PendingAppend {
    text: string;
    frame: number;
}

const pendingAppends = new WeakMap<EditorView, PendingAppend>();

/** A read-only view of `text` inside `parent`. The caller destroys it. */
export function createReplyView(parent: HTMLElement, text: string, theme: Theme): EditorView {
    return new EditorView({ parent, state: replyState(text, theme) });
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
