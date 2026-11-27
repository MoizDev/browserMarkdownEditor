import { WidgetType } from '@codemirror/view';
import { countEditorWidget } from './editorPerf';
import { loadChunk } from '../platform/chunkLoad';

type Katex = typeof import('katex').default;
let katex: Katex | null = null;
let loading: Promise<void> | null = null;

function loadKatex(): Promise<void> {
    loading ??= loadChunk(() => import('katex')).then(m => { katex = m.default; }).catch(() => { loading = null; });
    return loading;
}

export function warmMath(): void {
    if (!katex) void loadKatex();
}

function normalizeForKatex(latex: string): string {
    return latex
        .replace(/\\(begin|end)\{(equation|displaymath|math)\*?\}/g, '')
        .replace(/\\(begin|end)\{(align|flalign|eqnarray)\*?\}/g, '\\$1{aligned}')
        .replace(/\\(begin|end)\{gather\*?\}/g, '\\$1{gathered}');
}

/**
 *  · `trust` is left falsy, which is what turns `\href`, `\url`,
 *    `\includegraphics` and `\htmlClass/Id/Style/Data` into inert red text.
 *    It is the only thing keeping note text from emitting ATTRIBUTES one call
 *    away from the app's innerHTML sink, in an origin holding the vault's
 *    directory handle. Turning it on to make `\href` work is not a local
 *    change.
 */
export function renderMath(el: HTMLElement, latex: string, displayMode: boolean): void {
    if (!katex) {
        el.textContent = latex;
        el.dataset.mathPending = latex;
        void loadKatex().then(() => {
            if (!katex || el.dataset.mathPending !== latex) return;
            delete el.dataset.mathPending;
            el.textContent = '';
            renderMath(el, latex, displayMode);
        });
        return;
    }
    delete el.dataset.mathPending;
    try {
        katex!.render(normalizeForKatex(latex), el, {
            displayMode,
            throwOnError: false,
            output: 'html',
        });
        for (const err of el.querySelectorAll<HTMLElement>('.katex-error[title]')) {
            err.dataset.tooltip = err.getAttribute('title') ?? '';
            err.removeAttribute('title');
        }
    } catch {
        el.textContent = latex;
        el.classList.add('cm-math-error');
    }
}

export class MathWidget extends WidgetType {
    latex: string;
    displayMode: boolean;

    constructor(latex: string, displayMode: boolean = false) {
        super();
        if (__BME_BENCH__) { countEditorWidget(); }
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
