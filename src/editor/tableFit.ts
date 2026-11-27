import type { EditorView } from '@codemirror/view';
import { preserveTableReadingSelection } from './tableReadingSelection';

const COMFORT_EM = 12;

const MIN_TABLE_FONT_PX = 11;
const MIN_SCALE = 0.6;
const HARD_MIN_FONT_PX = 8;
const HARD_MIN_SCALE = 0.45;

const SLACK_PX = 3;
const SLACK_RATIO = 1.005;

const MAX_FIT_PASSES = 3;
const FIT_EPSILON = 0.002;

const FONT_PROBE_TEXT = 'MWmw0123456789iIlL';

interface AppliedFit {
    avail: number;
    font: number;
    widths: string[];
    breaks: boolean[];
    fontSize: string;
    at: { avail: number; font: string };
}
const lastFit = new Map<string, AppliedFit>();
const FIT_CACHE_MAX = 32;

function editorMetrics(view: EditorView): { avail: number; font: string } {
    const dom = view.contentDOM;
    const cs = getComputedStyle(dom);
    return {
        avail: dom.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        font: `${cs.fontSize} ${cs.fontFamily} ${cs.fontWeight}`,
    };
}

export interface TableFit {
    key: string;
    view: EditorView;
    container: HTMLElement;
    widthProbe: HTMLElement;
    fontProbe: HTMLElement;
    mathProbe: HTMLElement;
    table: HTMLTableElement;
    cols: HTMLTableColElement[];
    lastAvail: number;
    lastFont: number;
    lastBreaks: string;
    fitted: boolean;
}

const tracked = new Map<Element, TableFit>();

const observer = new ResizeObserver(entries => {
    const pending = new Set<TableFit>();
    for (const entry of entries) {
        const fit = tracked.get(entry.target);
        if (!fit) continue;
        if (!fit.container.isConnected) { releaseTableFit(fit.container); continue; }
        pending.add(fit);
    }
    for (const fit of pending) applyFit(fit);
});

function restoreFit(fit: TableFit): void {
    const done = lastFit.get(fit.key);
    if (!done || done.widths.length !== fit.cols.length) return;
    const now = editorMetrics(fit.view);
    if (Math.abs(done.at.avail - now.avail) > 0.5 || done.at.font !== now.font) return;
    fit.table.style.tableLayout = 'fixed';
    fit.table.style.fontSize = done.fontSize;
    for (let i = 0; i < fit.cols.length; i++) fit.cols[i].style.width = done.widths[i];
    for (const row of fit.table.rows) {
        for (let i = 0; i < fit.cols.length; i++) {
            if (row.cells[i]) row.cells[i].style.overflowWrap = done.breaks[i] ? 'break-word' : '';
        }
    }
    fit.lastAvail = done.avail;
    fit.lastFont = done.font;
    fit.lastBreaks = done.breaks.map((b, i) => (b ? `${i},` : '')).join('');
}

export function observeTableFit(fit: TableFit): void {
    restoreFit(fit);
    tracked.set(fit.container, fit);
    tracked.set(fit.widthProbe, fit);
    tracked.set(fit.fontProbe, fit);
    tracked.set(fit.mathProbe, fit);
    observer.observe(fit.widthProbe);
    observer.observe(fit.fontProbe);
    observer.observe(fit.mathProbe);
}

export function rekeyTableFit(container: Element, key: string): void {
    const fit = tracked.get(container);
    if (fit) fit.key = key;
}

const retunePending = new Set<TableFit>();
let retuneFrame = 0;

export function retuneTableFit(
    container: Element,
    key: string,
    next?: { table: HTMLTableElement; cols: HTMLTableColElement[] },
): void {
    const fit = tracked.get(container);
    if (!fit) return;
    fit.key = key;
    if (next) {
        fit.table = next.table;
        fit.cols = next.cols;
    }
    fit.lastAvail = -1;
    fit.lastFont = -1;
    fit.lastBreaks = '';
    fit.fitted = false;
    restoreFit(fit);

    retunePending.add(fit);
    if (retuneFrame) return;
    retuneFrame = requestAnimationFrame(() => {
        retuneFrame = 0;
        const due = [...retunePending];
        retunePending.clear();
        for (const pending of due) {
            if (!pending.container.isConnected) continue;
            if (tracked.get(pending.container) !== pending) continue;
            applyFit(pending);
        }
    });
}

export function releaseTableFit(container: Element): void {
    const fit = tracked.get(container);
    if (!fit) return;
    observer.unobserve(fit.widthProbe);
    observer.unobserve(fit.fontProbe);
    observer.unobserve(fit.mathProbe);
    tracked.delete(fit.container);
    tracked.delete(fit.widthProbe);
    tracked.delete(fit.fontProbe);
    tracked.delete(fit.mathProbe);
}

function columnWidths(table: HTMLTableElement, row: HTMLTableRowElement, count: number): number[] {
    const widths: number[] = [];
    let sum = 0;
    for (let i = 0; i < count; i++) {
        const w = row.cells[i].getBoundingClientRect().width;
        widths.push(w);
        sum += w;
    }
    const total = table.getBoundingClientRect().width;
    if (sum > 0 && total > 0) {
        const k = total / sum;
        for (let i = 0; i < count; i++) widths[i] *= k;
    }
    for (let i = 0; i < count; i++) widths[i] = widths[i] * SLACK_RATIO + SLACK_PX;
    return widths;
}

function shareOut(total: number, floors: number[], caps: number[]): number[] | null {
    const n = floors.length;
    let floorSum = 0, capSum = 0;
    for (let i = 0; i < n; i++) { floorSum += floors[i]; capSum += caps[i]; }
    if (floorSum > total) return null;
    if (capSum <= total) return capSum > 0 ? caps.map(c => c * (total / capSum)) : caps.slice();

    let lo = 0, hi = 0;
    for (const c of caps) if (c > hi) hi = c;
    for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2;
        let sum = 0;
        for (let j = 0; j < n; j++) sum += Math.min(Math.max(mid, floors[j]), caps[j]);
        if (sum < total) lo = mid; else hi = mid;
    }
    const level = (lo + hi) / 2;
    return floors.map((f, j) => Math.min(Math.max(level, f), caps[j]));
}

const NO_FLOORS = (count: number): number[] => new Array(count).fill(0);

function floorFor(fontPx: number, minPx: number, minRatio: number): number {
    return Math.min(1, Math.max(minRatio, minPx / fontPx));
}

function applyFit(fit: TableFit): void {
    const { table, cols, container } = fit;
    const count = cols.length;
    const row = table.rows[0];
    if (!count || !row || row.cells.length < count) return;

    const avail = fit.widthProbe.getBoundingClientRect().width;
    const fontWidth = fit.fontProbe.getBoundingClientRect().width
        + fit.mathProbe.getBoundingClientRect().width;
    const heightBefore = container.getBoundingClientRect().height;
    // A pane with no layout yet — or one that has been hidden — measures zero.
    // Keep whatever fit the table already has and wait to be shown.
    // Deliberately BEFORE the inputs are recorded below, so a zero measurement
    // can never be mistaken for a fit.
    if (!(avail > 0) || !(fontWidth > 0)) return;
    if (avail === fit.lastAvail && fontWidth === fit.lastFont) return;

    const fontPx = parseFloat(getComputedStyle(container).fontSize) || 16;
    const comfort = COMFORT_EM * fontPx;
    const comfortFloor = floorFor(fontPx, MIN_TABLE_FONT_PX, MIN_SCALE);
    const hardFloor = floorFor(fontPx, HARD_MIN_FONT_PX, HARD_MIN_SCALE);

    const measure = () => {
        table.style.tableLayout = 'auto';
        for (const col of cols) col.style.width = '';
        table.style.width = 'max-content';
        const wide = columnWidths(table, row, count);
        table.style.width = 'min-content';
        const tight = columnWidths(table, row, count);
        table.style.width = '';
        return { wide, tight };
    };

    let scale = 1;
    let wide: number[] = [];
    let tight: number[] = [];
    for (let pass = 0; ; pass++) {
        table.style.fontSize = scale < 1 ? `${scale.toFixed(4)}em` : '';
        ({ wide, tight } = measure());
        if (pass === MAX_FIT_PASSES) break;

        let wrapsNothing = 0;
        let wordsWhole = 0;
        for (let i = 0; i < count; i++) {
            wrapsNothing += Math.min(wide[i], comfort * scale);
            wordsWhole += Math.min(tight[i], comfort * scale);
        }

        let target = scale;
        if (wrapsNothing > avail) target = Math.max(comfortFloor, scale * avail / wrapsNothing);
        if (wordsWhole > avail) target = Math.min(target, Math.max(hardFloor, scale * avail / wordsWhole));

        if (target >= scale - FIT_EPSILON) break;
        scale = target;
    }

    const floors = tight.map(t => Math.min(t, comfort * scale));
    const widths = shareOut(avail, floors, wide)
        ?? shareOut(avail, NO_FLOORS(count), floors)!;

    let sum = 0;
    for (const w of widths) sum += w;
    const pcts = widths.map(w => `${(w / (sum || 1) * 100).toFixed(4)}%`);
    const fontSize = scale < 1 ? `${scale.toFixed(4)}em` : '';
    table.style.tableLayout = 'fixed';
    for (let i = 0; i < count; i++) cols[i].style.width = pcts[i];
    table.style.fontSize = fontSize;

    let key = '';
    const breaks = tight.map((t, i) => {
        const broken = t > widths[i] + 0.5;
        if (broken) key += `${i},`;
        return broken;
    });
    if (key !== fit.lastBreaks) {
        fit.lastBreaks = key;
        for (const r of table.rows) {
            for (let i = 0; i < count; i++) {
                if (r.cells[i]) r.cells[i].style.overflowWrap = breaks[i] ? 'break-word' : '';
            }
        }
    }

    fit.lastAvail = avail;
    fit.lastFont = fontWidth;
    const firstFitOfThisWidget = !fit.fitted;
    fit.fitted = true;

    if (lastFit.size >= FIT_CACHE_MAX) {
        const oldest = lastFit.keys().next().value;
        if (oldest !== undefined) lastFit.delete(oldest);
    }
    lastFit.delete(fit.key);
    lastFit.set(fit.key, {
        avail, font: fontWidth, widths: pcts, breaks, fontSize, at: editorMetrics(fit.view),
    });

    if (Math.abs(container.getBoundingClientRect().height - heightBefore) > 0.5) {
        fit.view.requestMeasure();
        if (firstFitOfThisWidget) {
            const restore = preserveTableReadingSelection(table, fit.view);
            fit.view.dispatch({ selection: fit.view.state.selection });
            restore?.();
        }
    }
}

export function createFitProbes(): { probe: HTMLElement; fontProbe: HTMLElement; mathProbe: HTMLElement } {
    const probe = document.createElement('div');
    probe.className = 'cm-table-probe';
    probe.setAttribute('aria-hidden', 'true');

    const fontProbe = document.createElement('span');
    fontProbe.textContent = FONT_PROBE_TEXT;
    for (const [bold, italic] of [[true, false], [true, true], [false, true]]) {
        const weight = document.createElement('span');
        weight.style.fontWeight = bold ? '700' : '400';
        if (italic) weight.style.fontStyle = 'italic';
        weight.textContent = FONT_PROBE_TEXT;
        fontProbe.appendChild(weight);
    }
    probe.appendChild(fontProbe);

    const mathProbe = document.createElement('span');
    for (const family of ["'KaTeX_Main', serif", "'KaTeX_Math', serif"]) {
        const face = document.createElement('span');
        face.textContent = FONT_PROBE_TEXT;
        face.style.fontFamily = family;
        if (family.includes('Math')) face.style.fontStyle = 'italic';
        mathProbe.appendChild(face);
    }
    probe.appendChild(mathProbe);

    return { probe, fontProbe, mathProbe };
}
