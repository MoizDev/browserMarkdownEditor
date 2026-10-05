// The code palettes — One Dark Darker and One Light — as plain values, in a
// module that imports nothing. Code panes (codeHighlight.ts) build their
// highlighting from them, and the terminal (TerminalPanel/terminalTheme.ts)
// seeds its 16 ANSI colours from them, so `ls`, `git diff` and a source file in
// a pane are one colour scheme. Import-free so the terminal chunk can read a
// handful of strings without pulling a CodeMirror module along.

/** One Dark Darker, as the theme file states it. */
export const CODE_DARK = {
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
export const CODE_LIGHT: CodePalette = {
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

export type CodePalette = typeof CODE_DARK;
