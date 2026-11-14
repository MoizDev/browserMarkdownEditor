import { EditorView, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { countEditorWidget } from './editorPerf';

// Same lucide outline style as components/icons.tsx, but as plain strings —
// widgets build raw DOM, not React.
const SVG_ATTRS =
    'viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const COPY_ICON =
    `<svg ${SVG_ATTRS}><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>` +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = `<svg ${SVG_ATTRS}><polyline points="20 6 9 17 4 12"/></svg>`;

const COPIED_FEEDBACK_MS = 1200;

/**
 * The "copy code" affordance in a fenced block's top-right corner. Anchored to
 * the block's first (fence) row, which the live preview keeps as the panel's
 * top padding, so the button rides the top of the panel in every mode.
 */
export class CopyCodeWidget extends WidgetType {
    constructor() {
        super();
        if (__BME_BENCH__) { countEditorWidget(); }
    }

    override eq(): boolean { return true; }

    override toDOM(view: EditorView): HTMLElement {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cm-codeblock-copy';
        btn.dataset.tooltip = 'Copy code';
        btn.setAttribute('aria-label', 'Copy code');
        btn.innerHTML = COPY_ICON;
        // Never a tab stop, like every other widget button (headingFold,
        // tableWidget, imageWidget): after a tab click the note's scroller
        // holds the keyboard (#35), and in Reading mode Tab went to the first of
        // these in the DOM — often in the margin drawn ABOVE the screen, so the
        // view jumped 1–2 screens to it (measured: scrollTop 18139 → 17523) and
        // Space then pressed Copy instead of scrolling.
        btn.tabIndex = -1;

        // A click must copy, not relocate the caret into the code block.
        btn.onmousedown = (e) => e.preventDefault();
        btn.onclick = () => {
            let pos: number;
            try { pos = view.posAtDOM(btn); } catch { return; }
            const state = view.state, line = state.doc.lineAt(pos);
            let bounds: { from: number; to: number } | null = null;
            syntaxTree(state).iterate({ from: line.from, to: line.to, enter(node) {
                if (node.name !== 'FencedCode') return;
                const opening = node.node.firstChild, last = node.node.lastChild;
                if (opening?.name !== 'CodeMark' || state.doc.lineAt(opening.from).number !== line.number) return;
                const closing = last?.name === 'CodeMark' && last.from > opening.to ? last : null;
                const end = state.doc.lineAt(closing?.from ?? node.to);
                const closed = closing !== null && end.number > line.number && closing.to <= end.to;
                const first = line.number + 1, final = closed ? end.number - 1 : end.number;
                bounds = first <= final ? { from: state.doc.line(first).from, to: state.doc.line(final).to } : { from: line.to, to: line.to };
                return false;
            } });
            if (!bounds) return;
            const { from, to } = bounds as { from: number; to: number };
            navigator.clipboard.writeText(state.doc.sliceString(from, to)).then(() => {
                btn.innerHTML = CHECK_ICON;
                btn.classList.add('cm-codeblock-copy-done');
                setTimeout(() => {
                    btn.innerHTML = COPY_ICON;
                    btn.classList.remove('cm-codeblock-copy-done');
                }, COPIED_FEEDBACK_MS);
            }).catch((err) => console.error('Could not copy code block:', err));
        };

        return btn;
    }

    /** Let the button's own DOM handlers run instead of the editor's. */
    override ignoreEvent(): boolean {
        return true;
    }
}
