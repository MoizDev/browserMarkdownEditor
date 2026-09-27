// The app's own tooltip: an Obsidian-style dark bubble with a pointer, drawn for
// any element carrying `data-tooltip="…"` (and, optionally,
// `data-tooltip-position="top|bottom|left|right"`, default bottom).
//
// A DOM controller, not a React component, on purpose: the CodeMirror widgets in
// src/editor/ (heading fold, image, table, copy-code) and pdf.js's link overlays
// are React-free and outlive the panes that made them, so the only contract they
// can honour is "set an attribute". One delegated listener on `document` serves
// every one of them, and every React control, for the app's whole life — no
// per-element listener, no provider, no re-render. Installed once from main.tsx,
// outside React, which also keeps StrictMode's double effects away from it.
//
// Why not the native `title`: Chromium's is an OS-styled box that appears after
// ~1.5s, cannot be themed and draws no pointer; and hijacking `title` at runtime
// would hide which elements have one. eslint.config.ts bans `title` outright.
//
// Disabled `<button>`s need nothing special — measured in headless Chromium 1.63:
// `pointerover`/`pointerout` fire on a disabled button and on a child inside one,
// so a disabled control's tooltip (the reason it cannot act) still shows.

import { getContextMenu } from './contextMenu';

const SHOW_DELAY_MS = 400;
// Sliding from one control to the next along a toolbar shows the next bubble at
// once, the way Obsidian's does, instead of making the reader wait again.
const WARM_MS = 300;
// Bubble body to target edge; the arrow sits inside this gap.
const GAP_PX = 8;
// Nearest the bubble may come to a viewport edge.
const MARGIN_PX = 8;
// Nearest the arrow's centre may come to a bubble corner: 4px radius + 5px half-arrow.
const ARROW_INSET_PX = 10;

type Side = 'top' | 'bottom' | 'left' | 'right';

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

let installed = false;
let bubble: HTMLDivElement | null = null;
// The element being hovered that owns a tooltip — pending, shown, or dismissed.
let target: Element | null = null;
let shown = false;
// A click, key, scroll… dismissed the bubble: it stays down until the pointer
// leaves the target, as the native tooltip does, instead of popping back up
// under a pointer that has only moved across a child of the same button.
let dismissed = false;
let showTimer = 0;
let hiddenAt = -Infinity;
let observer: MutationObserver | null = null;

function tooltipText(el: Element): string {
    return el.getAttribute('data-tooltip')?.trim() ?? '';
}

function ensureBubble(): HTMLDivElement {
    if (bubble) return bubble;
    bubble = document.createElement('div');
    bubble.className = 'tooltip';
    bubble.setAttribute('role', 'tooltip');
    bubble.style.display = 'none';
    document.body.appendChild(bubble);
    return bubble;
}

function place(el: Element, box: HTMLDivElement): void {
    const t = el.getBoundingClientRect();
    // Measure at the origin: a fixed box left near the right edge by its last
    // target shrinks-to-fit into what remains and would wrap a short label.
    box.style.left = '0px';
    box.style.top = '0px';
    const { width: w, height: h } = box.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    const fits = (side: Side): boolean => {
        switch (side) {
            case 'bottom': return t.bottom + GAP_PX + h <= vh - MARGIN_PX;
            case 'top': return t.top - GAP_PX - h >= MARGIN_PX;
            case 'right': return t.right + GAP_PX + w <= vw - MARGIN_PX;
            case 'left': return t.left - GAP_PX - w >= MARGIN_PX;
        }
    };
    const asked = el.getAttribute('data-tooltip-position');
    let side: Side = asked === 'top' || asked === 'left' || asked === 'right' ? asked : 'bottom';
    if (!fits(side) && fits(OPPOSITE[side])) side = OPPOSITE[side];

    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
    let left: number;
    let top: number;
    if (side === 'top' || side === 'bottom') {
        // Clamped too, for a target so tall that neither side fits: an
        // overlapping bubble still beats one cut off by the window.
        top = clamp(side === 'bottom' ? t.bottom + GAP_PX : t.top - GAP_PX - h, MARGIN_PX, vh - MARGIN_PX - h);
        left = clamp(t.left + t.width / 2 - w / 2, MARGIN_PX, vw - MARGIN_PX - w);
        // Clamping moved the bubble, not the arrow: it keeps pointing at the
        // target's centre, stopping short of the rounded corner.
        box.style.setProperty('--tooltip-arrow-x', `${clamp(t.left + t.width / 2 - left, ARROW_INSET_PX, w - ARROW_INSET_PX)}px`);
        box.style.removeProperty('--tooltip-arrow-y');
    } else {
        left = side === 'right' ? t.right + GAP_PX : t.left - GAP_PX - w;
        left = clamp(left, MARGIN_PX, vw - MARGIN_PX - w);
        top = clamp(t.top + t.height / 2 - h / 2, MARGIN_PX, vh - MARGIN_PX - h);
        box.style.setProperty('--tooltip-arrow-y', `${clamp(t.top + t.height / 2 - top, ARROW_INSET_PX, h - ARROW_INSET_PX)}px`);
        box.style.removeProperty('--tooltip-arrow-x');
    }
    box.className = `tooltip mod-${side}`;
    box.style.left = `${Math.round(left)}px`;
    box.style.top = `${Math.round(top)}px`;
}

function show(): void {
    showTimer = 0;
    const el = target;
    if (!el) return;
    // Read at show time, not hover time: the attribute may have gone, or the
    // element been unmounted, during the delay.
    const text = el.isConnected ? tooltipText(el) : '';
    if (!text) { reset(); return; }
    // No bubble on a trigger whose menu is open: it would land on the menu's
    // first rows (a bottom bubble sits 8px under the button, the menu 4px),
    // over the very thing the user is reading. The pointer only has to wander
    // back onto the button for that. A MENU trigger only (`aria-haspopup`):
    // plain disclosures — a heading's fold arrow, the canvas style panel —
    // carry `aria-expanded="true"` too, and their tooltips must still show.
    // That covers the explorer's dropdowns and the vault switcher; the anchor
    // test covers the shared menu's other raisers (the tab strip's ⌄, a
    // pane's ⋯, the table grips).
    const menuOpenHere = (el.hasAttribute('aria-haspopup') && el.getAttribute('aria-expanded') === 'true')
        || getContextMenu()?.anchor === el;
    if (menuOpenHere) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { reset(); return; }
    const box = ensureBubble();
    // textContent ONLY. File names, paths and pdf.js link titles are untrusted
    // text, and AGENTS.md allows exactly two note-text → innerHTML sinks
    // (tableWidget's renderCellContent, mermaidWidget's renderInto) — this
    // origin holds read/write permission over the whole vault. Not a third.
    box.textContent = text;
    box.style.display = '';
    place(el, box);
    shown = true;
    watch(el);
}

// While a bubble is up, a target that disappears (a row unmounted under a still
// pointer fires no pointerout) or loses its text must take the bubble with it.
function watch(el: Element): void {
    observer ??= new MutationObserver(() => {
        if (!shown || !target) return;
        if (!target.isConnected) { reset(); return; }
        const text = tooltipText(target);
        if (!text) { reset(); return; }
        if (bubble && bubble.textContent !== text) {
            bubble.textContent = text;
            place(target, bubble);
        }
    });
    observer.observe(el, { attributes: true, attributeFilter: ['data-tooltip'] });
    observer.observe(document.body, { childList: true, subtree: true });
}

function hideBubble(): void {
    if (showTimer) { clearTimeout(showTimer); showTimer = 0; }
    observer?.disconnect();
    if (shown && bubble) bubble.style.display = 'none';
    shown = false;
}

// Pointer left the target: the next hover within WARM_MS shows at once.
function leave(): void {
    if (shown) hiddenAt = performance.now();
    hideBubble();
    target = null;
    dismissed = false;
}

// Forget the target outright, and do not warm the next hover.
function reset(): void {
    hideBubble();
    target = null;
    dismissed = false;
}

// A click, key, wheel, scroll or drag: down, and kept down until the pointer leaves.
function dismiss(): void {
    if (!target) return;
    hideBubble();
    dismissed = true;
}

function onPointerOver(e: PointerEvent): void {
    if (e.pointerType === 'touch') return;
    const el = e.target instanceof Element ? e.target.closest('[data-tooltip]') : null;
    if (el === target) return;
    if (!el || !tooltipText(el)) { reset(); return; }
    const warm = shown || performance.now() - hiddenAt < WARM_MS;
    hideBubble();
    target = el;
    dismissed = false;
    if (warm) show();
    else showTimer = window.setTimeout(show, SHOW_DELAY_MS);
}

function onPointerOut(e: PointerEvent): void {
    if (!target) return;
    const to = e.relatedTarget;
    if (to instanceof Node && target.contains(to)) return;
    if (dismissed) reset();
    else leave();
}

const DISMISSERS = ['pointerdown', 'keydown', 'wheel', 'dragstart', 'scroll'] as const;

export function installTooltips(): () => void {
    if (installed) return () => {};
    installed = true;
    // Capture phase throughout: plenty of the app's handlers stopPropagation, and
    // a pointerdown swallowed before it bubbles must still take the bubble down.
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    const onHidden = () => { if (document.visibilityState === 'hidden') reset(); };
    document.addEventListener('pointerover', onPointerOver, opts);
    document.addEventListener('pointerout', onPointerOut, opts);
    for (const type of DISMISSERS) document.addEventListener(type, dismiss, opts);
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('blur', reset);
    return () => {
        document.removeEventListener('pointerover', onPointerOver, opts);
        document.removeEventListener('pointerout', onPointerOut, opts);
        for (const type of DISMISSERS) document.removeEventListener(type, dismiss, opts);
        document.removeEventListener('visibilitychange', onHidden);
        window.removeEventListener('blur', reset);
        reset();
        observer = null;
        bubble?.remove();
        bubble = null;
        installed = false;
    };
}
