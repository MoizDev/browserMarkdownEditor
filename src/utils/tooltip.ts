import { getContextMenu } from './contextMenu';
import { getBoardPreferences } from './boardPreferences';

const SHOW_DELAY_MS = 400;
const WARM_MS = 300;
const ENHANCED_LEAVE_GRACE_MS = 300;
const GAP_PX = 8;
const MARGIN_PX = 8;
const ARROW_INSET_PX = 10;

type Side = 'top' | 'bottom' | 'left' | 'right';

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

let installed = false;
let bubble: HTMLDivElement | null = null;
let target: Element | null = null;
let shown = false;
let dismissed = false;
let showTimer = 0;
let hiddenAt = -Infinity;
let observer: MutationObserver | null = null;
function enhanced(): boolean {
    return getBoardPreferences().enhancedA11yMode;
}
let leaveTimer = 0;
let lastX = NaN, lastY = NaN, waitingForMove = false;

function tooltipText(el: Element): string {
    return el.getAttribute('data-tooltip')?.trim() ?? '';
}


function ensureBubble(): HTMLDivElement {
    if (bubble) return bubble;
    bubble = document.createElement('div');
    bubble.className = 'tooltip';
    bubble.setAttribute('role', 'tooltip');
    bubble.style.display = 'none';
    bubble.addEventListener('pointerleave', () => { if (enhanced()) leave(); });
    document.body.appendChild(bubble);
    return bubble;
}

function place(el: Element, box: HTMLDivElement): void {
    const t = el.getBoundingClientRect();
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
        top = clamp(side === 'bottom' ? t.bottom + GAP_PX : t.top - GAP_PX - h, MARGIN_PX, vh - MARGIN_PX - h);
        left = clamp(t.left + t.width / 2 - w / 2, MARGIN_PX, vw - MARGIN_PX - w);
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
    const text = el.isConnected ? tooltipText(el) : '';
    if (!text) { reset(); return; }
    const menuOpenHere = (el.hasAttribute('aria-haspopup') && el.getAttribute('aria-expanded') === 'true')
        || getContextMenu()?.anchor === el;
    if (menuOpenHere) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { reset(); return; }
    const box = ensureBubble();
    box.style.pointerEvents = promptFor(el) ? 'auto' : '';
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

function leave(): void {
    if (shown) hiddenAt = performance.now();
    hideBubble();
    target = null;
    dismissed = false;
    waitingForMove = false;
}

function reset(): void {
    hideBubble();
    target = null;
    dismissed = false;
    waitingForMove = false;
}

function dismiss(): void {
    if (!target) return;
    hideBubble();
    dismissed = true;
}

export function setEnhancedBoardTooltips(on: boolean): void {
    if (!on) cancelLeave();
}

function promptFor(el: Element): boolean {
    return enhanced() && el.closest('.board-chrome-overlay') !== null;
}

function cancelLeave(): void {
    if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = 0; }
}

function onPointerOver(e: PointerEvent): void {
    if (e.pointerType === 'touch') return;
    const resting = e.clientX === lastX && e.clientY === lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (e.target instanceof Node && bubble?.contains(e.target)) { cancelLeave(); return; }
    const el = e.target instanceof Element ? e.target.closest('[data-tooltip]') : null;
    if (el === target) { cancelLeave(); return; }
    cancelLeave();
    if (!el || !tooltipText(el)) { reset(); return; }
    const warm = shown || performance.now() - hiddenAt < WARM_MS, instant = promptFor(el);
    hideBubble();
    target = el;
    dismissed = false;
    if (bubble) bubble.style.pointerEvents = instant ? 'auto' : '';
    waitingForMove = resting;
    if (resting) return;
    arm(warm || instant);
}

function arm(now: boolean): void {
    if (now) show();
    else showTimer = window.setTimeout(show, SHOW_DELAY_MS);
}

function onPointerMove(e: PointerEvent): void {
    if (e.pointerType === 'touch' || (e.clientX === lastX && e.clientY === lastY)) return;
    lastX = e.clientX; lastY = e.clientY;
    if (!waitingForMove || !target) return;
    waitingForMove = false;
    if (!dismissed) arm(target !== null && promptFor(target));
}

function onPointerOut(e: PointerEvent): void {
    if (!target) return;
    const to = e.relatedTarget;
    if (to instanceof Node && target.contains(to)) return;
    if (to instanceof Node && bubble?.contains(to)) return;
    if (!dismissed && shown && promptFor(target)) {
        cancelLeave();
        leaveTimer = window.setTimeout(() => { leaveTimer = 0; leave(); }, ENHANCED_LEAVE_GRACE_MS);
        return;
    }
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
    document.addEventListener('pointermove', onPointerMove, opts);
    for (const type of DISMISSERS) document.addEventListener(type, dismiss, opts);
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('blur', reset);
    return () => {
        document.removeEventListener('pointerover', onPointerOver, opts);
        document.removeEventListener('pointerout', onPointerOut, opts);
        document.removeEventListener('pointermove', onPointerMove, opts);
        for (const type of DISMISSERS) document.removeEventListener(type, dismiss, opts);
        document.removeEventListener('visibilitychange', onHidden);
        window.removeEventListener('blur', reset);
        cancelLeave();
        reset();
        observer = null;
        bubble?.remove();
        bubble = null;
        installed = false;
    };
}
