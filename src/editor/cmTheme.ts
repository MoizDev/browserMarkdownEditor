import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

/**
 * CodeMirror 6 theme matching Obsidian's default dark theme.
 */
export const obsidianDarkTheme: Extension = EditorView.theme({
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
    // Its color is a translucent accent — tracks a custom accent automatically.
    '.cm-cursor': {
        borderLeftColor: 'color-mix(in srgb, var(--interactive-accent) 55%, transparent)',
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
export const obsidianHighlightStyle: Extension = syntaxHighlighting(HighlightStyle.define([
    { tag: tags.heading1, fontWeight: '700', fontSize: '1.3em', color: '#dcddde' },
    { tag: tags.heading2, fontWeight: '600', fontSize: '1.2em', color: '#dcddde' },
    { tag: tags.heading3, fontWeight: '600', fontSize: '1.12em', color: '#dcddde' },
    { tag: tags.heading4, fontWeight: '600', fontSize: '1.05em', color: '#dcddde' },
    { tag: tags.heading5, fontWeight: '600', fontSize: '1em', color: '#dcddde' },
    { tag: tags.heading6, fontWeight: '600', fontSize: '1em', color: '#999' },
    { tag: tags.strong, fontWeight: '700', color: '#dcddde' },
    { tag: tags.emphasis, fontStyle: 'italic', color: '#dcddde' },
    { tag: tags.strikethrough, textDecoration: 'line-through', color: '#999' },
    { tag: tags.link, color: 'var(--text-accent)', textDecoration: 'underline' },
    { tag: tags.url, color: 'var(--text-accent)' },
    // Font only: the pill background/accent ink live on .cm-live-code and
    // .cm-live-codeblock — fenced block text must stay plain here so its
    // panel reads as one piece and embedded-language token colors show.
    { tag: tags.monospace, fontFamily: '"SF Mono", Menlo, Monaco, monospace' },
    { tag: tags.quote, color: '#999', fontStyle: 'italic' },
    { tag: tags.list, color: '#dcddde' },
    { tag: tags.meta, color: '#666' },
    { tag: tags.comment, color: '#666' },
    // Formatting markers (e.g. the _ / * around emphasis) — kept faint like Obsidian
    // rather than a loud red, since they're only revealed while editing.
    { tag: tags.processingInstruction, color: '#7d828c' },

    // ── Code tokens (embedded languages in fenced blocks) ──
    // The full One Dark tag mapping (same rules as @codemirror/theme-one-dark,
    // same order — the order resolves specificity ties), so real-world code is
    // as colorful as Obsidian's. Markdown-owned tags (heading, strong, link,
    // url, processingInstruction) are deliberately absent: those belong to the
    // note styling above and must not be repainted by the code palette.
    { tag: tags.keyword, color: '#c678dd' },
    { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: '#e06c75' },
    { tag: [tags.function(tags.variableName), tags.labelName], color: '#61afef' },
    { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#d19a66' },
    { tag: [tags.definition(tags.name), tags.separator, tags.punctuation, tags.bracket], color: '#abb2bf' },
    { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace], color: '#e5c07b' },
    { tag: [tags.operator, tags.operatorKeyword, tags.escape, tags.regexp, tags.special(tags.string)], color: '#56b6c2' },
    { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: '#d19a66' },
    { tag: [tags.string, tags.inserted], color: '#98c379' },
]));

/**
 * CodeMirror 6 theme matching Obsidian's default light theme.
 */
export const obsidianLightTheme: Extension = EditorView.theme({
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
        borderLeftColor: 'color-mix(in srgb, var(--interactive-accent) 55%, transparent)',
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
export const obsidianLightHighlightStyle: Extension = syntaxHighlighting(HighlightStyle.define([
    { tag: tags.heading1, fontWeight: '700', fontSize: '1.3em', color: '#2e3338' },
    { tag: tags.heading2, fontWeight: '600', fontSize: '1.2em', color: '#2e3338' },
    { tag: tags.heading3, fontWeight: '600', fontSize: '1.12em', color: '#2e3338' },
    { tag: tags.heading4, fontWeight: '600', fontSize: '1.05em', color: '#2e3338' },
    { tag: tags.heading5, fontWeight: '600', fontSize: '1em', color: '#2e3338' },
    { tag: tags.heading6, fontWeight: '600', fontSize: '1em', color: '#5c5f66' },
    { tag: tags.strong, fontWeight: '700', color: '#2e3338' },
    { tag: tags.emphasis, fontStyle: 'italic', color: '#2e3338' },
    { tag: tags.strikethrough, textDecoration: 'line-through', color: '#5c5f66' },
    { tag: tags.link, color: 'var(--text-accent)', textDecoration: 'underline' },
    { tag: tags.url, color: 'var(--text-accent)' },
    // Font only — see the dark theme's note on tags.monospace.
    { tag: tags.monospace, fontFamily: '"SF Mono", Menlo, Monaco, monospace' },
    { tag: tags.quote, color: '#5c5f66', fontStyle: 'italic' },
    { tag: tags.list, color: '#2e3338' },
    { tag: tags.meta, color: '#999' },
    { tag: tags.comment, color: '#999' },
    // Formatting markers — faint like Obsidian instead of a loud red.
    { tag: tags.processingInstruction, color: '#a4a8b0' },

    // ── Code tokens — One Light palette, mirroring the dark theme's One Dark
    // rule set (same tags, same order; see that block's note).
    { tag: tags.keyword, color: '#a626a4' },
    { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: '#e45649' },
    { tag: [tags.function(tags.variableName), tags.labelName], color: '#4078f2' },
    { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#986801' },
    { tag: [tags.definition(tags.name), tags.separator, tags.punctuation, tags.bracket], color: '#383a42' },
    { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace], color: '#c18401' },
    { tag: [tags.operator, tags.operatorKeyword, tags.escape, tags.regexp, tags.special(tags.string)], color: '#0184bc' },
    { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: '#986801' },
    { tag: [tags.string, tags.inserted], color: '#50a14f' },
]));
