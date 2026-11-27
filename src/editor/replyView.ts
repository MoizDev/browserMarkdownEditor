// Why a CodeMirror view and not a markdown-to-HTML renderer: AGENTS.md allows
// exactly two places that turn note text into `innerHTML` (the table cell
// renderer and mermaid's DOMPurify pass) and forbids a third, and a reply is
// text an agent wrote from whatever it read — web pages included. Reading mode
// already draws headings, lists, code, KaTeX, mermaid and tables through those
// two audited sinks and nothing else, so a reply gets them all with no new one.

import { EditorView } from '@codemirror/view';
import { Compartment, EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { LanguageDescription } from '@codemirror/language';
import { obsidianDarkTheme, obsidianHighlightStyle, obsidianLightTheme, obsidianLightHighlightStyle } from './cmTheme';
import { createLivePreviewPlugin, livePreviewField } from './livePreview';
import { docAnalysisField } from './docAnalysis';
import type { ImageEmbedActions } from './imageWidget';
import { modeExtensions } from './readingMode';
import type { Theme } from '../types';

const noAsset = (): Promise<string | null> => Promise.resolve(null);
const noImageActions: ImageEmbedActions = { confirmDelete: () => {} };

const themeCompartment = new Compartment();
const readOnlyCompartment = new Compartment();

function themeExtensions(theme: Theme) {
    return theme === 'light'
        ? [obsidianLightTheme, obsidianLightHighlightStyle]
        : [obsidianDarkTheme, obsidianHighlightStyle];
}

const readPreview = createLivePreviewPlugin({ getAssetUrl: noAsset, actions: noImageActions, editable: false }, noImageActions);

function replyState(text: string, theme: Theme): EditorState {
    return EditorState.create({
        doc: text,
        extensions: [
            EditorView.lineWrapping,
            markdown({
                base: markdownLanguage,
                codeLanguages: (info: string) =>
                    LanguageDescription.matchLanguageName(languages, info, true)
                    ?? LanguageDescription.matchFilename(languages, `x.${info}`),
            }),
            themeCompartment.of(themeExtensions(theme)),
            readOnlyCompartment.of(modeExtensions('read')),
            docAnalysisField,
            livePreviewField,
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

export function createReplyView(parent: HTMLElement, text: string, theme: Theme): EditorView {
    return new EditorView({ parent, state: replyState(text, theme) });
}

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
    if (!view.dom.parentNode) return;
    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, insert: text } });
}

export function replyText(view: EditorView): string {
    const pending = pendingAppends.get(view);
    return view.state.doc.toString() + (pending ? pending.text : '');
}

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
