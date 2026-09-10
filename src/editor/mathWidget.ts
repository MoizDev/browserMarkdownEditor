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
 * source" guard all read. Its cost is that the tree KaTeX hands back is
 * entirely `aria-hidden` with no MathML beside it, so a caller that puts one
 * somewhere a reader could not otherwise read the source owes it a label —
 * tableWidget's fillMathSlots does exactly that.
 *
 * TWO defaults are load-bearing BY ABSENCE, so think before adding either:
 *  · `trust` is left falsy, which is what turns `\href`, `\url`,
 *    `\includegraphics` and `\htmlClass/Id/Style/Data` into inert red text.
 *    It is the only thing keeping note text from emitting ATTRIBUTES one call
 *    away from the app's innerHTML sink, in an origin holding the vault's
 *    directory handle. Turning it on to make `\href` work is not a local
 *    change.
 *  · `maxSize` is left at KaTeX's Infinity. Measured, `$\rule{9999em}{9999em}$`
 *    in a cell produced a 193,601px row — self-inflicted, and it is the one way
 *    note text can still break "a cell is one line" (which the fitter's height
 *    accounting rests on). Capping it would change note bodies too, so it is a
 *    deliberate open question rather than an oversight.
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
