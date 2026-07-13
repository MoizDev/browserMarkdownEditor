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
        try {
            katex.render(normalizeForKatex(this.latex), el, {
                displayMode: this.displayMode,
                throwOnError: false,
                output: 'html',
            });
        } catch (e) {
            el.textContent = this.latex;
            el.classList.add('cm-math-error');
        }
        return el;
    }

    ignoreEvent(): boolean {
        return false;
    }
}
