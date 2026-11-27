import { EditorView, WidgetType, keymap } from '@codemirror/view';
import { countEditorWidget } from './editorPerf';
import { EditorSelection, Facet, Prec } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { embedPattern, embedText } from '../utils/assets';
import type { AssetUrlResolver } from '../types';
import { canWrite } from './readingMode';

export interface ImageEmbedActions {
    confirmDelete(request: ImageDeleteRequest): void;
}

export interface ImageDeleteRequest {
    name: string;
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
    editable: boolean;
}

export const imageEmbedActions = Facet.define<ImageEmbedActions, ImageEmbedActions | null>({
    combine: values => (values.length ? values[0] : null),
});

const STEP_SHARE = 0.1;
const MIN_STEP = 24;
const MIN_WIDTH = 40;

const NARROW_WIDTH = 120;

const pendingRetries = new Set<() => void>();

export function retryMissingAssets(): void {
    for (const retry of [...pendingRetries]) retry();
}

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

function selectEmbed(view: EditorView, at: EmbedAt): void {
    view.dispatch({ selection: EditorSelection.single(at.from, at.to) });
    view.focus();
}

function availableWidth(view: EditorView, dom: HTMLElement): number {
    const line = dom.closest('.cm-line') as HTMLElement | null;
    return Math.max(MIN_WIDTH, Math.round((line ?? view.contentDOM).clientWidth));
}

function resizeEmbed(view: EditorView, dom: HTMLElement, model: ImageModel, direction: 1 | -1): void {
    const at = embedAt(view, dom, model.name);
    if (!at) return;

    const available = availableWidth(view, dom);
    const current = at.width ?? Math.round(model.img.getBoundingClientRect().width);
    if (!current) return;

    const step = Math.max(MIN_STEP, Math.round(available * STEP_SHARE));
    const next = Math.max(MIN_WIDTH, Math.min(available, current + direction * step));
    if (next === at.width) return;

    const text = embedText(at.name, next);
    view.dispatch({
        changes: { from: at.from, to: at.to, insert: text },
        selection: EditorSelection.single(at.from, at.from + text.length),
    });
    view.focus();
}

function removeEmbed(view: EditorView, at: EmbedAt): void {
    if (!view.dom.isConnected) return;
    let { from, to } = at;
    // The confirmation is modal, so the document cannot have moved — and if it
    // somehow has, this bails rather than guessing. Searching the document for
    // the same text would find the FIRST embed of that picture, which on a note
    // showing it twice (or after the pane swapped to another tab) is a
    // different one entirely — the wrong thing to delete without asking.
    if (to > view.state.doc.length || view.state.sliceDoc(from, to) !== at.text) return;

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

const BIN_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>' +
    '<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>' +
    '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

function toolButton(cls: string, title: string, onPress: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = `cm-image-tool ${cls}`;
    button.type = 'button';
    button.dataset.tooltip = title;
    button.setAttribute('aria-label', title);
    button.tabIndex = -1;
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
        if (__BME_BENCH__) { countEditorWidget(); }
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
        const remeasure = () => view.requestMeasure();
        img.addEventListener('load', remeasure);
        img.addEventListener('error', remeasure);

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

        container.addEventListener('mousedown', (event) => {
            if (!model.ctx.editable || event.button !== 0) return;
            event.preventDefault();
            const at = embedAt(view, container, model.name);
            if (at) selectEmbed(view, at);
        });

        model.resolve = () => {
            if (pendingRetries.has(model.resolve) && !container.isConnected) {
                pendingRetries.delete(model.resolve);
                return;
            }
            const wanted = model.name;
            model.ctx.getAssetUrl(wanted).then((url) => {
                if (model.dead || model.name !== wanted) return;
                if (url) {
                    pendingRetries.delete(model.resolve);
                    img.src = url;
                    img.style.display = 'block';
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
                    view.requestMeasure();
                }
            });
        };

        applyState(container, model, this.filename, this.width, this.ctx, this.selected, true);
        return container;
    }

    updateDOM(dom: HTMLElement, _view: EditorView): boolean {
        const model = (dom as WidgetDom)[MODEL];
        if (!model) return false;
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

    model.img.style.width = width ? `${width}px` : '';
    container.classList.toggle('cm-image-selected', selected);
    container.classList.toggle('cm-image-editable', ctx.editable);

    if (selected) {
        const shown = model.img.style.display !== 'none';
        const measured = shown ? model.img.getBoundingClientRect().width : 0;
        container.classList.toggle('cm-image-narrow', measured > 0 && measured < NARROW_WIDTH);
    }
}

function deleteSelectedImage(view: EditorView): boolean {
    if (!canWrite(view.state)) return false;
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
