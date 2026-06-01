import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

/**
 * CodeMirror 6 theme matching Obsidian's default dark theme.
 */
export const obsidianDarkTheme = EditorView.theme({
    '&': {
        backgroundColor: '#1e1e1e',
        color: '#dcddde',
        fontSize: 'var(--font-size-normal)',
        fontFamily: 'var(--font-text)',
        height: '100%',
    },
    '.cm-content': {
        // Hide the native caret; drawSelection() renders the styled .cm-cursor instead.
        caretColor: 'transparent',
        padding: '24px 32px',
        lineHeight: '1.65',
        fontFamily: 'inherit',
    },
    // Caret styling is driven by CSS variables (set from the Settings panel) so
    // the line/block thickness and smooth-movement animation can change live.
    '.cm-cursor': {
        borderLeftColor: '#dcddde',
        borderLeftWidth: 'var(--caret-line-width, 2px)',
        width: 'var(--caret-block-width, 0px)',
        backgroundColor: 'var(--caret-block-bg, transparent)',
        borderRadius: 'var(--caret-radius, 0)',
        transition: 'var(--caret-transition, none)',
    },
    '.cm-dropCursor': {
        borderLeftColor: '#dcddde',
        borderLeftWidth: '2px',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: 'rgba(135, 103, 213, 0.3)',
    },
    '.cm-activeLine': {
        backgroundColor: 'rgba(255, 255, 255, 0.03)',
    },
    '.cm-gutters': {
        display: 'none',
    },
    '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
    },
    '.cm-scroller': {
        overflow: 'auto',
        fontFamily: 'inherit',
    },
    '.cm-line': {
        padding: '0',
    },
    // Scrollbar matching
    '.cm-scroller::-webkit-scrollbar': {
        width: '6px',
        height: '6px',
    },
    '.cm-scroller::-webkit-scrollbar-track': {
        background: 'transparent',
    },
    '.cm-scroller::-webkit-scrollbar-thumb': {
        background: 'rgba(255,255,255,0.1)',
        borderRadius: '3px',
    },
    '.cm-scroller::-webkit-scrollbar-thumb:hover': {
        background: 'rgba(255,255,255,0.18)',
    },
}, { dark: true });

/**
 * Syntax highlighting matching Obsidian's colors.
 */
export const obsidianHighlightStyle = syntaxHighlighting(HighlightStyle.define([
    { tag: tags.heading1, fontWeight: '700', fontSize: '1.3em', color: '#dcddde' },
    { tag: tags.heading2, fontWeight: '600', fontSize: '1.2em', color: '#dcddde' },
    { tag: tags.heading3, fontWeight: '600', fontSize: '1.12em', color: '#dcddde' },
    { tag: tags.heading4, fontWeight: '600', fontSize: '1.05em', color: '#dcddde' },
    { tag: tags.heading5, fontWeight: '600', fontSize: '1em', color: '#dcddde' },
    { tag: tags.heading6, fontWeight: '600', fontSize: '1em', color: '#999' },
    { tag: tags.strong, fontWeight: '700', color: '#dcddde' },
    { tag: tags.emphasis, fontStyle: 'italic', color: '#dcddde' },
    { tag: tags.strikethrough, textDecoration: 'line-through', color: '#999' },
    { tag: tags.link, color: 'hsl(254, 80%, 68%)', textDecoration: 'underline' },
    { tag: tags.url, color: 'hsl(254, 80%, 68%)' },
    { tag: tags.monospace, fontFamily: '"SF Mono", Menlo, Monaco, monospace', color: '#e06c75', backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: '3px' },
    { tag: tags.quote, color: '#999', fontStyle: 'italic' },
    { tag: tags.list, color: '#dcddde' },
    { tag: tags.meta, color: '#666' },
    { tag: tags.comment, color: '#666' },
    // Formatting markers (e.g. the _ / * around emphasis) — kept faint like Obsidian
    // rather than a loud red, since they're only revealed while editing.
    { tag: tags.processingInstruction, color: '#7d828c' },
]));

/**
 * CodeMirror 6 theme matching Obsidian's default light theme.
 */
export const obsidianLightTheme = EditorView.theme({
    '&': {
        backgroundColor: '#ffffff',
        color: '#2e3338',
        fontSize: 'var(--font-size-normal)',
        fontFamily: 'var(--font-text)',
        height: '100%',
    },
    '.cm-content': {
        // Hide the native caret; drawSelection() renders the styled .cm-cursor instead.
        caretColor: 'transparent',
        padding: '24px 32px',
        lineHeight: '1.65',
        fontFamily: 'inherit',
    },
    // See the dark theme above — caret look is controlled via CSS variables.
    '.cm-cursor': {
        borderLeftColor: '#2e3338',
        borderLeftWidth: 'var(--caret-line-width, 2px)',
        width: 'var(--caret-block-width, 0px)',
        backgroundColor: 'var(--caret-block-bg, transparent)',
        borderRadius: 'var(--caret-radius, 0)',
        transition: 'var(--caret-transition, none)',
    },
    '.cm-dropCursor': {
        borderLeftColor: '#2e3338',
        borderLeftWidth: '2px',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: 'rgba(135, 103, 213, 0.2)',
    },
    '.cm-activeLine': {
        backgroundColor: 'rgba(0, 0, 0, 0.03)',
    },
    '.cm-gutters': {
        display: 'none',
    },
    '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
    },
    '.cm-scroller': {
        overflow: 'auto',
        fontFamily: 'inherit',
    },
    '.cm-line': {
        padding: '0',
    },
    // Scrollbar matching
    '.cm-scroller::-webkit-scrollbar': {
        width: '6px',
        height: '6px',
    },
    '.cm-scroller::-webkit-scrollbar-track': {
        background: 'transparent',
    },
    '.cm-scroller::-webkit-scrollbar-thumb': {
        background: 'rgba(0,0,0,0.1)',
        borderRadius: '3px',
    },
    '.cm-scroller::-webkit-scrollbar-thumb:hover': {
        background: 'rgba(0,0,0,0.2)',
    },
}, { dark: false });

/**
 * Syntax highlighting matching Obsidian's light colors.
 */
export const obsidianLightHighlightStyle = syntaxHighlighting(HighlightStyle.define([
    { tag: tags.heading1, fontWeight: '700', fontSize: '1.3em', color: '#2e3338' },
    { tag: tags.heading2, fontWeight: '600', fontSize: '1.2em', color: '#2e3338' },
    { tag: tags.heading3, fontWeight: '600', fontSize: '1.12em', color: '#2e3338' },
    { tag: tags.heading4, fontWeight: '600', fontSize: '1.05em', color: '#2e3338' },
    { tag: tags.heading5, fontWeight: '600', fontSize: '1em', color: '#2e3338' },
    { tag: tags.heading6, fontWeight: '600', fontSize: '1em', color: '#5c5f66' },
    { tag: tags.strong, fontWeight: '700', color: '#2e3338' },
    { tag: tags.emphasis, fontStyle: 'italic', color: '#2e3338' },
    { tag: tags.strikethrough, textDecoration: 'line-through', color: '#5c5f66' },
    { tag: tags.link, color: 'hsl(254, 80%, 52%)', textDecoration: 'underline' },
    { tag: tags.url, color: 'hsl(254, 80%, 52%)' },
    { tag: tags.monospace, fontFamily: '"SF Mono", Menlo, Monaco, monospace', color: '#d14', backgroundColor: 'rgba(0,0,0,0.04)', borderRadius: '3px' },
    { tag: tags.quote, color: '#5c5f66', fontStyle: 'italic' },
    { tag: tags.list, color: '#2e3338' },
    { tag: tags.meta, color: '#999' },
    { tag: tags.comment, color: '#999' },
    // Formatting markers — faint like Obsidian instead of a loud red.
    { tag: tags.processingInstruction, color: '#a4a8b0' },
]));
