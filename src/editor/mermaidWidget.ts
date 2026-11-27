import { WidgetType } from '@codemirror/view';
import { countEditorWidget } from './editorPerf';
import type { EditorView } from '@codemirror/view';
import { loadChunk } from '../platform/chunkLoad';

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
const getMermaid = () => {
    if (!mermaidPromise) {
        const attempt = loadChunk(() => import('mermaid')).then(m => m.default);
        mermaidPromise = attempt;
        attempt.catch(() => { if (mermaidPromise === attempt) mermaidPromise = null; });
    }
    return mermaidPromise;
};

const svgCache = new Map<string, string>();
const SVG_CACHE_MAX = 100;

const liveWidgets = new Map<HTMLElement, { code: string; view: EditorView }>();

let renderSeq = 0;

function currentTheme(): 'dark' | 'default' {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'default' : 'dark';
}

function cacheKey(code: string): string {
    return `${currentTheme()}\u0000${code}`;
}

function cachePut(key: string, svg: string) {
    if (svgCache.size >= SVG_CACHE_MAX) {
        const oldest = svgCache.keys().next().value;
        if (oldest !== undefined) svgCache.delete(oldest);
    }
    svgCache.set(key, svg);
}

async function renderInto(el: HTMLElement, code: string, view: EditorView): Promise<void> {
    /* THE APP'S SECOND innerHTML SINK for note text, and the only one not
       covered by tableWidget's attribute-free allowlist: `svg` below is
       mermaid's rendering of a note's ```mermaid block. It is safe only because
       `securityLevel: 'strict'` (set at every render, below) puts mermaid's own
       DOMPurify pass in front of it — i.e. this one rests on a bundled
       sanitiser, where the cell renderer rests on emitting no attributes at
       all. This origin holds the vault's directory handle with permission
       granted, so keep it that way: do not relax securityLevel, and do not add
       a third sink. */
    const key = cacheKey(code);
    const cached = svgCache.get(key);
    if (cached) {
        el.innerHTML = cached;
        view.requestMeasure();
        return;
    }

    el.classList.add('cm-mermaid-loading');
    el.textContent = 'Rendering diagram…';

    const id = `cm-mermaid-${renderSeq++}`;
    try {
        const mermaid = await getMermaid();
        mermaid.initialize({
            startOnLoad: false,
            theme: currentTheme(),
            securityLevel: 'strict',
            fontFamily: 'var(--font-ui, sans-serif)',
        });
        await mermaid.parse(code);
        const { svg } = await mermaid.render(id, code);
        cachePut(key, svg);
        if (liveWidgets.get(el)?.code === code) {
            el.classList.remove('cm-mermaid-loading');
            el.innerHTML = svg;
            view.requestMeasure();
        }
    } catch (e) {
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
        if (liveWidgets.get(el)?.code === code) {
            el.classList.remove('cm-mermaid-loading');
            el.classList.add('cm-mermaid-error');
            const msg = e instanceof Error ? e.message : String(e);
            el.textContent = `Mermaid: ${msg}`;
            view.requestMeasure();
        }
    }
}

new MutationObserver(() => {
    for (const [el, { code, view }] of liveWidgets) {
        if (!el.isConnected) { liveWidgets.delete(el); continue; }
        void renderInto(el, code, view);
    }
}).observe(document.documentElement, { attributeFilter: ['data-theme'] });

export class MermaidWidget extends WidgetType {
    code: string;

    constructor(code: string) {
        super();
        if (__BME_BENCH__) { countEditorWidget(); }
        this.code = code;
    }

    eq(other: MermaidWidget): boolean {
        return other.code === this.code;
    }

    toDOM(view: EditorView): HTMLElement {
        const el = document.createElement('div');
        el.className = 'cm-mermaid-widget';
        liveWidgets.set(el, { code: this.code, view });
        void renderInto(el, this.code, view);
        return el;
    }

    destroy(dom: HTMLElement): void {
        liveWidgets.delete(dom);
    }

    ignoreEvent(): boolean {
        return false;
    }
}
