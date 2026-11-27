import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

const searchPanelStyles = {
    '.cm-panels': {
        backgroundColor: 'transparent',
        color: 'var(--text-normal)',
    },
    '.cm-panels.cm-panels-top': {
        borderBottom: 'none',
    },
    '.cm-panel.bme-find': {
        position: 'absolute',
        top: '12px',
        right: '18px',
        boxSizing: 'border-box',
        width: 'min(440px, calc(100% - 36px))',
        padding: '6px',
        border: '1px solid var(--background-modifier-border)',
        borderRadius: '8px',
        backgroundColor: 'var(--background-primary)',
        color: 'var(--text-normal)',
        boxShadow: '0 4px 18px #0003',
        fontFamily: 'var(--font-ui)',
        fontSize: '12px',
        lineHeight: '1.4',
    },
    '.bme-find-row': {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
    },
    '.bme-find-replace': {
        marginTop: '5px',
        paddingLeft: '24px',
    },
    '.bme-find-row[hidden]': {
        display: 'none',
    },
    '.bme-find-fieldbox': {
        flex: '1',
        minWidth: '60px',
        display: 'flex',
        alignItems: 'center',
        gap: '1px',
        height: '28px',
        boxSizing: 'border-box',
        padding: '0 2px 0 0',
        border: '1px solid var(--background-modifier-border)',
        borderRadius: 'var(--radius-s)',
        backgroundColor: 'var(--background-secondary)',
    },
    '.bme-find-fieldbox:focus-within': {
        outline: '2px solid var(--interactive-accent)',
        outlineOffset: '1px',
    },
    '.bme-find-field': {
        flex: '1',
        minWidth: '0',
        width: '0',
        height: '26px',
        boxSizing: 'border-box',
        margin: '0',
        padding: '0 7px',
        border: 'none',
        background: 'transparent',
        color: 'var(--text-normal)',
        font: 'inherit',
        outline: 'none',
    },
    '.bme-find-replace .bme-find-field': {
        height: '28px',
        border: '1px solid var(--background-modifier-border)',
        borderRadius: 'var(--radius-s)',
        backgroundColor: 'var(--background-secondary)',
    },
    '.bme-find-replace .bme-find-field:focus': {
        outline: '2px solid var(--interactive-accent)',
        outlineOffset: '1px',
    },
    '.bme-find-field::placeholder': {
        color: 'var(--text-faint)',
    },
    '.bme-find-toggle': {
        flex: 'none',
        width: '22px',
        height: '20px',
        margin: '0',
        padding: '0',
        border: '1px solid transparent',
        borderRadius: '3px',
        background: 'transparent',
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-monospace, ui-monospace, monospace)',
        fontSize: '11px',
        lineHeight: '18px',
        cursor: 'pointer',
    },
    '.bme-find-toggle[name=word]': {
        textDecoration: 'underline',
        textUnderlineOffset: '2px',
    },
    '.bme-find-toggle:hover': {
        color: 'var(--text-normal)',
        backgroundColor: 'var(--background-modifier-hover)',
    },
    '.bme-find-toggle[aria-pressed=true]': {
        color: 'var(--text-normal)',
        borderColor: 'var(--interactive-accent)',
        backgroundColor: 'color-mix(in srgb, var(--interactive-accent) 22%, transparent)',
    },
    '.bme-find-status': {
        flex: '0 1 auto',
        minWidth: '58px',
        maxWidth: '110px',
        boxSizing: 'border-box',
        textAlign: 'center',
        padding: '0 4px',
        color: 'var(--text-muted)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        fontVariantNumeric: 'tabular-nums',
    },
    '.bme-find-status:empty': {
        display: 'none',
    },
    '.bme-find-button': {
        flex: 'none',
        width: '25px',
        height: '28px',
        margin: '0',
        padding: '0',
        border: '0',
        borderRadius: 'var(--radius-s)',
        background: 'transparent',
        color: 'var(--text-normal)',
        font: 'inherit',
        fontSize: '19px',
        lineHeight: '26px',
        cursor: 'pointer',
    },
    '.bme-find-button:hover:not(:disabled)': {
        backgroundColor: 'var(--background-modifier-hover)',
    },
    '.bme-find-button:disabled': {
        color: 'var(--text-faint)',
        cursor: 'default',
    },
    '.bme-find-disclosure': {
        width: '20px',
        color: 'var(--text-muted)',
        transition: 'transform 0.12s',
    },
    '.bme-find-disclosure[hidden]': {
        display: 'none',
    },
    '.bme-find-disclosure.is-open': {
        transform: 'rotate(90deg)',
    },
    '.bme-find-text-button': {
        flex: 'none',
        height: '28px',
        margin: '0',
        padding: '0 9px',
        border: '1px solid var(--background-modifier-border)',
        borderRadius: 'var(--radius-s)',
        background: 'var(--background-primary)',
        color: 'var(--text-normal)',
        font: 'inherit',
        cursor: 'pointer',
    },
    '.bme-find-text-button:hover': {
        backgroundColor: 'var(--background-modifier-hover)',
    },
    '.bme-find button:focus-visible': {
        outline: '2px solid var(--interactive-accent)',
        outlineOffset: '-1px',
    },
    '.cm-searchMatch': {
        backgroundColor: 'var(--text-highlight-bg)',
        borderRadius: '2px',
    },
    '.cm-searchMatch-selected': {
        backgroundColor: 'rgba(255, 128, 0, 0.55)',
    },
};

export const obsidianDarkTheme: Extension = EditorView.theme({
    '&': {
        backgroundColor: '#1e1e1e',
        color: '#dcddde',
        fontSize: 'var(--font-size-normal)',
        fontFamily: 'var(--font-text)',
        height: '100%',
    },
    '.cm-content': {
        caretColor: 'transparent',
        padding: '24px 32px',
        lineHeight: '1.65',
        fontFamily: 'inherit',
    },
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
    '.cm-panels': { ...searchPanelStyles['.cm-panels'], colorScheme: 'dark' },
}, { dark: true });

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
    { tag: tags.link, color: 'var(--text-accent)' },
    { tag: tags.url, color: 'var(--text-accent)' },
    { tag: tags.monospace, fontFamily: '"SF Mono", Menlo, Monaco, monospace' },
    { tag: tags.quote, color: '#999', fontStyle: 'italic' },
    { tag: tags.list, color: '#dcddde' },
    { tag: tags.meta, color: '#666' },
    { tag: tags.comment, color: '#666' },
    { tag: tags.processingInstruction, color: '#7d828c' },

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

export const obsidianLightTheme: Extension = EditorView.theme({
    '&': {
        backgroundColor: '#ffffff',
        color: '#2e3338',
        fontSize: 'var(--font-size-normal)',
        fontFamily: 'var(--font-text)',
        height: '100%',
    },
    '.cm-content': {
        caretColor: 'transparent',
        padding: '24px 32px',
        lineHeight: '1.65',
        fontFamily: 'inherit',
    },
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
    { tag: tags.link, color: 'var(--text-accent)' },
    { tag: tags.url, color: 'var(--text-accent)' },
    { tag: tags.monospace, fontFamily: '"SF Mono", Menlo, Monaco, monospace' },
    { tag: tags.quote, color: '#5c5f66', fontStyle: 'italic' },
    { tag: tags.list, color: '#2e3338' },
    { tag: tags.meta, color: '#999' },
    { tag: tags.comment, color: '#999' },
    { tag: tags.processingInstruction, color: '#a4a8b0' },

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
