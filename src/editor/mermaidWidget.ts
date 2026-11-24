import { WidgetType } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';

/**
 * Mermaid is loaded ON FIRST USE, not at startup.
 *
 * A static import put mermaid plus its own dependencies (dompurify, marked, d3,
 * roughjs, …) — roughly 920KB of source, ~23% of the entry chunk — into every
 * session, parsed and compiled and module-initialized even for someone who
 * never writes a diagram. mermaid registers every diagram detector at import
 * time, so none of that was deferred.
 *
 * This is invisible because the seam already existed: renderInto is async and
 * already paints "Rendering diagram…" before doing any work, and the cache-hit
 * path below returns BEFORE touching this — so a diagram that has been rendered
 * once still fills in synchronously on every later rebuild, which is the
 * property that keeps diagrams from flickering.
 */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
const getMermaid = () => (mermaidPromise ??= import('mermaid').then(m => m.default));

/**
 * Mermaid renders asynchronously, but CodeMirror widgets must produce DOM
 * synchronously — so rendered SVG is cached by (theme, source). The first
 * render of a diagram shows a brief "rendering" placeholder; every rebuild
 * after that (cursor moves, edits elsewhere, mode toggles) fills the widget
 * synchronously from cache, so diagrams never flicker.
 */
const svgCache = new Map<string, string>();
const SVG_CACHE_MAX = 100;

/** Live widget containers — with their source and the view drawing them — so a
 *  theme toggle can re-render diagrams in place. */
const liveWidgets = new Map<HTMLElement, { code: string; view: EditorView }>();

let renderSeq = 0;

function currentTheme(): 'dark' | 'default' {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'default' : 'dark';
}

function cacheKey(code: string): string {
    // The separator is written as an ESCAPE. As a literal NUL byte it made this
    // whole module read as binary — `file` said "data" and plain `grep` skipped
    // it, so the two innerHTML writes below were invisible to any audit of the
    // app's innerHTML sinks (which is exactly how they went unlisted for two
    // releases). Same rule as tableWidget's slot sentinels.
    return `${currentTheme()}\u0000${code}`;
}

function cachePut(key: string, svg: string) {
    if (svgCache.size >= SVG_CACHE_MAX) {
        const oldest = svgCache.keys().next().value;
        if (oldest !== undefined) svgCache.delete(oldest);
    }
    svgCache.set(key, svg);
}

/**
 * Render `code` into `el`, from cache when possible. Errors render as a
 * compact message rather than mermaid's default bomb graphic — invalid
 * source usually just means the user is mid-edit somewhere else.
 */
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
        // A theme re-render swaps one SVG for another of a different size.
        view.requestMeasure();
        return;
    }

    el.classList.add('cm-mermaid-loading');
    el.textContent = 'Rendering diagram…';

    const id = `cm-mermaid-${renderSeq++}`;
    try {
        // Fetched once per session, inside the placeholder the user already sees.
        const mermaid = await getMermaid();
        // initialize() is global mutable state, so set the theme right before
        // each render — cheap, and it keeps light/dark rendering correct even
        // when renders for both themes interleave.
        mermaid.initialize({
            startOnLoad: false,
            theme: currentTheme(),
            securityLevel: 'strict',
            fontFamily: 'var(--font-ui, sans-serif)',
        });
        await mermaid.parse(code); // throws with a useful message on bad source
        const { svg } = await mermaid.render(id, code);
        cachePut(key, svg);
        // The widget may have been re-targeted while we awaited (rapid edits);
        // only paint if this element still wants this exact source.
        if (liveWidgets.get(el)?.code === code) {
            el.classList.remove('cm-mermaid-loading');
            el.innerHTML = svg;
            // CodeMirror ignores mutations inside a widget and would learn the
            // SVG's height only at its next measure — which a search jump held
            // centred must hear: twelve placeholders turning into diagrams ~230ms
            // after a jump left the match 733px below centre.
            view.requestMeasure();
        }
    } catch (e) {
        // A failed render can leave mermaid's scratch element in <body>.
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

// One observer for the whole app: when the theme attribute flips, re-render
// every diagram currently on screen with the new theme's palette.
//
// The detached-node sweep is defence in depth. CodeMirror does call
// widget.destroy() on every path that drops a widget's DOM, so entries should
// never outlive their element — but liveWidgets holds a STRONG reference, so a
// single missed destroy would both pin the subtree forever and make every
// subsequent theme toggle run a full mermaid render against a node nobody can
// see. Dropping disconnected elements here costs nothing and closes both.
new MutationObserver(() => {
    for (const [el, { code, view }] of liveWidgets) {
        if (!el.isConnected) { liveWidgets.delete(el); continue; }
        void renderInto(el, code, view);
    }
}).observe(document.documentElement, { attributeFilter: ['data-theme'] });

/**
 * A CodeMirror 6 widget that renders a ```mermaid fenced block as a diagram.
 *
 * Clicking the diagram places a caret beside it: this widget overrides
 * ignoreEvent to `return false`, so CodeMirror does NOT discard the click.
 * (hrWidget and mathWidget do the same; copyCodeWidget returns true instead,
 * keeping its button's clicks to itself.) Editing the source of a diagram
 * means putting the caret on one of the block's lines, which reveals the
 * fence the way any other code block's does. (A table used to be described
 * here as behaving the same way — it no longer does. Its cells are editable
 * islands that handle their own events; see tableWidget.ts.)
 */
export class MermaidWidget extends WidgetType {
    code: string;

    constructor(code: string) {
        super();
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
