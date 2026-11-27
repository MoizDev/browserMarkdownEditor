import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { CODE_DARK, CODE_LIGHT, type CodePalette } from './codePalette';

const DARK = CODE_DARK;
const LIGHT = CODE_LIGHT;

type Palette = CodePalette;

function bracketCycle(c: Palette): string[] {
    return [c.type, c.keyword, c.func, c.string, c.number, c.operator];
}

function styleFor(c: Palette) {
    return HighlightStyle.define([
        { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: c.comment, fontStyle: 'italic' },

        { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword, t.self, t.null], color: c.keyword },
        { tag: [t.meta, t.processingInstruction, t.annotation], color: c.keyword },

        { tag: [t.string, t.special(t.string), t.character, t.docString], color: c.string },
        { tag: [t.regexp, t.escape], color: c.operator },

        { tag: [t.number, t.integer, t.float, t.bool, t.atom, t.unit, t.constant(t.name)], color: c.number },

        { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: c.func },
        { tag: [t.typeName, t.className, t.namespace, t.standard(t.name)], color: c.type },

        { tag: [t.variableName, t.propertyName, t.attributeName, t.labelName, t.tagName], color: c.variable },
        { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: c.type },

        { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator, t.compareOperator, t.updateOperator, t.definitionOperator], color: c.operator },
        { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace, t.squareBracket, t.angleBracket], color: c.punctuation },

        { tag: t.invalid, color: c.invalid, textDecoration: 'underline wavy' },
        { tag: t.link, color: c.func, textDecoration: 'underline' },
        { tag: t.heading, color: c.variable, fontWeight: '600' },
        { tag: t.strong, color: c.base, fontWeight: '700' },
        { tag: t.emphasis, color: c.keyword, fontStyle: 'italic' },
    ]);
}

function chromeFor(dark: boolean, c: Palette): Extension {
    // `&.cm-editor`, not `&`: the note theme styles the same elements, both
    // themes are one generated class deep, and with equal specificity the
    // winner is whichever StyleModule happened to be registered last — i.e.
    // import order. Measured: the note theme's `.cm-gutters { display: none }`
    // and its prose font both won, so a code pane had no line numbers and was
    // set in the UI face. One extra class settles it for good.
    return EditorView.theme({
        '&.cm-editor': {
            color: c.base,
            fontFamily: "'Fira Code', var(--font-monospace)",
            fontVariantLigatures: 'contextual',
            fontFeatureSettings: '"calt" 1, "liga" 1',
            fontSize: 'var(--code-font-size, 14px)',
        },
        '&.cm-editor .cm-content': {
            lineHeight: '1.55',
            paddingTop: '12px',
        },
        '&.cm-editor .cm-gutters': {
            display: 'flex',
            backgroundColor: 'transparent',
            border: 'none',
            color: 'var(--text-faint)',
            fontVariantLigatures: 'none',
            fontSize: '0.88em',
            lineHeight: '1.55',
            userSelect: 'none',
        },
        '&.cm-editor .cm-lineNumbers .cm-gutterElement': {
            minWidth: '2.2em',
            padding: '0 10px 0 16px',
        },
        '&.cm-editor .cm-activeLineGutter': {
            backgroundColor: 'transparent',
            color: 'var(--text-muted)',
        },
        '&.cm-editor .cm-foldGutter .cm-gutterElement': {
            padding: '0 4px 0 0',
            color: 'var(--text-faint)',
            cursor: 'pointer',
        },
        '&.cm-editor .cm-matchingBracket, &.cm-editor.cm-focused .cm-matchingBracket': {
            backgroundColor: dark ? 'rgba(255, 255, 255, 0.11)' : 'rgba(0, 0, 0, 0.09)',
            outline: `1px solid ${c.punctuation}66`,
        },
        '&.cm-editor .cm-nonmatchingBracket': { color: c.invalid },
        ...Object.fromEntries(bracketCycle(c).flatMap((colour, i) => [
            [`&.cm-editor .cm-bracket-depth-${i}`, { color: colour }],
            [`&.cm-editor .cm-bracket-depth-${i} span`, { color: colour }],
        ])),
        '&.cm-editor .cm-bracket-bad, &.cm-editor .cm-bracket-bad span': {
            color: c.invalid,
            textDecoration: 'underline wavy',
            textDecorationThickness: '1px',
            textUnderlineOffset: '3px',
        },
        '&.cm-editor .cm-selectionMatch': {
            backgroundColor: dark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.07)',
        },
        '.cm-tooltip.cm-tooltip-autocomplete': {
            border: '1px solid var(--background-modifier-border)',
            borderRadius: '10px',
            backgroundColor: 'var(--background-secondary)',
            boxShadow: '0 6px 20px rgb(0 0 0 / 0.32)',
            overflow: 'hidden',
            padding: '4px',
        },
        '.cm-tooltip.cm-tooltip-autocomplete > ul': {
            fontFamily: "'Fira Code', var(--font-monospace)",
            fontSize: '0.86em',
            maxHeight: '15em',
        },
        '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
            display: 'flex',
            alignItems: 'baseline',
            gap: '2px',
            padding: '3px 8px',
            borderRadius: '6px',
            color: 'var(--text-normal)',
            lineHeight: '1.5',
        },
        '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
            backgroundColor: 'color-mix(in srgb, var(--interactive-accent) 26%, var(--background-secondary))',
            color: 'var(--text-normal)',
        },
        '.cm-completionMatchedText': {
            color: 'var(--interactive-accent)',
            fontWeight: '600',
            textDecoration: 'none',
        },
        '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionMatchedText': {
            color: 'var(--text-normal)',
            textDecoration: 'underline',
            textUnderlineOffset: '2px',
        },
        '.cm-completionIcon': {
            width: '1.1em',
            opacity: 0.45,
            paddingRight: '0.5em',
            fontSize: '0.9em',
        },
        '.cm-completionLabel': { flex: '1 1 auto', minWidth: 0 },
        '.cm-completionDetail': {
            color: 'var(--text-faint)',
            fontStyle: 'normal',
            marginLeft: '1em',
            fontSize: '0.9em',
        },
        '.cm-tooltip.cm-completionInfo': {
            border: '1px solid var(--background-modifier-border)',
            borderRadius: '8px',
            backgroundColor: 'var(--background-secondary)',
            color: 'var(--text-muted)',
            padding: '6px 10px',
            fontFamily: 'var(--font-text)',
            fontSize: '0.85em',
        },
    }, { dark });
}

export const codeDarkTheme: Extension = [chromeFor(true, DARK), syntaxHighlighting(styleFor(DARK))];
export const codeLightTheme: Extension = [chromeFor(false, LIGHT), syntaxHighlighting(styleFor(LIGHT))];
