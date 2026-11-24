import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

/**
 * The note's search panel (⌘F — editor/noteSearch.ts), shared by both themes.
 *
 * Left to CodeMirror's base theme it was a grey form bolted under the note:
 * gradient buttons at 70% type, 1px #888 borders, a browser-blue focus ring,
 * white native checkboxes on the dark theme and cyan / magenta matches — hardly
 * seen while it only opened in Edit mode, and in front of every reader once ⌘F
 * reached Reading mode too. Drawn instead from the app's own variables, after
 * the sidebar's search box (`.search-input` in index.css), so one object serves
 * both themes; matches take the marker yellow the vault search's snippets and
 * its jump flash already use.
 *
 * Selectors carry `.cm-panel.cm-search` wherever the base theme's own rule does
 * (`& input, & button, & label`, `[name=close]`): a bare `.cm-button` loses to
 * those on specificity, and only ties go to a theme over a base theme.
 */
const searchPanelStyles = {
    '.cm-panels': {
        backgroundColor: 'var(--background-secondary)',
        color: 'var(--text-normal)',
    },
    '.cm-panels.cm-panels-top': {
        borderBottom: '1px solid var(--background-modifier-border)',
    },
    '.cm-panels.cm-panels-bottom': {
        borderTop: '1px solid var(--background-modifier-border)',
    },
    '.cm-panel.cm-search': {
        padding: '5px 44px 5px 12px',
        fontFamily: 'var(--font-ui)',
        fontSize: 'var(--nav-item-size)',
    },
    '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
        margin: '3px 6px 3px 0',
    },
    '.cm-panel.cm-search .cm-textfield': {
        boxSizing: 'border-box',
        width: '220px',
        height: '26px',
        padding: '0 8px',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        color: 'var(--text-normal)',
        backgroundColor: 'var(--background-primary)',
        border: '1px solid var(--background-modifier-border)',
        borderRadius: 'var(--radius-s)',
        outline: 'none',
        transition: 'border-color 0.15s',
    },
    '.cm-panel.cm-search .cm-textfield:focus': {
        borderColor: 'var(--interactive-accent)',
    },
    '.cm-panel.cm-search .cm-textfield::placeholder': {
        color: 'var(--text-faint)',
    },
    '.cm-panel.cm-search .cm-button': {
        boxSizing: 'border-box',
        height: '26px',
        padding: '0 10px',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        color: 'var(--text-normal)',
        backgroundColor: 'var(--background-primary)',
        backgroundImage: 'none',
        border: '1px solid var(--background-modifier-border)',
        borderRadius: 'var(--radius-s)',
        cursor: 'pointer',
    },
    '.cm-panel.cm-search .cm-button:hover, .cm-panel.cm-search .cm-button:active': {
        backgroundColor: 'var(--background-modifier-hover)',
        backgroundImage: 'none',
    },
    '.cm-panel.cm-search button:focus-visible': {
        outline: '1px solid var(--interactive-accent)',
        outlineOffset: '-1px',
    },
    // As tall as a button and centred on it: left inline, a label's text sat
    // on its own baseline, 2px above the buttons' (measured in a screenshot).
    // The gap before each option sits on the label BEFORE it, not on the
    // checkbox: in a narrow pane the options wrap onto their own row, and a
    // left margin there left it 4px right of the fields above (measured).
    '.cm-panel.cm-search label': {
        display: 'inline-flex',
        alignItems: 'center',
        height: '26px',
        margin: '3px 10px 3px 0',
        verticalAlign: 'middle',
        fontSize: 'inherit',
        color: 'var(--text-muted)',
        cursor: 'pointer',
    },
    '.cm-panel.cm-search input[type=checkbox]': {
        margin: '0 5px 0 0',
        accentColor: 'var(--interactive-accent)',
        cursor: 'pointer',
    },
    // The buttons' ring, not Chrome's default blue one touching the label.
    '.cm-panel.cm-search input[type=checkbox]:focus-visible': {
        outline: '1px solid var(--interactive-accent)',
        outlineOffset: '1px',
    },
    '.cm-panel.cm-search [name=close]': {
        top: '8px',
        right: '10px',
        width: '26px',
        height: '26px',
        fontSize: '18px',
        lineHeight: '24px',
        color: 'var(--text-muted)',
        borderRadius: 'var(--radius-s)',
        cursor: 'pointer',
    },
    '.cm-panel.cm-search [name=close]:hover': {
        color: 'var(--text-normal)',
        backgroundColor: 'var(--background-modifier-hover)',
    },
    '.cm-searchMatch': {
        backgroundColor: 'var(--text-highlight-bg)',
        borderRadius: '2px',
    },
    // After .cm-searchMatch, which the selected match also carries: the tie
    // goes to the later rule.
    '.cm-searchMatch-selected': {
        backgroundColor: 'rgba(255, 128, 0, 0.55)',
    },
};

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
    ...searchPanelStyles,
    // Native form controls (the panel's checkboxes) drawn for a dark page.
    '.cm-panels': { ...searchPanelStyles['.cm-panels'], colorScheme: 'dark' },
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
    // No underline here: rendered links get theirs from .cm-live-link, and
    // this tag also lands on [x](y) inside REVEALED MATH (the parser can't be
    // told $…$ is LaTeX) — an inherited underline there is uncancelable.
    { tag: tags.link, color: 'var(--text-accent)' },
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
    ...searchPanelStyles,
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
    // No underline — see the dark theme's note on tags.link.
    { tag: tags.link, color: 'var(--text-accent)' },
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
