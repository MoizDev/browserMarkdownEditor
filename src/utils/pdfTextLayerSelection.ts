interface TextPoint {
    node: Text;
    offset: number;
}

const distance = (value: number, min: number, max: number) => Math.max(min - value, 0, value - max);

/** Empty margins have no browser caret: absolutely positioned spans leave DOM
 *  order unrelated to the line beside the pointer. Prefer that line, then the
 *  nearest span on it; do not alter native drags that start on a glyph. */
function nearestEnd(layer: Element, x: number, y: number): TextPoint | undefined {
    let best: Element | undefined;
    let dy = Infinity;
    let dx = Infinity;
    for (const span of layer.querySelectorAll('span:not(.markedContent):not([role="img"])')) {
        if (!span.textContent) continue;
        const rect = span.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const vertical = distance(y, rect.top, rect.bottom);
        const horizontal = distance(x, rect.left, rect.right);
        if (vertical < dy || (vertical === dy && horizontal < dx)) {
            best = span;
            dy = vertical;
            dx = horizontal;
        }
    }
    if (!best) return;
    const walker = document.createTreeWalker(best, NodeFilter.SHOW_TEXT);
    const first = walker.nextNode() as Text | null;
    if (!first) return;
    let last = first;
    while (walker.nextNode()) last = walker.currentNode as Text;
    // Endpoint glyph boxes also handle RTL and /Rotate; the logical first end
    // need not be at the visual left of the span.
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(first, Math.min(1, first.length));
    const a = range.getBoundingClientRect();
    range.setStart(last, Math.max(0, last.length - 1));
    range.setEnd(last, last.length);
    const b = range.getBoundingClientRect();
    const da = Math.hypot(x - (a.left + a.right) / 2, y - (a.top + a.bottom) / 2);
    const db = Math.hypot(x - (b.left + b.right) / 2, y - (b.top + b.bottom) / 2);
    return da <= db ? { node: first, offset: 0 } : { node: last, offset: last.length };
}

function layerAt(root: HTMLElement, x: number, y: number): Element | undefined {
    const hit = document.elementFromPoint(x, y)?.closest('.pdf-viewer-page')?.querySelector('.textLayer');
    if (hit && root.contains(hit)) return hit;
    let best: Element | undefined;
    let dy = Infinity;
    let dx = Infinity;
    for (const layer of root.querySelectorAll('.textLayer')) {
        if (!layer.childNodes.length) continue;
        const rect = layer.getBoundingClientRect();
        const vertical = distance(y, rect.top, rect.bottom);
        const horizontal = distance(x, rect.left, rect.right);
        if (vertical < dy || (vertical === dy && horizontal < dx)) {
            best = layer;
            dy = vertical;
            dx = horizontal;
        }
    }
    return best;
}

function focusAt(root: HTMLElement, x: number, y: number): TextPoint | undefined {
    const hit = document.elementFromPoint(x, y)?.closest('.textLayer span');
    if (hit && root.contains(hit)) {
        const caret = document.caretPositionFromPoint(x, y);
        const node = caret?.offsetNode;
        if (node instanceof Text && hit.contains(node)) return { node, offset: caret!.offset };
    }
    const layer = layerAt(root, x, y);
    return layer ? nearestEnd(layer, x, y) : undefined;
}

/** One delegated binding per viewer rather than a listener retained by each
 *  page: text-layer windowing/replacement needs no separate teardown path. */
export function bindPdfTextLayerSelection(root: HTMLElement): () => void {
    let drag: { id: number; layer: Element; anchor: TextPoint } | undefined;
    const finish = () => {
        const previous = drag;
        drag = undefined;
        if (previous?.layer.hasPointerCapture(previous.id)) previous.layer.releasePointerCapture(previous.id);
    };
    const pointerDown = (event: PointerEvent) => {
        if (event.button !== 0 || !event.isPrimary || event.shiftKey || !(event.target instanceof Element) || !event.target.matches('.textLayer')) return;
        const layer = event.target;
        const anchor = nearestEnd(layer, event.clientX, event.clientY);
        const selection = document.getSelection();
        if (!anchor || !selection) return;
        finish();
        event.preventDefault();
        selection.setBaseAndExtent(anchor.node, anchor.offset, anchor.node, anchor.offset);
        drag = { id: event.pointerId, layer, anchor };
        layer.setPointerCapture(event.pointerId);
    };
    const pointerMove = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.id) return;
        const focus = focusAt(root, event.clientX, event.clientY);
        if (focus) document.getSelection()?.setBaseAndExtent(drag.anchor.node, drag.anchor.offset, focus.node, focus.offset);
    };
    const pointerEnd = (event: PointerEvent) => { if (event.pointerId === drag?.id) finish(); };
    const selectAll = (event: KeyboardEvent) => {
        if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'a') return;
        const target = event.target;
        if (target instanceof HTMLElement && (target.closest('input, textarea, select') || target.isContentEditable)) return;
        const layers = root.querySelectorAll('.textLayer');
        const first = Array.from(layers).find(layer => layer.childNodes.length);
        const last = Array.from(layers).reverse().find(layer => layer.childNodes.length);
        // Even a textless page must not select app chrome.
        event.preventDefault();
        const selection = document.getSelection();
        if (!selection) return;
        selection.removeAllRanges();
        if (!first || !last) return;
        const range = document.createRange();
        range.setStart(first, 0);
        range.setEnd(last, last.childNodes.length);
        selection.addRange(range);
    };
    root.addEventListener('pointerdown', pointerDown);
    root.addEventListener('pointermove', pointerMove);
    root.addEventListener('pointerup', pointerEnd);
    root.addEventListener('pointercancel', pointerEnd);
    root.addEventListener('lostpointercapture', pointerEnd);
    root.addEventListener('keydown', selectAll, true);
    return () => {
        finish();
        root.removeEventListener('pointerdown', pointerDown);
        root.removeEventListener('pointermove', pointerMove);
        root.removeEventListener('pointerup', pointerEnd);
        root.removeEventListener('pointercancel', pointerEnd);
        root.removeEventListener('lostpointercapture', pointerEnd);
        root.removeEventListener('keydown', selectAll, true);
    };
}
