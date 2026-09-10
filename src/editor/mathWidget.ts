import { WidgetType } from '@codemirror/view';
import katex from 'katex';

/**
 * KaTeX doesn't implement the top-level LaTeX document environments that
 * MathJax (and therefore Obsidian) accepts — \begin{equation} makes it error
 * out in red. Map them onto KaTeX's supported equivalents: the equation-like
 * wrappers just disappear (the $ delimiters already established math mode),
 * and the multiline ones become their KaTeX-native aligned/gathered forms.
 */
function normalizeForKatex(latex: string): string {
    return latex
        .replace(/\\(begin|end)\{(equation|displaymath|math)\*?\}/g, '')
        .replace(/\\(begin|end)\{(align|flalign|eqnarray)\*?\}/g, '\\$1{aligned}')
        .replace(/\\(begin|end)\{gather\*?\}/g, '\\$1{gathered}');
}

/**
 * Render `latex` into `el` with this app's one set of KaTeX options.
 *
 * Exported because the table cell renderer needs the SAME call, and a second
 * copy of these options is the "three things exist twice" hazard in miniature.
 * It is a DOM builder, not a second innerHTML sink: katex.render builds its
 * tree with createElement/createTextNode, so no note text is ever parsed as
 * markup here (see tableWidget.ts's allowlist note, which is the app's only
 * innerHTML write site for note text).
 *
 * `output: 'html'` is load-bearing for a table cell as much as for a widget:
 * it suppresses KaTeX's parallel MathML layer, so `el.textContent` stays the
 * visible glyphs once. With the default 'htmlAndMathml' every formula appears
 * TWICE in a cell's textContent — which tableEdit.ts's caret arithmetic, its
 * copy path and beginCellEdit's "does the rendered text differ from the raw
 * source" guard all read.
 */
export function renderMath(el: HTMLElement, latex: string, displayMode: boolean): void {
    try {
        katex.render(normalizeForKatex(latex), el, {
            displayMode,
            throwOnError: false,
            output: 'html',
        });
    } catch {
        el.textContent = latex;
        el.classList.add('cm-math-error');
    }
}

/**
 * A CodeMirror 6 widget that renders LaTeX math via KaTeX.
 */
export class MathWidget extends WidgetType {
    latex: string;
    displayMode: boolean;

    constructor(latex: string, displayMode: boolean = false) {
        super();
        this.latex = latex;
        this.displayMode = displayMode;
    }

    eq(other: MathWidget): boolean {
        return other.latex === this.latex && other.displayMode === this.displayMode;
    }

    toDOM(): HTMLElement {
        const el = document.createElement(this.displayMode ? 'div' : 'span');
        el.className = this.displayMode ? 'cm-math-widget cm-math-block' : 'cm-math-widget cm-math-inline';
        renderMath(el, this.latex, this.displayMode);
        return el;
    }

    ignoreEvent(): boolean {
        return false;
    }
}
