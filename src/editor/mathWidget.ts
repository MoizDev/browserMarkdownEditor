import { WidgetType } from '@codemirror/view';
import katex from 'katex';

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
            katex.render(this.latex, el, {
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
