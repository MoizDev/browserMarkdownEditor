import { EditorView, WidgetType, keymap } from '@codemirror/view';
import { EditorSelection, Facet, Prec } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { embedPattern, embedText } from '../utils/assets';
import type { AssetUrlResolver } from '../types';

/* ── An embedded image is an OBJECT, not text ─────────────────────────────
 *
 * `![[diagram.png]]` is what the file holds — anyone opening the .md sees it —
 * but it is never what the reader of the note sees, in either mode. The embed
 * is replaced by the picture and stays replaced: clicking it does not turn it
 * back into markdown to be retyped, the way every other construct in the live
 * preview does. What a click does instead is SELECT it, the way a click selects
 * a picture in a word processor, and a selected picture carries the two things
 * you would want to do to one — resize it, or take it out.
 *
 * That makes the width syntax an implementation detail too: `|320` is written
 * into the document by the +/− buttons, and read back out of it to size the
 * image, but it is not something anyone has to know about or type.
 *
 * Three pieces cooperate to keep the object from ever coming apart:
 *   - the decoration is never suppressed by the cursor (livePreview.ts),
 *   - the range is registered as ATOMIC, so no arrow key, click or drag can
 *     put a caret inside it, and a Backspace beside it takes the whole embed,
 *   - the one exception is a caret that is *already* strictly inside, which
 *     only the keystrokes that typed the embed in the first place can produce
 *     — that reveals the raw text, so typing `![[a` doesn't vanish mid-word.
 */

/** What the widget needs from the app around it (EditorPane supplies it). */
export interface ImageEmbedActions {
    /** Confirm removing an embedded image with the user, then run `request.run`
     *  — nothing has happened to the document when this is called. */
    confirmDelete(request: ImageDeleteRequest): void;
}

export interface ImageDeleteRequest {
    /** The asset's file name, to name it in the confirmation. */
    name: string;
    /** Perform the removal. Not called if the user cancels. */
    run: () => void;
}

/**
 * Everything an image widget needs beyond its own name and width. ONE object
 * per live-preview instance, compared by identity in `eq` — so it must be
 * stable for the life of the pane (see EditorPane's `imageActions`).
 */
export interface ImageContext {
    getAssetUrl: AssetUrlResolver;
    actions: ImageEmbedActions;
    /** Edit mode: an image can be selected, resized and deleted. */
    editable: boolean;
}

/** Reaches the Backspace binding below, which has only a view to work from. */
export const imageEmbedActions = Facet.define<ImageEmbedActions, ImageEmbedActions | null>({
    combine: values => (values.length ? values[0] : null),
});

/* ── Resizing ──
   The step is a share of the width AVAILABLE to the note rather than of the
   image's own width, which makes + and − exact inverses: pressing one and then
   the other returns the picture to the size it started at. A step proportional
   to the current width would not — it shrinks as the image does. */
const STEP_SHARE = 0.1;
const MIN_STEP = 24;
const MIN_WIDTH = 40;

/** Below this the controls no longer fit over the picture and move above it. */
const NARROW_WIDTH = 120;

/** Widgets whose asset could not be resolved, so a picture that only turns up
 *  afterwards can be shown without rebuilding every image in the document.
 *
 *  An asset can arrive AFTER the widget that wants it: undoing the deletion of
 *  an embed puts the text back at once, while the reclaim of the asset itself
 *  waits for that edit to be saved (see App.reconcileAssets). Without this the
 *  picture would sit at "not found" until something else happened to rebuild it
 *  — a tab switch, a ⌘E — which reads as the reclaim having failed. */
const pendingRetries = new Set<() => void>();

/** Ask every unresolved image widget to look for its asset again. */
export function retryMissingAssets(): void {
    for (const retry of [...pendingRetries]) retry();
}

/**
 * The live state of one rendered image, hanging off its DOM.
 *
 * The DOM outlives the widget INSTANCE that built it — CodeMirror hands an
 * existing element to a later widget's updateDOM rather than rebuilding it —
 * so the buttons' handlers must not close over the widget that happened to
 * create them. They read this instead, and updateDOM refreshes it.
 */
interface ImageModel {
    name: string;
    width: number | null;
    ctx: ImageContext;
    img: HTMLImageElement;
    placeholder: HTMLElement;
    resolve: () => void;
    /** Set by destroy(). A resolve() already in flight when the widget goes
     *  away must not re-register itself for retries afterwards — the entry
     *  would pin the dropped DOM until the next reclaim happened to run. */
    dead: boolean;
}

const MODEL = Symbol('imageModel');
type WidgetDom = HTMLElement & { [MODEL]?: ImageModel };

/** The embed this DOM element stands for, located in the CURRENT document.
 *
 *  Recomputed on every action rather than remembered, because a widget knows
 *  its own contents and not where they sit — and by the time a button is
 *  pressed the document above it may have moved. `preferName` disambiguates
 *  two embeds that meet at the position we resolve to. */
interface EmbedAt {
    from: number;
    to: number;
    text: string;
    name: string;
    width: number | null;
}

function embedAt(view: EditorView, dom: HTMLElement, preferName?: string): EmbedAt | null {
    let pos: number;
    try {
        pos = view.posAtDOM(dom);
    } catch {
        return null;
    }
    const line = view.state.doc.lineAt(pos);
    const pattern = embedPattern();
    let fallback: EmbedAt | null = null;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(line.text)) !== null) {
        const from = line.from + m.index;
        const to = from + m[0].length;
        if (pos < from || pos > to) continue;
        const hit: EmbedAt = {
            from, to,
            text: m[0],
            name: m[1].trim(),
            width: m[2] ? parseInt(m[2], 10) : null,
        };
        if (!preferName || hit.name === preferName) return hit;
        fallback ??= hit;
    }
    return fallback;
}

/** Select the whole embed — the "this picture is the thing you are acting on"
 *  state, and what makes Backspace mean this image and nothing else. */
function selectEmbed(view: EditorView, at: EmbedAt): void {
    view.dispatch({ selection: EditorSelection.single(at.from, at.to) });
    view.focus();
}

/** The width the note itself has, which is as wide as a picture may get. */
function availableWidth(view: EditorView, dom: HTMLElement): number {
    const line = dom.closest('.cm-line') as HTMLElement | null;
    return Math.max(MIN_WIDTH, Math.round((line ?? view.contentDOM).clientWidth));
}

function resizeEmbed(view: EditorView, dom: HTMLElement, model: ImageModel, direction: 1 | -1): void {
    const at = embedAt(view, dom, model.name);
    if (!at) return;

    const available = availableWidth(view, dom);
    // The rendered width is the honest starting point for a picture that has
    // never been resized: it is what the reader is looking at, whether that is
    // the image's own size or the note's width capping it.
    const current = at.width ?? Math.round(model.img.getBoundingClientRect().width);
    if (!current) return;

    const step = Math.max(MIN_STEP, Math.round(available * STEP_SHARE));
    const next = Math.max(MIN_WIDTH, Math.min(available, current + direction * step));
    if (next === at.width) return;

    const text = embedText(at.name, next);
    view.dispatch({
        changes: { from: at.from, to: at.to, insert: text },
        // Stay selected, so the buttons are still there for the next press.
        selection: EditorSelection.single(at.from, at.from + text.length),
    });
    view.focus();
}

/**
 * Take the embed out of the document — after the app has confirmed it.
 *
 * The asset itself is not touched here: removing the reference is what retires
 * it (App.reconcileAssets, on the save a second later), which is also what
 * makes ⌘Z whole — the undone edit brings the reference back, and the reclaim
 * follows it out of `.Garbage` on the next save. Retiring the file here as
 * well would break exactly that, since an undo inside the debounce would then
 * leave the picture in the trash with the note still pointing at it.
 */
function removeEmbed(view: EditorView, at: EmbedAt): void {
    let { from, to } = at;
    // The confirmation is modal, so the document cannot have moved — and if it
    // somehow has, this bails rather than guessing. Searching the document for
    // the same text would find the FIRST embed of that picture, which on a note
    // showing it twice (or after the pane swapped to another tab) is a
    // different one entirely — the wrong thing to delete without asking.
    if (to > view.state.doc.length || view.state.sliceDoc(from, to) !== at.text) return;

    // An image on a line of its own IS that line, so the line goes with it
    // rather than being left behind as a blank one. On the last line there is
    // no trailing newline to take, so the preceding one goes instead.
    const line = view.state.doc.lineAt(from);
    if (line.text.trim() === at.text) {
        if (line.to < view.state.doc.length) {
            from = line.from;
            to = line.to + 1;
        } else if (line.from > 0) {
            from = line.from - 1;
            to = line.to;
        }
    }

    view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } });
    view.focus();
}

function requestDelete(view: EditorView, dom: HTMLElement, model: ImageModel): void {
    const at = embedAt(view, dom, model.name);
    if (!at) return;
    model.ctx.actions.confirmDelete({ name: at.name, run: () => removeEmbed(view, at) });
}

/** The app's bin icon (components/icons.tsx Trash2), as markup this non-React
 *  DOM can use. Static and self-authored — no input reaches it. */
const BIN_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>' +
    '<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>' +
    '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

/** A small square button floating over a corner of the picture. */
function toolButton(cls: string, title: string, onPress: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = `cm-image-tool ${cls}`;
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    // Never a tab stop: these live inside the document's contenteditable, where
    // tabbing to them would interrupt the note's own Tab handling.
    button.tabIndex = -1;
    // Keep the press from reaching the picture underneath (which would re-select
    // it) or the browser (which would move focus out of the editor).
    button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onPress();
    });
    return button;
}

export class ImageWidget extends WidgetType {
    constructor(
        readonly filename: string,
        readonly width: number | null,
        readonly ctx: ImageContext,
        readonly selected: boolean,
    ) {
        super();
    }

    eq(other: ImageWidget): boolean {
        return (
            other.filename === this.filename &&
            other.width === this.width &&
            other.ctx === this.ctx &&
            other.selected === this.selected
        );
    }

    toDOM(view: EditorView): HTMLElement {
        const container = document.createElement('span') as WidgetDom;
        container.className = 'cm-image-widget';

        const wrapper = document.createElement('span');
        wrapper.className = 'cm-image-wrapper';

        const img = document.createElement('img');
        img.style.display = 'none';
        img.draggable = false;

        const placeholder = document.createElement('span');
        placeholder.className = 'cm-image-placeholder';

        const tools = document.createElement('span');
        tools.className = 'cm-image-tools';
        const zoom = document.createElement('span');
        zoom.className = 'cm-image-zoom';

        wrapper.append(placeholder, img, tools);
        container.appendChild(wrapper);

        const model: ImageModel = {
            name: this.filename,
            width: this.width,
            ctx: this.ctx,
            img,
            placeholder,
            resolve: () => {},
            dead: false,
        };
        container[MODEL] = model;

        const bin = toolButton('cm-image-remove', 'Delete image', () => requestDelete(view, container, model));
        bin.innerHTML = BIN_SVG;
        const smaller = toolButton('cm-image-smaller', 'Smaller', () => resizeEmbed(view, container, model, -1));
        smaller.textContent = '−';
        const larger = toolButton('cm-image-larger', 'Larger', () => resizeEmbed(view, container, model, 1));
        larger.textContent = '+';
        zoom.append(smaller, larger);
        tools.append(bin, zoom);

        // A click anywhere on the picture selects it, like a picture in a word
        // processor. preventDefault keeps the browser from putting a text
        // caret inside the widget's own DOM; CodeMirror ignores events from
        // inside a widget (WidgetType.ignoreEvent), so this is the only thing
        // that decides what a click on an image means.
        container.addEventListener('mousedown', (event) => {
            if (!model.ctx.editable || event.button !== 0) return;
            event.preventDefault();
            const at = embedAt(view, container, model.name);
            if (at) selectEmbed(view, at);
        });

        model.resolve = () => {
            // On a RETRY (never the first call, where the widget has yet to be
            // inserted): a widget CodeMirror has already dropped can't show
            // anything, and clearing it here means the registry cannot outlive
            // its DOM even if destroy() never runs.
            if (pendingRetries.has(model.resolve) && !container.isConnected) {
                pendingRetries.delete(model.resolve);
                return;
            }
            const wanted = model.name;
            model.ctx.getAssetUrl(wanted).then((url) => {
                if (model.dead || model.name !== wanted) return;   // gone, or the embed changed under us
                if (url) {
                    pendingRetries.delete(model.resolve);
                    img.src = url;
                    img.style.display = 'block';
                    // Cleared, not merely hidden: a retry that succeeds must not
                    // leave the widget carrying "not found" underneath.
                    placeholder.classList.remove('error');
                    placeholder.style.display = 'none';
                    container.classList.add('cm-image-loaded');
                } else {
                    pendingRetries.add(model.resolve);
                    img.style.display = 'none';
                    placeholder.textContent =
                        `${wanted} not found — check .Assets in a parent folder, or above the vault root`;
                    placeholder.classList.add('error');
                    placeholder.style.display = '';
                    container.classList.remove('cm-image-loaded');
                }
            });
        };

        applyState(container, model, this.filename, this.width, this.ctx, this.selected, true);
        return container;
    }

    /**
     * Re-dress an existing picture instead of building a new one.
     *
     * Selecting an image, resizing it, or toggling ⌘E all change the widget, and
     * without this every one of them would drop the <img> and mint another —
     * which re-resolves the asset and flashes the picture back through its
     * "Loading…" placeholder. The element (and the decoded bitmap behind it) is
     * what has to survive; only its dressing changes.
     */
    updateDOM(dom: HTMLElement, _view: EditorView): boolean {
        const model = (dom as WidgetDom)[MODEL];
        if (!model) return false;      // not one of ours — let CodeMirror rebuild
        applyState(dom, model, this.filename, this.width, this.ctx, this.selected, false);
        return true;
    }

    destroy(dom: HTMLElement): void {
        const model = (dom as WidgetDom)[MODEL];
        if (model) {
            model.dead = true;
            pendingRetries.delete(model.resolve);
        }
    }
}

/** Bring one rendered image up to date with the widget describing it. */
function applyState(
    container: HTMLElement,
    model: ImageModel,
    name: string,
    width: number | null,
    ctx: ImageContext,
    selected: boolean,
    fresh: boolean,
): void {
    const reload = fresh || model.name !== name || model.ctx.getAssetUrl !== ctx.getAssetUrl;
    model.name = name;
    model.width = width;
    model.ctx = ctx;

    if (reload) {
        pendingRetries.delete(model.resolve);
        model.img.style.display = 'none';
        model.placeholder.classList.remove('error');
        model.placeholder.style.display = '';
        model.placeholder.textContent = `Loading ${name}...`;
        container.classList.remove('cm-image-loaded');
        model.resolve();
    }

    // A picture with no width of its own fills whatever the note allows.
    model.img.style.width = width ? `${width}px` : '';
    container.classList.toggle('cm-image-selected', selected);
    container.classList.toggle('cm-image-editable', ctx.editable);

    // A picture the reader has shrunk can be narrower than its own controls,
    // which would then cover the whole of it. Measured only when it is selected
    // — the only time the answer is used, and rare enough that the layout read
    // costs nothing.
    if (selected) {
        const shown = model.img.style.display !== 'none';
        const measured = shown ? model.img.getBoundingClientRect().width : 0;
        container.classList.toggle('cm-image-narrow', measured > 0 && measured < NARROW_WIDTH);
    }
}

/**
 * Backspace (or Delete) with a picture selected removes it — through the same
 * confirmation the bin button uses, because it is the same act.
 *
 * Only when the selection is EXACTLY one embed, which is the state a click on a
 * picture produces and nothing else does: a selection that merely contains an
 * image is a stretch of prose the reader means to delete, and interrupting that
 * with a dialog would be wrong.
 */
function deleteSelectedImage(view: EditorView): boolean {
    if (!view.state.facet(EditorView.editable)) return false;
    const actions = view.state.facet(imageEmbedActions);
    if (!actions) return false;

    const { ranges, main } = view.state.selection;
    if (ranges.length !== 1 || main.empty) return false;

    const text = view.state.sliceDoc(main.from, main.to);
    const pattern = embedPattern();
    const m = pattern.exec(text);
    if (!m || m.index !== 0 || m[0].length !== text.length) return false;

    const at: EmbedAt = {
        from: main.from,
        to: main.to,
        text,
        name: m[1].trim(),
        width: m[2] ? parseInt(m[2], 10) : null,
    };
    actions.confirmDelete({ name: at.name, run: () => removeEmbed(view, at) });
    return true;
}

/** Above the default keymap, which would otherwise delete the embed outright
 *  (the range is atomic) with no confirmation and no name to show. */
export const imageEmbedKeymap: Extension = Prec.high(keymap.of([
    { key: 'Backspace', run: deleteSelectedImage },
    { key: 'Delete', run: deleteSelectedImage },
]));
