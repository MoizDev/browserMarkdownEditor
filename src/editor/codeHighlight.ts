// How code is coloured, and nothing else about how a pane looks.
//
// THE RULE THIS FILE KEEPS: the app's chrome does not change for a code file.
// Same background, same gutter-less margins turned back on in the app's own
// greys, same scrollbars, same caret. The ONLY thing that differs from a note is
// the colour of the text itself, which is the whole point of opening a `.py` in
// a code editor rather than in a markdown one.
//
// THE PALETTE IS THE USER'S OWN. Read off `~/.config/zed/themes/one-dark-darker.json`
// — the custom "One Dark Darker" this vault's owner edits code in — so a Racket
// file in this app and the same file in Zed are colour for colour the same
// thing. Zed names its tokens after tree-sitter captures and CodeMirror names
// its own after Lezer tags, so the mapping below is by MEANING, written out once
// rather than guessed per language. The light side is One Light, Zed's companion
// theme, since this app follows the OS/app theme and Zed's dark theme on a white
// page would be unreadable.

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

/** One Dark Darker, as the theme file states it. */
const DARK = {
    base: '#abb2bf',
    comment: '#7f848e',
    keyword: '#d55fde',
    string: '#98c379',
    number: '#d8985f',
    func: '#52adf2',
    type: '#f5c876',
    variable: '#ef596f',
    operator: '#33d8e4',
    punctuation: '#aab1c0',
    invalid: '#ef596f',
};

/** One Light, the same theme's light half. */
const LIGHT = {
    base: '#383a42',
    comment: '#a0a1a7',
    keyword: '#a626a4',
    string: '#50a14f',
    number: '#986801',
    func: '#4078f2',
    type: '#c18401',
    variable: '#e45649',
    operator: '#0184bc',
    punctuation: '#383a42',
    invalid: '#e45649',
};

type Palette = typeof DARK;

/**
 * The six nesting colours, in cycle order, drawn from the SAME palette as the
 * syntax — so a bracket never introduces a hue the file does not already use.
 * Ordered for contrast between neighbours: no two adjacent depths are close in
 * hue, which is the whole job.
 */
function bracketCycle(c: Palette): string[] {
    return [c.type, c.keyword, c.func, c.string, c.number, c.operator];
}

/**
 * One mapping for both palettes: a tag that means "a name being defined" should
 * not drift between themes because the list was written out twice.
 */
function styleFor(c: Palette) {
    return HighlightStyle.define([
        { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: c.comment, fontStyle: 'italic' },

        { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword, t.self, t.null], color: c.keyword },
        // A preprocessor line (#include, #define) is a keyword in Zed's theme too.
        { tag: [t.meta, t.processingInstruction, t.annotation], color: c.keyword },

        { tag: [t.string, t.special(t.string), t.character, t.docString], color: c.string },
        { tag: [t.regexp, t.escape], color: c.operator },

        { tag: [t.number, t.integer, t.float, t.bool, t.atom, t.unit, t.constant(t.name)], color: c.number },

        { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: c.func },
        { tag: [t.typeName, t.className, t.namespace, t.standard(t.name)], color: c.type },

        { tag: [t.variableName, t.propertyName, t.attributeName, t.labelName, t.tagName], color: c.variable },
        // A name being DEFINED is the one the eye hunts for; Zed gives it the
        // type colour (`variable.special`), not the plain variable red.
        { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: c.type },

        { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator, t.compareOperator, t.updateOperator, t.definitionOperator], color: c.operator },
        { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace, t.squareBracket, t.angleBracket], color: c.punctuation },

        { tag: t.invalid, color: c.invalid, textDecoration: 'underline wavy' },
        { tag: t.link, color: c.func, textDecoration: 'underline' },
        // Markdown and other prose grammars reach these; keep them readable
        // rather than loud, since a code pane shows them inside comments.
        { tag: t.heading, color: c.variable, fontWeight: '600' },
        { tag: t.strong, color: c.base, fontWeight: '700' },
        { tag: t.emphasis, color: c.keyword, fontStyle: 'italic' },
    ]);
}

/**
 * What a code pane changes about the editor's chrome: the text is monospace,
 * the gutter the note theme hides comes back, and the base colour is the one the
 * user's own editor uses for plain code. Everything else — the background, the
 * caret, the selection, the scrollbars — is inherited from the note theme, which
 * is what keeps a `.py` tab looking like the rest of the app.
 *
 * The gutter is painted in the app's own variables, not the palette's: a line
 * number is chrome, and chrome does not change per theme file.
 */
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
            // Fira Code with its ligatures on, which is what the user writes
            // code in elsewhere. index.html already loads it (400/500) for the
            // LaTeX source view, so this costs no new request, and the stack
            // falls back to the app's own monospace if it has not landed.
            fontFamily: "'Fira Code', var(--font-monospace)",
            fontVariantLigatures: 'contextual',
            fontFeatureSettings: '"calt" 1, "liga" 1',
            // Settings → Appearance → Code font size (App sets the variable).
            fontSize: 'var(--code-font-size, 14px)',
        },
        '&.cm-editor .cm-content': {
            lineHeight: '1.55',
            // The horizontal frame is index.css's (`.view-content.is-code`),
            // which has to win over the prose measure anyway; only the top air
            // is this theme's business.
            paddingTop: '12px',
        },
        '&.cm-editor .cm-gutters': {
            display: 'flex',
            backgroundColor: 'transparent',
            border: 'none',
            color: 'var(--text-faint)',
            // Ligatures deliberately off here: `11` in a line number is two
            // digits, not a glyph.
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
        // The bracket under the caret and its partner: the one piece of "where
        // am I" that colour alone cannot give.
        '&.cm-editor .cm-matchingBracket, &.cm-editor.cm-focused .cm-matchingBracket': {
            backgroundColor: dark ? 'rgba(255, 255, 255, 0.11)' : 'rgba(0, 0, 0, 0.09)',
            outline: `1px solid ${c.punctuation}66`,
        },
        '&.cm-editor .cm-nonmatchingBracket': { color: c.invalid },
        // ── Nesting colours (editor/rainbowBrackets.ts) ──
        // THE DESCENDANT SELECTOR IS THE WHOLE TRICK. A mark decoration WRAPS
        // the span the syntax highlighter already made, so the DOM is
        // `<span class="cm-bracket-depth-0"><span class="ͼ2i">(</span></span>`
        // — and the inner span is the one holding the text, so it is the one
        // that paints. Colouring only the outer element left every bracket in
        // the punctuation grey while `getComputedStyle` on that element happily
        // reported the rainbow colour: the bug reported from a screenshot that
        // three rounds of my own measuring missed, because I measured the
        // wrapper and not the element the text node hangs off.
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
        // Every other occurrence of whatever is selected.
        '&.cm-editor .cm-selectionMatch': {
            backgroundColor: dark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.07)',
        },
        // ── The completion list ──
        // Drawn like the app's own menus, not like a terminal's: the selected
        // row was the raw accent with white text on it, which on a green or
        // yellow accent is unreadable (and was). A tint of the accent over the
        // panel colour keeps the row legible whatever the accent is.
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
        // The part of the label that matched what was typed. CodeMirror
        // underlines it by default, which on a monospace list reads as a link.
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
