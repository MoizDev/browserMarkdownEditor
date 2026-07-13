import { WidgetType } from '@codemirror/view';

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
    /** @param code The block's inner text, fences excluded — what Cmd+C would want. */
    constructor(readonly code: string) {
        super();
    }

    override eq(other: CopyCodeWidget): boolean {
        return other.code === this.code;
    }

    override toDOM(): HTMLElement {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cm-codeblock-copy';
        btn.title = 'Copy code';
        btn.setAttribute('aria-label', 'Copy code');
        btn.innerHTML = COPY_ICON;

        // A click must copy, not relocate the caret into the code block.
        btn.onmousedown = (e) => e.preventDefault();
        btn.onclick = () => {
            navigator.clipboard.writeText(this.code).then(() => {
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
