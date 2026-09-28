// The <bme-context> block: what the user is looking at, built FRESH for every
// message and prefixed to it, so the agent never has to be told "I'm on page 3"
// and stays right when the user scrolls, switches tab or draws between two
// messages of the same chat.
//
// Sources, all live: App's workspace snapshot (vault, panes, tabs) plus each
// mounted pane's reporter in utils/viewRegistry.ts — asked here, at send time,
// never on a timer. Nothing is read from storage except, for a tab with no
// mounted pane, the position it will reopen at (`workspace.remembered`).
//
// Filled in a fixed priority against CONTEXT_CHAR_BUDGET:
//   1. vault name + id, local date and time
//   2. the pane layout: panes left→right, their tabs, the focused one
//   3. one line per open tab, with its exact position
//   4. the FOCUSED document — a note in full (unsaved edits, ⟦sel⟧/⟦cursor⟧
//      markers), a PDF's visible page text, a canvas's shapes in view
//   5. the other VISIBLE panes — only what is on screen in them
// Whatever does not fit is cut with an explicit `…[truncated N chars; read with
// vault_read]`, so the agent knows to go and read it. No file tree: the agent
// has vault_list / vault_search for that.
//
// Pure apart from awaiting reporters (which may render, for the picture). No
// React, no tldraw, no pdf.js — this runs on every send, on the panel's path.

import { CONTEXT_CLOSE_TAG, CONTEXT_OPEN_TAG } from '../../shared/vaultAgentProtocol';
import type { AgentTabInfo, AgentWorkspaceSnapshot, RememberedPosition } from '../types/vaultAgent';
import { getView, type ShapeSummary, type ViewInfo, type ViewReporter } from './viewRegistry';
import { AGENT_IMAGE_MAX_SIDE, blobBytes, bytesToBase64, sha256Hex } from './agentMedia';
import { formatShape } from './canvasFileSummary';
import { REPLY_MODE_LINE, type ReplyMode } from './agentReplyMode';

export interface BuiltContext {
    /** The <bme-context>…</bme-context> block (ends with a newline). */
    text: string;
    /** A PNG of the focused canvas/PDF view, only when it changed since `lastImageHash`. */
    image: { mimeType: 'image/png'; data: string; hash: string } | null;
}

/** The whole block's size, in characters (~15k tokens). */
export const CONTEXT_CHAR_BUDGET = 60_000;

/** A reporter that takes longer than this is left out rather than holding up
 *  the send. describe() is meant to be cheap; text extraction and a capture
 *  may render. */
const DESCRIBE_TIMEOUT_MS = 2_000;
const PDF_TEXT_TIMEOUT_MS = 6_000;
const CAPTURE_TIMEOUT_MS = 8_000;
/** Visible PDF pages whose text goes in, at most. */
const MAX_PDF_PAGES = 4;
/** The tab list may take this share of the budget before it is cut. */
const TAB_LIST_SHARE = 0.25;
/** Room kept back from the focused document for each other visible pane. */
const OTHER_PANE_RESERVE = 4_000;
/** A single line (a minified file, a data URI) is cut at this. */
const MAX_LINE = 2_000;

const truncMarker = (chars: number, where = '') =>
    `…[truncated ${chars} chars${where}; read with vault_read]`;

function withTimeout<T>(value: T | Promise<T>, ms: number): Promise<T | null> {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), ms);
        Promise.resolve(value).then(
            v => { clearTimeout(timer); resolve(v); },
            () => { clearTimeout(timer); resolve(null); },
        );
    });
}

/** Cut `text` to `budget` chars with a marker saying how much went. */
function fit(text: string, budget: number): string {
    if (text.length <= budget) return text;
    const keep = Math.max(0, budget - 90);
    return `${text.slice(0, keep)}\n${truncMarker(text.length - keep)}`;
}

/** Note text must not be able to end the block early (or open a fake one):
 *  a `</bme-context>` typed in a note is shown with a look-alike bracket. */
const TAG_NAME = CONTEXT_OPEN_TAG.slice(1, -1);
const TAG_RE = new RegExp(`<(/?)(${TAG_NAME})`, 'gi');
function neutralize(text: string): string {
    return text.replace(TAG_RE, '‹$1$2');
}

/* ───────────────────────── small formatters ───────────────────────── */

const pct = (fraction: number) => `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
/** A zoom factor as a percentage — unclamped: 1.5 is 150%. */
const zoomPct = (z: number) => `${Math.round(z * 100)}%`;
const r1 = (n: number) => String(Math.round(n * 10) / 10);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function pageList(pages: number[]): string {
    if (!pages.length) return 'none';
    const sorted = [...pages].sort((a, b) => a - b);
    const runs: string[] = [];
    let start = sorted[0];
    let prev = sorted[0];
    for (const p of [...sorted.slice(1), NaN]) {
        if (p === prev + 1) { prev = p; continue; }
        runs.push(start === prev ? String(start) : `${start}–${prev}`);
        start = prev = p;
    }
    return runs.join(', ');
}

function localTime(now = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const offset = -now.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const abs = Math.abs(offset);
    let zone = '';
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''; } catch { /* unknown zone */ }
    const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} (${weekday})`
        + `, ${zone ? `${zone}, ` : ''}UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function kindLabel(tab: AgentTabInfo, info: ViewInfo | undefined): string {
    switch (tab.kind) {
        case 'markdown': return `note, ${tab.mode === 'read' ? 'reading' : 'editing'} mode`;
        case 'text': return `text file, ${tab.mode === 'read' ? 'reading' : 'editing'} mode`;
        case 'pdf': return info?.kind === 'pdf-annotate' ? 'PDF, annotating' : 'PDF';
        case 'drawing': return 'drawing';
        case 'notebook': return 'notebook';
        case 'image': return 'image';
        case 'help': return 'the app\'s Help guide (not a vault file)';
        default: return 'file';
    }
}

function livePosition(info: ViewInfo): string {
    switch (info.kind) {
        case 'markdown': {
            const parts = [`lines ${info.visibleLines.from}–${info.visibleLines.to} of ${info.lineCount} on screen`, `cursor ${info.cursor.line}:${info.cursor.col}`];
            if (info.selections.length) {
                parts.push(`${plural(info.selections.length, 'selection')} (${info.selections.slice(0, 3)
                    .map(s => `${s.fromLC.line}:${s.fromLC.col}–${s.toLC.line}:${s.toLC.col}`).join(', ')}${info.selections.length > 3 ? ', …' : ''})`);
            }
            return parts.join(', ');
        }
        case 'pdf':
        case 'pdf-annotate': {
            const parts = [`page ${info.page} of ${info.pageCount} (${pct(info.offset)} down the page)`, `zoom ${zoomPct(info.zoom)} of fit-width`, `pages on screen: ${pageList(info.visiblePages)}`];
            if (info.selectedText) parts.push('has a text selection');
            return parts.join(', ');
        }
        case 'drawing': {
            const v = info.viewport;
            return `tldraw page "${info.pageName}" (${info.pageIndex + 1} of ${info.pageCount}), zoom ${zoomPct(info.camera.z)}, `
                + `showing x ${r1(v.x)}…${r1(v.x + v.w)}, y ${r1(v.y)}…${r1(v.y + v.h)}, `
                + `${plural(info.shapesTotal, 'shape')} in view${info.selectedShapeIds.length ? `, ${info.selectedShapeIds.length} selected` : ''}`;
        }
        case 'notebook':
            return `page ${info.page} of ${info.pageCount} (${pct(info.offset)} down the page), zoom ${zoomPct(info.zoom)} of fit-width, `
                + `pages on screen: ${pageList(info.visiblePages)}, ${plural(info.shapesTotal, 'shape')} on them`
                + `${info.selectedShapeIds.length ? `, ${info.selectedShapeIds.length} selected` : ''}`;
    }
}

function rememberedPosition(pos: RememberedPosition | null): string {
    if (!pos) return 'position not known (it opens at the start)';
    switch (pos.kind) {
        case 'markdown': return `will reopen at line ${pos.line}`;
        case 'pdf': return `will reopen at page ${pos.page} (${pct(pos.offset)} down)${pos.zoom ? `, zoom ${zoomPct(pos.zoom)}` : ''}`;
        case 'drawing': return `will reopen with the camera at x ${r1(pos.x)}, y ${r1(pos.y)}, zoom ${zoomPct(pos.z)}`;
        case 'notebook': return `will reopen at page ${pos.page} (${pct(pos.offset)} down)`;
    }
}

function shapeBlock(shapes: ShapeSummary[] | undefined, total: number | undefined, budget: number, what: string): string {
    const list = shapes ?? [];
    const count = total ?? list.length;
    if (!count) return `${what}: none.`;
    const lines = [`${what} (${count}${count > list.length ? `, first ${list.length} listed` : ''}; full list with canvas_shapes):`];
    let used = lines[0].length;
    for (let i = 0; i < list.length; i++) {
        const line = formatShape(list[i], 120);
        if (used + line.length + 1 > budget) {
            lines.push(`…[${list.length - i} more not shown; list them with canvas_shapes]`);
            break;
        }
        lines.push(line);
        used += line.length + 1;
    }
    return lines.join('\n');
}

/* ───────────────────────── markdown with markers ───────────────────────── */

function cutLine(line: string): string {
    return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…[line cut: ${line.length} chars]` : line;
}

/** The note's text with ⟦sel⟧…⟦/sel⟧ around each selection and ⟦cursor⟧ at a
 *  cursor that is not already a selection's end. Markers hold no newline, so
 *  line numbers are the file's. */
function markText(info: Extract<ViewInfo, { kind: 'markdown' }>): string {
    const marks: Array<{ at: number; order: number; text: string }> = [];
    for (const s of info.selections) {
        marks.push({ at: s.from, order: 1, text: '⟦sel⟧' });
        marks.push({ at: s.to, order: 0, text: '⟦/sel⟧' });
    }
    const onEdge = info.selections.some(s => s.from === info.cursorOffset || s.to === info.cursorOffset);
    if (!onEdge) marks.push({ at: info.cursorOffset, order: 2, text: '⟦cursor⟧' });
    marks.sort((a, b) => a.at - b.at || a.order - b.order);
    let out = '';
    let at = 0;
    for (const m of marks) {
        const pos = Math.max(at, Math.min(info.text.length, m.at));
        out += info.text.slice(at, pos) + m.text;
        at = pos;
    }
    return out + info.text.slice(at);
}

/**
 * Numbered lines of `text`, all of them if they fit in `budget`; otherwise the
 * window that does fit, grown outward from the lines on screen (and the
 * cursor), with what was left out marked above and below.
 */
function numberedWindow(text: string, budget: number, focus: { from: number; to: number; anchor: number }): string {
    const lines = text.split('\n').map((l, i) => `${i + 1}\t${cutLine(l)}`);
    const total = lines.reduce((n, l) => n + l.length + 1, 0);
    if (total <= budget) return lines.join('\n');

    const n = lines.length;
    const room = Math.max(0, budget - 240); // the two markers
    const clamp = (x: number) => Math.max(1, Math.min(n, x));
    let lo = clamp(focus.anchor);
    let hi = lo;
    let used = lines[lo - 1].length + 1;
    const tryAdd = (line: number) => {
        const cost = lines[line - 1].length + 1;
        if (used + cost > room) return false;
        used += cost;
        return true;
    };
    // The screen first, then outward on both sides.
    const vFrom = clamp(focus.from);
    const vTo = clamp(focus.to);
    while (hi < vTo && tryAdd(hi + 1)) hi++;
    while (lo > vFrom && tryAdd(lo - 1)) lo--;
    for (let grew = true; grew;) {
        grew = false;
        if (hi < n && tryAdd(hi + 1)) { hi++; grew = true; }
        if (lo > 1 && tryAdd(lo - 1)) { lo--; grew = true; }
    }
    const before = lines.slice(0, lo - 1).reduce((c, l) => c + l.length + 1, 0);
    const after = lines.slice(hi).reduce((c, l) => c + l.length + 1, 0);
    const out: string[] = [];
    if (lo > 1) out.push(truncMarker(before, ` (lines 1–${lo - 1})`));
    out.push(...lines.slice(lo - 1, hi));
    if (hi < n) out.push(truncMarker(after, ` (lines ${hi + 1}–${n})`));
    return out.join('\n');
}

/* ───────────────────────── per-document sections ───────────────────────── */

async function pdfPagesText(view: ViewReporter, pages: number[], budget: number): Promise<string> {
    if (!view.pdfText || !pages.length) return '';
    const wanted = [...pages].sort((a, b) => a - b).slice(0, MAX_PDF_PAGES);
    const got = await withTimeout(view.pdfText(wanted), PDF_TEXT_TIMEOUT_MS);
    if (!got) return 'Text of the pages on screen: could not be extracted in time (read it with vault_read).';
    const parts = got.sort((a, b) => a.page - b.page)
        .map(p => `--- page ${p.page} ---\n${p.text.trim() || '(no text on this page — a scan or a drawing; see the picture or vault_view)'}`);
    if (pages.length > wanted.length) parts.push(`(pages ${pageList(pages.filter(p => !wanted.includes(p)))} are also on screen)`);
    return fit(`Text of the pages on screen:\n${parts.join('\n')}`, budget);
}

/** The focused document in as much detail as `budget` allows. */
async function focusedSection(tab: AgentTabInfo, view: ViewReporter | undefined, info: ViewInfo | undefined, budget: number, imageLine: string | null): Promise<string> {
    const head = [`=== Focused document: ${tab.path} (${kindLabel(tab, info)}${tab.dirty ? ', unsaved changes' : ''}) ===`];
    if (tab.unreadable) head.push('Its tab could not read the file, so what it shows is not the file\'s content.');
    if (imageLine) head.push(imageLine);

    if (!info || !view) {
        if (tab.kind === 'help') head.push('The user is reading the app\'s built-in Help guide.');
        else head.push('Its view is not available right now; read it with vault_read if you need it.');
        return head.join('\n');
    }

    switch (info.kind) {
        case 'markdown': {
            head.push(`On screen: lines ${info.visibleLines.from}–${info.visibleLines.to} of ${info.lineCount}. Cursor: line ${info.cursor.line}, column ${info.cursor.col}.`);
            if (info.selections.length) {
                head.push(`Selected: ${info.selections.map(s => `${s.fromLC.line}:${s.fromLC.col}–${s.toLC.line}:${s.toLC.col}`).join(', ')}.`);
            }
            head.push('Its full current text follows (unsaved edits included), each line as "<n><tab>text"; ⟦sel⟧…⟦/sel⟧ marks a selection and ⟦cursor⟧ the cursor — neither the numbers nor the markers are in the file.');
            const headText = head.join('\n');
            const anchor = info.cursor.line >= info.visibleLines.from && info.cursor.line <= info.visibleLines.to ? info.cursor.line : info.visibleLines.from;
            const body = numberedWindow(markText(info), budget - headText.length - 1, { from: info.visibleLines.from, to: info.visibleLines.to, anchor });
            return `${headText}\n${body}`;
        }
        case 'pdf':
        case 'pdf-annotate': {
            head.push(`${livePosition(info)}.${info.inverted ? ' (Shown with dark-mode inversion; the pages themselves are normal.)' : ''}`);
            if (info.selectedText) head.push(`Selected text: ${JSON.stringify(fit(info.selectedText, 4_000))}`);
            if (info.kind === 'pdf-annotate') {
                head.push('The user is annotating this PDF (a canvas over its pages); annotation coordinates are page-relative.');
                if (info.selectedShapeIds?.length) head.push(`Selected annotations: ${info.selectedShapeIds.join(', ')}`);
            }
            let text = head.join('\n');
            if (info.kind === 'pdf-annotate') text += `\n${shapeBlock(info.shapes, info.shapesTotal, Math.floor((budget - text.length) / 3), 'Annotations on the pages on screen')}`;
            const pages = await pdfPagesText(view, info.visiblePages, budget - text.length - 1);
            return pages ? `${text}\n${pages}` : text;
        }
        case 'drawing': {
            head.push(`${livePosition(info)}. Canvas coordinates; camera x ${r1(info.camera.x)}, y ${r1(info.camera.y)}.`);
            if (info.selectedShapeIds.length) head.push(`Selected: ${info.selectedShapeIds.join(', ')}`);
            const text = head.join('\n');
            return `${text}\n${shapeBlock(info.shapes, info.shapesTotal, budget - text.length - 1, 'Shapes in view')}`;
        }
        case 'notebook': {
            head.push(`${livePosition(info)}${info.paper ? `; paper: ${info.paper}` : ''}. Coordinates are page-relative (points from the top-left of each page).`);
            if (info.selectedShapeIds.length) head.push(`Selected: ${info.selectedShapeIds.join(', ')}`);
            const text = head.join('\n');
            return `${text}\n${shapeBlock(info.shapes, info.shapesTotal, budget - text.length - 1, 'Shapes on the pages on screen')}`;
        }
    }
}

/** Another pane on screen: only what the user can see in it. */
async function visibleSection(paneNo: number, tab: AgentTabInfo, view: ViewReporter | undefined, info: ViewInfo | undefined, budget: number): Promise<string> {
    const head = `=== Also on screen, pane ${paneNo}: ${tab.path} (${kindLabel(tab, info)}${tab.dirty ? ', unsaved changes' : ''}) ===`;
    if (!info || !view) return `${head}\n(not available right now; read it with vault_read)`;
    const room = budget - head.length - 1;
    switch (info.kind) {
        case 'markdown': {
            const { from, to } = info.visibleLines;
            const lines = info.text.split('\n').slice(from - 1, to).map((l, i) => `${from + i}\t${cutLine(l)}`);
            return `${head}\nLines ${from}–${to} of ${info.lineCount} (what is on screen):\n${fit(lines.join('\n'), room - 60)}`;
        }
        case 'pdf':
        case 'pdf-annotate': {
            let text = `${head}\n${livePosition(info)}.`;
            if (info.selectedText) text += `\nSelected text: ${JSON.stringify(fit(info.selectedText, 1_000))}`;
            if (info.kind === 'pdf-annotate') text += `\n${shapeBlock(info.shapes, info.shapesTotal, Math.floor(room / 3), 'Annotations on screen')}`;
            const pages = await pdfPagesText(view, info.visiblePages, budget - text.length - 1);
            return pages ? `${text}\n${pages}` : text;
        }
        case 'drawing':
        case 'notebook': {
            const text = `${head}\n${livePosition(info)}.`;
            return `${text}\n${shapeBlock(info.shapes, info.shapesTotal, budget - text.length - 1, info.kind === 'drawing' ? 'Shapes in view' : 'Shapes on the pages on screen')}`;
        }
    }
}

/* ───────────────────────── the block ───────────────────────── */

function wrap(body: string): string {
    return `${CONTEXT_OPEN_TAG}\n${neutralize(body)}\n${CONTEXT_CLOSE_TAG}\n`;
}

const PREAMBLE = 'Generated by the editor for this message (the user did not type it): what they are looking at right now. It replaces any earlier context block in this chat.';

export async function buildAgentContext(
    workspace: AgentWorkspaceSnapshot | null,
    opts: { vaultUuid: string; lastImageHash: string | null; imagesSupported: boolean; mode: ReplyMode },
): Promise<BuiltContext> {
    if (!workspace) {
        return {
            text: wrap(`${PREAMBLE}\nNo vault is open in the editor, so there are no files to work with.\nLocal time: ${localTime()}\n\n${REPLY_MODE_LINE[opts.mode]}`),
            image: null,
        };
    }

    const onScreen = workspace.mainView === 'editor';
    const tabsByPath = new Map(workspace.tabs.map(t => [t.path, t]));

    // Ask every mounted pane where the user is — in parallel, each bounded.
    const views = new Map<string, ViewReporter>();
    const infos = new Map<string, ViewInfo>();
    await Promise.all(workspace.tabs.map(async tab => {
        const view = getView(tab.path);
        if (!view) return;
        views.set(tab.path, view);
        const info = await withTimeout(view.describe(), DESCRIBE_TIMEOUT_MS);
        if (info) infos.set(tab.path, info);
    }));

    /* 1. vault and time */
    const out: string[] = [
        PREAMBLE,
        `Vault: "${workspace.vaultName}" (id ${opts.vaultUuid}). Paths below are vault-relative, as the vault_* tools take them.`,
        `Local time: ${localTime()}`,
    ];

    /* 2. the layout */
    const { panes, activeId } = workspace.layout;
    const focusedPane = panes.find(p => p.id === activeId) ?? null;
    if (!onScreen) {
        out.push('The main area shows the graph view (a map of the links between notes): no document is on screen. The panes below are hidden behind it.');
    }
    if (!panes.length) {
        out.push('No documents are open.');
    } else {
        out.push(`Panes, left to right (${panes.length}):`);
        panes.forEach((p, i) => {
            const focused = p.id === activeId ? ' (focused)' : '';
            const others = p.paths.filter(x => x !== p.activePath);
            out.push(`  pane ${i + 1}${focused}: showing ${p.activePath}${others.length ? `; other tabs: ${others.join(', ')}` : ''}`);
        });
    }

    /* 3. every open tab, where it is */
    const paneOf = (path: string) => panes.findIndex(p => p.paths.includes(path));
    const tabLines: string[] = [];
    for (const tab of workspace.tabs) {
        const info = infos.get(tab.path);
        const idx = paneOf(tab.path);
        const shown = onScreen && idx !== -1 && panes[idx].activePath === tab.path;
        const where = idx === -1 ? 'not in a pane' : `${shown ? 'on screen in' : 'behind another tab in'} pane ${idx + 1}`;
        const flags = [tab.dirty && 'unsaved changes', tab.unreadable && 'could not be read'].filter(Boolean).join(', ');
        const position = info ? livePosition(info) : rememberedPosition(workspace.remembered(tab.path));
        tabLines.push(`- ${tab.path} — ${kindLabel(tab, info)}${flags ? `, ${flags}` : ''}; ${where}; ${position}`);
    }
    if (tabLines.length) {
        out.push(`Open tabs (${tabLines.length}):`);
        out.push(fit(tabLines.join('\n'), Math.floor(CONTEXT_CHAR_BUDGET * TAB_LIST_SHARE)));
    }

    /* the picture, when the focused tab is a canvas or a PDF */
    const focusedPath = onScreen ? workspace.focusedPath : null;
    const focusedTab = focusedPath ? tabsByPath.get(focusedPath) : undefined;
    const focusedView = focusedPath ? views.get(focusedPath) : undefined;
    let image: BuiltContext['image'] = null;
    let imageLine: string | null = null;
    if (focusedView && focusedView.kind !== 'markdown' && focusedView.capture) {
        if (!opts.imagesSupported) {
            imageLine = 'The selected model cannot take images, so no picture of this view is attached — go by the positions, shapes and text below.';
        } else {
            const blob = await withTimeout(focusedView.capture(AGENT_IMAGE_MAX_SIDE), CAPTURE_TIMEOUT_MS);
            if (!blob) {
                imageLine = 'A picture of this view could not be captured this time.';
            } else {
                const bytes = await blobBytes(blob);
                const hash = await sha256Hex(bytes);
                if (hash === opts.lastImageHash) {
                    imageLine = 'Its picture is unchanged since the one attached to an earlier message in this chat — look back at that one.';
                } else {
                    image = { mimeType: 'image/png', data: bytesToBase64(bytes), hash };
                    imageLine = 'A picture of exactly what is on screen in this pane is attached to this message.';
                }
            }
        }
    }

    /* 4 + 5. the focused document, then the other visible panes */
    let used = out.reduce((n, l) => n + l.length + 1, 0) + CONTEXT_OPEN_TAG.length + CONTEXT_CLOSE_TAG.length + 4;
    const others = onScreen
        ? panes.map((p, i) => ({ pane: p, no: i + 1 })).filter(({ pane }) => pane !== focusedPane && tabsByPath.has(pane.activePath))
        : [];
    if (focusedTab) {
        const reserve = Math.min(others.length * OTHER_PANE_RESERVE, Math.floor((CONTEXT_CHAR_BUDGET - used) * 0.3));
        const section = await focusedSection(focusedTab, focusedView, infos.get(focusedTab.path), CONTEXT_CHAR_BUDGET - used - reserve, imageLine);
        out.push('', section);
        used += section.length + 2;
    } else if (onScreen && panes.length) {
        out.push('', 'No pane has focus.');
    }
    for (let i = 0; i < others.length; i++) {
        const left = CONTEXT_CHAR_BUDGET - used;
        const share = Math.floor(left / (others.length - i));
        if (share < 200) {
            out.push(`…[${plural(others.length - i, 'more visible pane')} left out for space; their files are in the tab list above — read them with vault_read]`);
            break;
        }
        const { pane, no } = others[i];
        const tab = tabsByPath.get(pane.activePath)!;
        const section = await visibleSection(no, tab, views.get(tab.path), infos.get(tab.path), share - 2);
        out.push('', section);
        used += section.length + 2;
    }

    // Last, so it is the instruction closest to the user's own words — and
    // outside the budget arithmetic above, which is about what is being SHOWN.
    // One line is not what makes a context block too big.
    out.push('', REPLY_MODE_LINE[opts.mode]);

    return { text: wrap(out.join('\n')), image };
}

/** The user's own words: `text` minus a leading <bme-context> block (and the
 *  line break after it). Anything else is returned untouched. */
export function stripAgentContext(text: string): string {
    const start = text.length - text.trimStart().length;
    if (!text.startsWith(CONTEXT_OPEN_TAG, start)) return text;
    const end = text.indexOf(CONTEXT_CLOSE_TAG, start + CONTEXT_OPEN_TAG.length);
    if (end === -1) return text;
    let rest = text.slice(end + CONTEXT_CLOSE_TAG.length);
    if (rest.startsWith('\r\n')) rest = rest.slice(2);
    else if (rest.startsWith('\n')) rest = rest.slice(1);
    return rest;
}
