import { CANVAS_PAGING_VERSION, MAX_TOOL_TEXT_CHARS, compareVersions, type CanvasOp, type ToolContent, type ToolName, type ToolResult } from '../../shared/vaultAgentProtocol';
import { VAULT_TOOLS, type ToolDef } from '../../shared/vaultAgentTools';
import type { AgentChange, AgentRegion, ClosedPdfEmphasis, HostResult, NativeCanvasView, VaultToolHost } from '../types/vaultAgent';
import type { FileTreeNode } from '../types';
import { getView, type CanvasApplyResult, type CanvasShapePage, type CanvasShapeQuery, type ShapeSummary, type TextChange, type ViewReporter } from './viewRegistry';
import { validateAgainstSchema } from './agentSchema';
import { creationDiff, lineDiff } from './agentDiff';
import { AGENT_IMAGE_MAX_SIDE, blobBytes, imageMimeFor, prepareImageForAgent, sha256Hex } from './agentMedia';
import { formatShape, summarizeCanvasFile, type FileShape } from './canvasFileSummary';
import { canvasReadOnlyReason, sniffCanvas } from './canvasFormat';
import { isTextFile } from './vaultSearch';
import { collectFiles } from './tree';
import { isEpubFile, isCanvasFile, isNativeDrawingFile, isImageFile, isNotebookFile, isPdfFile } from './fileTypes';
import { ASSETS_DIR, TRASH_DIR } from './assets';
import { isGitName } from './vaultEntries';
import { ENTRY_STYLE_FILE, LEGACY_STYLE_FILE } from './entryStyle';
import { VAULT_AGENT_DIR } from './vaultAgentStore';
import { parentVaultPath } from './paths';
import type { MatchAnswer } from './agentMatcher/types';

export interface ToolExecution {
    result: ToolResult;
    change?: AgentChange;
}

const MAX_LIST_ENTRIES = 2000;
const MAX_READ_LINE = 4000;
const MAX_PDF_PAGES_PER_READ = 50;
const REPORTER_TIMEOUT_MS = 20_000;

const SWITCHED = 'The user switched to a different vault, so this run can no longer touch files. Tell the user, and ask them to start a new message if they still want this done.';
const STALE = 'The file changed since you read it (the user may be typing in it). Read it again with vault_read and retry with the current text.';

function textResult(text: string, isError = false): ToolResult {
    return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

function ok(text: string, change?: AgentChange, extra: ToolContent[] = []): ToolExecution {
    return { result: { content: [{ type: 'text', text }, ...extra] }, ...(change ? { change } : {}) };
}

function fail(text: string): ToolExecution {
    return { result: textResult(`Error: ${text}`, true) };
}

class ToolError extends Error {}

function capContent(result: ToolResult): ToolResult {
    let budget = MAX_TOOL_TEXT_CHARS;
    const content = result.content.map(c => {
        if (c.type !== 'text') return c;
        if (c.text.length <= budget) { budget -= c.text.length; return c; }
        const kept = Math.max(0, budget - 200);
        budget = 0;
        return {
            type: 'text' as const,
            text: `${c.text.slice(0, kept)}\n…[truncated ${c.text.length - kept} chars — ask for less: a smaller limit, a later offset, a single page or a narrower path]`,
        };
    });
    return { ...result, content };
}

/** NUL and the other C0 controls, and DEL: no file name needs one, and a NUL
 *  is how a path smuggles a second meaning past a string check. */
function hasControlChar(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) return true;
    }
    return false;
}

function checkPath(input: unknown): { path: string } | { error: string } {
    if (typeof input !== 'string') return { error: 'path must be a string' };
    if (hasControlChar(input)) return { error: 'the path contains control characters' };
    if (input.includes('\\')) return { error: `${JSON.stringify(input)} uses "\\"; separate folders with "/" (e.g. "Notes/Ideas.md")` };
    if (input.startsWith('/') || input.startsWith('~') || /^[A-Za-z]:/.test(input) || /^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
        return { error: `${JSON.stringify(input)} is not a vault path. Only the open vault is reachable, with vault-relative paths like "Notes/Ideas.md" ("" is the vault root).` };
    }
    let path = input;
    while (path.startsWith('./')) path = path.slice(2);
    if (path === '.' || path === '') return { path: '' };
    if (path.endsWith('/')) path = path.slice(0, -1);
    const segments = path.split('/');
    for (const seg of segments) {
        if (seg === '') return { error: `${JSON.stringify(input)} has an empty folder name ("//")` };
        if (seg === '..') return { error: '".." is not allowed: paths cannot leave the vault' };
        if (seg === '.') return { error: `"." segments are not allowed in ${JSON.stringify(input)}` };
        if (seg.length > 255) return { error: 'a name in the path is longer than 255 characters' };
    }
    // Case-insensitively: macOS and Windows file systems are, so `.vaultagent`
    // names the same folder.
    if (segments[0].toLowerCase() === VAULT_AGENT_DIR.toLowerCase()) {
        return { error: `"${VAULT_AGENT_DIR}" is the app's private folder and is off limits` };
    }
    return { path: segments.join('/') };
}

const foldName = (s: string) => s.normalize('NFC').toLowerCase();

function canonicalPath(path: string, tree: FileTreeNode[]): string {
    if (!path) return path;
    const segments = path.split('/');
    let level: FileTreeNode[] | null = tree;
    for (let i = 0; i < segments.length && level; i++) {
        const seg = segments[i];
        let node: FileTreeNode | undefined = level.find(n => n.name === seg);
        if (!node) {
            const folded = foldName(seg);
            const matches: FileTreeNode[] = level.filter(n => foldName(n.name) === folded);
            if (matches.length === 1) node = matches[0];
        }
        if (!node) break;
        segments[i] = node.name;
        level = node.kind === 'directory' ? node.children : null;
    }
    return segments.join('/');
}

export function normalizeAgentPath(input: unknown): string | null {
    const r = checkPath(input);
    return 'path' in r ? r.path : null;
}

const lower = (s: string) => s.toLowerCase();
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function inTrash(path: string): boolean {
    return path.split('/').some(seg => lower(seg) === lower(TRASH_DIR));
}

function writeRefusal(path: string): string | null {
    if (path === '') return 'the vault root itself cannot be changed';
    if (inTrash(path)) {
        return `"${path}" is in a ${TRASH_DIR} folder (the trash), which is read-only. Delete things with vault_trash; restoring from the trash is for the user (the Trash panel in the sidebar).`;
    }
    if (lower(baseName(path)) === lower(ENTRY_STYLE_FILE)
        || (!path.includes('/') && lower(path) === lower(LEGACY_STYLE_FILE))) {
        return `"${path}" is the app's own settings file (icons, colours, custom order) and cannot be changed with tools`;
    }
    return null;
}

function isAppFolder(path: string): boolean {
    const name = lower(baseName(path));
    return name === lower(ASSETS_DIR) || name === lower(TRASH_DIR);
}

type Args = Record<string, unknown>;

interface Ctx {
    host: VaultToolHost;
    signal?: AbortSignal;
    ensureLive(): void;
    path(value: unknown): string;
    writablePath(value: unknown): string;
}

function makeCtx(host: VaultToolHost, run: { vaultToken: object | null; signal?: AbortSignal }): Ctx {
    const ensureLive = () => {
        if (!run.vaultToken || host.vaultToken() !== run.vaultToken) throw new ToolError(SWITCHED);
    };
    const path = (value: unknown) => {
        const r = checkPath(value);
        if ('error' in r) throw new ToolError(r.error);
        return canonicalPath(r.path, host.getFileTree());
    };
    return {
        host,
        signal: run.signal,
        ensureLive,
        path,
        writablePath(value) {
            const p = path(value);
            const refusal = writeRefusal(p);
            if (refusal) throw new ToolError(refusal);
            return p;
        },
    };
}

function hostFailure(r: Extract<HostResult, { ok: false }>, verb: string, path: string): ToolError {
    const detail = r.message ? ` (${r.message})` : '';
    switch (r.reason) {
        case 'taken': return new ToolError(`"${path}" already exists — a file or folder has that name. Choose another name.`);
        case 'missing': return new ToolError(`"${path}" does not exist. Check the name with vault_list.`);
        case 'no-parent': return new ToolError(`the folder "${parentVaultPath(path)}" does not exist; create it first with vault_mkdir.`);
        case 'invalid': return new ToolError(`"${path}" cannot be used here${detail}.`);
        case 'stale': return new ToolError(STALE);
        case 'busy': return new ToolError(`the app is busy with another file operation${detail}; try again in a moment.`);
        default: return new ToolError(`could not ${verb} "${path}"${detail}.`);
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string, abort?: AbortController): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { abort?.abort(); reject(new ToolError(`${what} timed out`)); }, ms);
        promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
    });
}

async function describe(view: ViewReporter) {
    return withTimeout(Promise.resolve(view.describe()), REPORTER_TIMEOUT_MS, 'reading the open view');
}

function openPdfView(path: string): ViewReporter | undefined {
    const view = getView(path);
    return view && !view.live && (view.kind === 'pdf' || view.kind === 'pdf-annotate') ? view : undefined;
}

async function kindOf(ctx: Ctx, path: string): Promise<'file' | 'directory' | null> {
    return path === '' ? 'directory' : ctx.host.entryKind(path);
}

async function requireFile(ctx: Ctx, path: string): Promise<void> {
    const kind = await kindOf(ctx, path);
    if (kind === 'directory') throw new ToolError(`"${path || '(vault root)'}" is a folder; list it with vault_list.`);
    if (!kind) throw new ToolError(`"${path}" does not exist. Check the name with vault_list or vault_search.`);
}

/** Any extension not known as binary counts as text, so a `.sqlite` or `.bin`
 *  reaches here decoded as UTF-8: a NUL or a replacement character means the
 *  decode was lossy, and writing it back would corrupt the file. */
function assertDecodedText(path: string, text: string): void {
    if (text.includes('\u0000') || text.includes('\uFFFD')) {
        throw new ToolError(`"${path}" is not plain text (it holds binary data), so it cannot be edited as text.`);
    }
}

function assertSupportedCanvasFormat(path: string): void {
    if (isNativeDrawingFile(path)) throw new ToolError(`"${path}" is a native .drawing whiteboard; this build cannot read or change it with text or canvas tools.`);
}

function assertEditableText(path: string): void {
    assertSupportedCanvasFormat(path);
    const name = baseName(path);
    if (isCanvasFile(name)) throw new ToolError(`"${path}" is a ${isNotebookFile(name) ? 'notebook' : 'drawing'}; change it with canvas_apply, not as text.`);
    if (isPdfFile(name)) throw new ToolError(`"${path}" is a PDF; its text cannot be edited. Annotate it with canvas_apply.`);
    if (!isTextFile(name)) throw new ToolError(`"${path}" is not a text file.`);
}

function dropNulls(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(dropNulls);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) if (v !== null) out[k] = dropNulls(v);
        return out;
    }
    return value;
}

const normalizeNewlines = (text: string) => text.replace(/\r\n?/g, '\n');

function lineOfOffset(text: string, offset: number): number {
    let line = 1;
    for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++;
    return line;
}

function numberedSlice(text: string, from: number, to: number): string {
    const lines = text.split('\n');
    const out: string[] = [];
    for (let n = Math.max(1, from); n <= Math.min(lines.length, to); n++) {
        const line = lines[n - 1];
        out.push(`${n}\t${line.length > MAX_READ_LINE ? `${line.slice(0, MAX_READ_LINE)}…` : line}`);
    }
    return out.join('\n');
}

async function vaultList(a: Args, ctx: Ctx): Promise<ToolExecution> {
    const root = ctx.path(a.path ?? '');
    const depth = typeof a.depth === 'number' ? a.depth : 2;
    const includeHidden = a.includeHidden === true;
    const kind = await kindOf(ctx, root);
    if (!kind) throw new ToolError(`"${root}" does not exist. List its parent with vault_list to see what is there.`);
    if (kind === 'file') return ok(`"${root}" is a file, not a folder. Read it with vault_read.`);

    const lines: string[] = [];
    let entries = 0;
    let stopped = false;
    let hiddenSkipped = 0;

    const walk = async (dir: string, indent: string, level: number): Promise<void> => {
        const children = await ctx.host.listDir(dir);
        ctx.ensureLive();
        if (!children) { lines.push(`${indent}(could not be read)`); return; }
        const visible = children.filter(c => {
            const name = lower(c.name);
            if (name === '.ds_store' || name.endsWith('.crswap')) return false;
            if (dir === '' && name === lower(VAULT_AGENT_DIR)) return false;
            const hidden = (c.kind === 'directory' && (name === lower(TRASH_DIR) || name === lower(ASSETS_DIR)))
                || isGitName(c.name)
                || (c.kind === 'file' && (c.name === ENTRY_STYLE_FILE || (dir === '' && c.name === LEGACY_STYLE_FILE)));
            if (hidden && !includeHidden) { hiddenSkipped++; return false; }
            return true;
        });
        visible.sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: 'base' }) : x.kind === 'directory' ? -1 : 1));
        for (const child of visible) {
            if (entries >= MAX_LIST_ENTRIES) { stopped = true; return; }
            entries++;
            const childPath = dir ? `${dir}/${child.name}` : child.name;
            if (child.kind === 'directory') {
                if (level < depth) {
                    lines.push(`${indent}${child.name}/`);
                    await walk(childPath, `${indent}  `, level + 1);
                    if (stopped) return;
                } else {
                    lines.push(`${indent}${child.name}/ …`);
                }
            } else {
                lines.push(`${indent}${child.name}`);
            }
        }
    };
    await walk(root, '', 1);

    const head = `${root ? `"${root}"` : 'Vault root'} (depth ${depth}; folders end in "/", and "/ …" marks one whose contents are below the depth limit):`;
    const notes: string[] = [];
    if (!lines.length) notes.push('(empty)');
    if (stopped) notes.push(`…[stopped after ${MAX_LIST_ENTRIES} entries — list a sub-folder with path, or use a smaller depth]`);
    if (hiddenSkipped) notes.push(`(${hiddenSkipped} hidden app item${hiddenSkipped === 1 ? '' : 's'} left out: ${ASSETS_DIR} image folders, ${TRASH_DIR} trash, .git, the settings file — pass includeHidden: true to show them)`);
    return ok([head, ...lines, ...notes].join('\n'));
}

async function readText(a: Args, ctx: Ctx, path: string): Promise<ToolExecution> {
    const text = await ctx.host.readText(path);
    ctx.ensureLive();
    if (text === null) throw new ToolError(`"${path}" could not be read (missing, a folder, or unreadable).`);
    const hash = await sha256Hex(text);
    const live = ctx.host.openBuffer(path) !== undefined;
    const lines = text === '' ? [] : text.split('\n');
    const total = lines.length;
    const header = [`path: ${path}`, `hash: ${hash}`];
    if (live) header.push('source: the open tab\'s live text (unsaved edits included)');
    if (total === 0) return ok([...header, 'lines: 0 (the file is empty)'].join('\n'));

    const start = typeof a.offset === 'number' ? a.offset : 1;
    if (start > total) throw new ToolError(`offset ${start} is past the end of "${path}", which has ${total} line${total === 1 ? '' : 's'}.`);
    const limit = typeof a.limit === 'number' ? a.limit : Infinity;
    const budget = MAX_TOOL_TEXT_CHARS - 600;
    const out: string[] = [];
    let used = 0;
    let n = start;
    for (; n <= total && out.length < limit; n++) {
        const line = lines[n - 1];
        const shown = line.length > MAX_READ_LINE ? `${line.slice(0, MAX_READ_LINE)}…[line cut: ${line.length} chars]` : line;
        const entry = `${n}\t${shown}`;
        if (out.length > 0 && used + entry.length + 1 > budget) break;
        out.push(entry);
        used += entry.length + 1;
    }
    const last = n - 1;
    header.push(`lines: ${start}-${last} of ${total}`);
    const body = [...header, '', ...out];
    if (last < total) body.push(`…[showing lines ${start}-${last} of ${total}; call vault_read with offset=${last + 1} to continue]`);
    return ok(body.join('\n'));
}

function viewReadController(ctx: Ctx): AbortController {
    const controller = new AbortController();
    if (ctx.signal?.aborted) controller.abort();
    else ctx.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    return controller;
}

async function withClosedPdfDeadline<T>(ctx: Ctx, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    ctx.ensureLive();
    const controller = new AbortController();
    const stop = () => controller.abort();
    ctx.signal?.addEventListener('abort', stop, { once: true });
    if (ctx.signal?.aborted) controller.abort();
    const timeout = setTimeout(stop, REPORTER_TIMEOUT_MS);
    const vaultCheck = setInterval(() => { try { ctx.ensureLive(); } catch { controller.abort(); } }, 100);
    try {
        controller.signal.throwIfAborted();
        const cancelled = new Promise<never>((_, reject) => controller.signal.addEventListener('abort',
            () => reject(new DOMException('PDF agent operation cancelled or timed out', 'AbortError')), { once: true }));
        const result = await Promise.race([work(controller.signal), cancelled]);
        ctx.ensureLive();
        controller.signal.throwIfAborted();
        return result;
    } finally {
        clearTimeout(timeout); clearInterval(vaultCheck);
        ctx.signal?.removeEventListener('abort', stop);
    }
}

function pdfExtractionWarning(page: { quality?: 'partial'; warnings?: readonly string[] }): string {
    return page.quality === 'partial' ? `[Extraction warning: ${(page.warnings?.join(' ') || 'Text may be incomplete or out of order.').slice(0, 1000)}]` : '';
}

async function readPdf(a: Args, ctx: Ctx, path: string): Promise<ToolExecution> {
    const first = typeof a.offset === 'number' ? a.offset : 1;
    const maxPages = Math.min(MAX_PDF_PAGES_PER_READ, typeof a.limit === 'number' ? a.limit : MAX_PDF_PAGES_PER_READ);
    const budget = MAX_TOOL_TEXT_CHARS - 1000;
    let pageCount: number;
    let pages: Array<{ page: number; text: string; quality?: 'partial'; warnings?: readonly string[] }>;
    let source: string;

    const view = openPdfView(path);
    if (view?.pdfText) {
        const info = await describe(view);
        pageCount = 'pageCount' in info ? info.pageCount : 0;
        if (first > pageCount) throw new ToolError(`page ${first} is past the end of "${path}", which has ${pageCount} page${pageCount === 1 ? '' : 's'}.`);
        pages = [];
        let used = 0;
        for (let p = first; p <= pageCount && pages.length < maxPages;) {
            const batch = Array.from({ length: Math.min(5, maxPages - pages.length, pageCount - p + 1) }, (_, i) => p + i);
            const controller = viewReadController(ctx);
            const got = await withTimeout(view.pdfText(batch, controller.signal), REPORTER_TIMEOUT_MS, 'extracting the PDF text', controller);
            let full = false;
            for (const g of got.sort((x, y) => x.page - y.page)) {
                const size = g.text.length + pdfExtractionWarning(g).length + 1;
                if (pages.length > 0 && used + size > budget) { full = true; break; }
                pages.push(g);
                used += size;
            }
            if (full) break;
            p += batch.length;
        }
        source = 'open in a pane';
    } else {
        const bytes = await ctx.host.readBytes(path);
        if (!bytes) throw new ToolError(`"${path}" could not be read.`);
        const access = ctx.host.closedPdfAgent?.();
        if (!access) throw new ToolError('The PDF engine is unavailable. Open the PDF in the app and try again.');
        const r = await withClosedPdfDeadline(ctx, signal => access.read(path, bytes, first, maxPages, budget, signal));
        pageCount = r.pageCount;
        if (first > pageCount) throw new ToolError(`page ${first} is past the end of "${path}", which has ${pageCount} page${pageCount === 1 ? '' : 's'}.`);
        pages = r.pages;
        source = 'the file on disk';
    }
    ctx.ensureLive();

    const last = pages.length ? pages[pages.length - 1].page : first - 1;
    const out = [`path: ${path}`, `PDF, ${pageCount} page${pageCount === 1 ? '' : 's'} — text of pages ${first}-${last} (from ${source})`];
    for (const p of pages) {
        out.push('', `=== page ${p.page} ===`);
        const warning = pdfExtractionWarning(p);
        if (warning) out.push(warning);
        out.push(p.text || '(no text on this page — it may be a scan or a drawing; look at it with vault_view)');
    }
    if (last < pageCount) out.push('', `…[pages ${last + 1}-${pageCount} not shown; call vault_read with offset=${last + 1} to continue]`);
    return ok(out.join('\n'));
}

function shapeLines(shapes: Array<ShapeSummary & { sizeUnknown?: boolean }>, budget: number, more: string): string[] {
    const out: string[] = [];
    let used = 0;
    for (let i = 0; i < shapes.length; i++) {
        const line = formatShape(shapes[i]);
        if (used + line.length + 1 > budget) {
            out.push(`…[${shapes.length - i} more shape${shapes.length - i === 1 ? '' : 's'} not shown; ${more}]`);
            break;
        }
        out.push(line);
        used += line.length + 1;
    }
    return out;
}

function pagedShapeLines(result: CanvasShapePage, offset: number, budget: number): { lines: string[]; count: number } {
    const lines: string[] = [];
    let used = 0, count = 0, section = 0;
    for (const shape of result.shapes) {
        const label = result.sections?.[section];
        const heading = label?.offset === offset + count ? `— sheet "${label.name.replace(/[\r\n]/gu, ' ')}" (${label.index + 1})` : '';
        const line = formatShape(shape), added = line.length + 1 + (heading ? heading.length + 1 : 0);
        if (used + added > budget) break;
        if (heading) { lines.push(heading); section++; }
        lines.push(line); used += added; count++;
    }
    return { lines, count };
}

const COORDS_PAGED = 'Coordinates are page-relative: x/y in points from the top-left corner of `page`.';
const COORDS_DRAWING = 'Coordinates are the canvas\'s own units.';

async function readableCanvasText(ctx: Ctx, path: string): Promise<string> {
    const text = await ctx.host.readText(path);
    ctx.ensureLive();
    if (text === null) throw new ToolError(`"${path}" could not be read.`);
    const reason = canvasReadOnlyReason(sniffCanvas(text, path));
    if (reason) throw new ToolError(reason);
    return text;
}

async function canvasShapesFromAnywhere(ctx: Ctx, path: string, page: number | undefined): Promise<{ lines: string[]; head: string[] }> {
    const name = baseName(path);
    const notebook = isNotebookFile(name);
    if (ctx.host.canvasShapePage) {
        const result = await ctx.host.canvasShapePage(path, { page }, { signal: ctx.signal, isCurrent: () => {
            try { ctx.ensureLive(); return !ctx.signal?.aborted; } catch { return false; }
        } });
        ctx.ensureLive();
        if (ctx.signal?.aborted) throw new ToolError('Canvas read cancelled.');
        if (result) {
            const head = [`path: ${path}`, `${notebook ? 'notebook' : 'drawing'}, read from the board session`,
                `${result.total} shape${result.total === 1 ? '' : 's'}${page ? ` on page ${page}` : ''}`,
                notebook ? COORDS_PAGED : COORDS_DRAWING];
            const shown = pagedShapeLines(result, 0, MAX_TOOL_TEXT_CHARS - 1500), lines = shown.lines;
            if (shown.count < result.total) lines.push(`…[${result.total - shown.count} more shapes not shown]`);
            return { head, lines };
        }
    }
    assertSupportedCanvasFormat(path);
    const text = await readableCanvasText(ctx, path);
    const budget = MAX_TOOL_TEXT_CHARS - 1500;
    const pageHint = notebook ? 'pass page to see one page at a time' : 'look at a region with vault_view';

    const summary = summarizeCanvasFile(notebook ? 'notebook' : 'drawing', text);
    if ('error' in summary) throw new ToolError(`"${path}": ${summary.error}.`);
    const head = [`path: ${path}`, `${notebook ? 'notebook' : 'drawing'}, not open — read from the saved file`];
    if (summary.paper) {
        const p = summary.paper;
        if (page && page > p.pageCount) throw new ToolError(`page ${page} is past the end of "${path}", which has ${p.pageCount} page${p.pageCount === 1 ? '' : 's'}.`);
        head.push(`paper: ${p.size} ${p.orientation}, ${p.ruling}; ${p.pageCount} page${p.pageCount === 1 ? '' : 's'}`);
    }
    head.push(notebook ? COORDS_PAGED : COORDS_DRAWING);
    head.push('Sizes marked "?" (text boxes, groups) are only known once the canvas is open; canvas_shapes on an open canvas reports them.');
    const lines: string[] = [];
    const perPage = summary.pages.length > 1;
    let remaining = budget;
    for (const pg of summary.pages) {
        const shapes: FileShape[] = page ? pg.shapes.filter(s => s.page === page) : pg.shapes;
        if (perPage) lines.push(`— page "${pg.name}": ${shapes.length} shape${shapes.length === 1 ? '' : 's'}`);
        else lines.push(`${shapes.length} shape${shapes.length === 1 ? '' : 's'}${page ? ` on page ${page}` : ''}`);
        const got = shapeLines(shapes, remaining, pageHint);
        lines.push(...got);
        remaining -= got.reduce((n, l) => n + l.length + 1, 0);
        if (remaining <= 0) break;
    }
    return { head, lines };
}

async function readImage(ctx: Ctx, path: string, verb: 'read' | 'view'): Promise<ToolExecution> {
    const mime = imageMimeFor(path);
    if (!mime) throw new ToolError(`"${path}" is not an image type this app can show.`);
    const bytes = await ctx.host.readBytes(path);
    ctx.ensureLive();
    if (!bytes) throw new ToolError(`"${path}" could not be read.`);
    let img;
    try {
        img = await prepareImageForAgent(bytes, mime);
    } catch (err) {
        throw new ToolError(`"${path}" could not be decoded as an image (${err instanceof Error ? err.message : String(err)}).`);
    }
    const note = img.converted ? ` (scaled to ${img.width}×${img.height} for you)` : ` (${img.width}×${img.height})`;
    return ok(`${verb === 'view' ? 'Image' : 'Image file'} ${path}${note}:`, undefined, [{ type: 'image', data: img.data, mimeType: img.mimeType }]);
}

async function vaultRead(a: Args, ctx: Ctx): Promise<ToolExecution> {
    const path = ctx.path(a.path);
    await requireFile(ctx, path);
    const name = baseName(path);
    if (isEpubFile(name)) {
        const view=getView(path), info=view?await describe(view):undefined;
        if(info?.kind!=='epub') throw new ToolError('This EPUB is not loaded. Open the book to provide bounded visible canonical text; unopened chapter extraction is unavailable.');
        return ok(`EPUB · read-only · ${info.status}\n${info.locator?JSON.stringify(info.locator):'Location not available'}\nSelected canonical text:\n${info.selectedCanonicalText??'(none)'}\nVisible canonical text (bounded, not the whole book):\n${info.visibleCanonicalText}`);
    }
    if (isPdfFile(name)) return readPdf(a, ctx, path);
    if (isCanvasFile(name) || isNativeDrawingFile(name)) {
        const { head, lines } = await canvasShapesFromAnywhere(ctx, path, undefined);
        return ok([...head, 'Full detail and one page at a time: canvas_shapes. A picture: vault_view.', '', ...lines].join('\n'));
    }
    if (isImageFile(name) && !/\.svg$/i.test(name)) return readImage(ctx, path, 'read');
    if (!isTextFile(name)) throw new ToolError(`"${path}" is a binary file (not text, PDF, image, drawing or notebook) and cannot be read.`);
    return readText(a, ctx, path);
}

async function pngResult(blob: Blob | null, caption: string, what: string): Promise<ToolExecution> {
    if (!blob) throw new ToolError(`${what} could not be rendered.`);
    const img = await prepareImageForAgent(await blobBytes(blob), blob.type || 'image/png');
    return ok(caption, undefined, [{ type: 'image', data: img.data, mimeType: img.mimeType }]);
}

function onScreenCaption(viewport: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }): string {
    return ` — the part on screen: x ${Math.round(viewport.x)}…${Math.round(viewport.x + viewport.w)}, y ${Math.round(viewport.y)}…${Math.round(viewport.y + viewport.h)}`;
}

function nativeViewCaption(path: string, native: NativeCanvasView, page: number | undefined, region?: AgentRegion): string {
    if (region) return `${path}${page !== undefined ? `, page ${page}` : ''}, the region x ${Math.round(region.x)}…${Math.round(region.x + region.w)}, y ${Math.round(region.y)}…${Math.round(region.y + region.h)}:`;
    const info = native.info;
    if (info.kind === 'drawing') return `${path}${native.wholeSheet ? ', the whole sheet' : onScreenCaption(info.viewport)}:`;
    const count = info.pageCount;
    const pdf = info.kind === 'pdf-annotate';
    if (page !== undefined) return `${path}, page ${page} of ${count}${pdf ? ' (with its ink)' : ''}:`;
    const pages = pdf ? `${count} PDF page${count === 1 ? '' : 's'}` : `${count} page${count === 1 ? '' : 's'}`;
    if (native.wholeSheet) return `${path}, the whole sheet of its ${pages}:`;
    return `${path}, pages ${info.visiblePages.join(', ')} of ${pages} on its recorded view:`;
}

function pdfEmphasisCaption(emphasis: ClosedPdfEmphasis | undefined): string {
    if (!emphasis) return '';
    if (emphasis.kind === 'active') return ' (word emphasis applied)';
    const reason = typeof emphasis.reason === 'string'
        ? [...emphasis.reason.slice(0, 512)].map(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char).join('').replace(/\s+/g, ' ').trim().slice(0, 200)
        : '';
    return ` (word emphasis not applied${reason ? `: ${reason}` : ''})`;
}

function regionArg(value: unknown): AgentRegion | undefined {
    if (value === undefined) return undefined;
    const r = value as Partial<Record<'x' | 'y' | 'w' | 'h', unknown>> | null;
    if (!r || typeof r !== 'object' || ![r.x, r.y, r.w, r.h].every(item => typeof item === 'number' && Number.isFinite(item))
        || !((r.w as number) > 0) || !((r.h as number) > 0)) {
        throw new ToolError('region needs finite x and y, and a positive w and h, in board units.');
    }
    return { x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number };
}

async function vaultView(a: Args, ctx: Ctx): Promise<ToolExecution> {
    const path = ctx.path(a.path);
    const region = regionArg(a.region);
    if (!ctx.host.canvasShapePage) assertSupportedCanvasFormat(path);
    await requireFile(ctx, path);
    const name = baseName(path);
    const page = typeof a.page === 'number' ? a.page : undefined;
    const max = AGENT_IMAGE_MAX_SIDE;

    if (isEpubFile(name)) throw new ToolError('EPUB image capture is unavailable. vault_read can provide bounded visible canonical text from an open book.');
    if (isImageFile(name)) return readImage(ctx, path, 'view');

    if (isPdfFile(name)) {
        const view = openPdfView(path);
        if (!view && ctx.host.nativeCanvasView) {
            const native = await ctx.host.nativeCanvasView(path, { signal: ctx.signal, isCurrent: () => {
                try { ctx.ensureLive(); return !ctx.signal?.aborted; } catch { return false; }
            } });
            ctx.ensureLive();
            if (native) {
                const count = native.info.kind === 'pdf-annotate' ? native.info.pageCount : 0;
                if (page !== undefined && count && page > count) throw new ToolError(`page ${page} is past the end of "${path}", which has ${count} page${count === 1 ? '' : 's'}.`);
                const blob = await withTimeout(native.capture(max, ctx.signal, page, region), REPORTER_TIMEOUT_MS, 'capturing the canvas');
                ctx.ensureLive();
                return pngResult(blob, nativeViewCaption(path, native, page, region), `"${path}"`);
            }
        }
        if (region) throw new ToolError(`A region is shown only for an open ink board. Look at a whole page of "${path}" instead.`);
        if (view) {
            const info = await describe(view);
            if (info.kind === 'pdf' && info.surface === 'text') throw new ToolError('PDF Text image capture is unavailable. Use vault_read for canonical text or switch to Original to view page images.');
        }
        if (view?.renderPageWithInfo || view?.renderPage) {
            const info = await describe(view);
            const count = 'pageCount' in info ? info.pageCount : 0;
            const target = page ?? ('page' in info ? info.page : 1);
            if (target > count) throw new ToolError(`page ${target} is past the end of "${path}", which has ${count} page${count === 1 ? '' : 's'}.`);
            const annotation = view.kind === 'pdf-annotate' ? ' (with its annotations)' : '';
            if (view.renderPageWithInfo) {
                const result = await withTimeout(view.renderPageWithInfo(target, max), REPORTER_TIMEOUT_MS, 'rendering the page');
                ctx.ensureLive();
                return pngResult(result.png, `${path}, page ${target} of ${count}${annotation}${pdfEmphasisCaption(result.emphasis)}:`, `page ${target}`);
            }
            const blob = await withTimeout(view.renderPage!(target, max), REPORTER_TIMEOUT_MS, 'rendering the page');
            ctx.ensureLive();
            return pngResult(blob, `${path}, page ${target} of ${count}${annotation}:`, `page ${target}`);
        }
        if (!view && ctx.host.nativePdfPicture) {
            const picture = await ctx.host.nativePdfPicture(path, max, { signal: ctx.signal, isCurrent: () => {
                try { ctx.ensureLive(); return !ctx.signal?.aborted; } catch { return false; }
            } });
            ctx.ensureLive();
            if (picture) {
                const count = picture.pageCount;
                const pages = `${count} PDF page${count === 1 ? '' : 's'}`;
                const note = page !== undefined ? ' (an ink board is pictured whole, not by page)' : '';
                return pngResult(picture.png, `${path}, the whole sheet of its ${pages}${note}:`, `"${path}"`);
            }
        }
        const bytes = await ctx.host.readBytes(path);
        if (!bytes) throw new ToolError(`"${path}" could not be read.`);
        const target = page ?? 1;
        const access = ctx.host.closedPdfAgent?.();
        if (!access) throw new ToolError('The PDF engine is unavailable. Open the PDF in the app and try again.');
        const r = await withClosedPdfDeadline(ctx, signal => access.render(path, bytes, target, max, signal));
        ctx.ensureLive();
        if (!r.png) throw new ToolError(`page ${target} is past the end of "${path}", which has ${r.pageCount} page${r.pageCount === 1 ? '' : 's'}.`);
        const emphasis = 'emphasis' in r ? r.emphasis : undefined;
        return pngResult(r.png, `${path}, page ${target} of ${r.pageCount}${pdfEmphasisCaption(emphasis)}:`, `page ${target}`);
    }

    if (isCanvasFile(name) || isNativeDrawingFile(name)) {
        const guard = { signal: ctx.signal, isCurrent: () => {
            try { ctx.ensureLive(); return !ctx.signal?.aborted; } catch { return false; }
        } };
        let native = await ctx.host.nativeCanvasView?.(path, guard) ?? null;
        ctx.ensureLive();
        if (!native && ctx.host.nativeClosedPicture) {
            if (region) throw new ToolError(`"${path}" is closed: a region is shown only for an open board. Open it, or look at a whole page.`);
            const closed = await ctx.host.nativeClosedPicture(path, page, max, guard);
            ctx.ensureLive();
            if (closed) {
                const caption = closed.wholeSheet
                    ? `${path}, the whole ${isNotebookFile(name) ? `notebook of ${closed.count} page${closed.count === 1 ? '' : 's'}` : `drawing (${closed.count} sheet${closed.count === 1 ? '' : 's'}; the first)`}:`
                    : `${path}, page ${closed.page} of ${closed.count}:`;
                return pngResult(closed.png, caption, `"${path}"`);
            }
        }
        if (!native) {
            await ctx.host.openCanvasForAgent(path);
            ctx.ensureLive();
            native = await ctx.host.nativeCanvasView?.(path, guard) ?? null;
            ctx.ensureLive();
        }
        if (!native) throw new ToolError(`"${path}" could not be opened to look at (it did not finish loading).`);
        const info = native.info;
        if (info.kind === 'notebook' && page !== undefined && page > info.pageCount) {
            throw new ToolError(`page ${page} is past the end of "${path}", which has ${info.pageCount} page${info.pageCount === 1 ? '' : 's'}.`);
        }
        const shownPage = info.kind === 'drawing' ? undefined : page;
        const blob = await withTimeout(native.capture(max, ctx.signal, shownPage, region), REPORTER_TIMEOUT_MS, 'capturing the canvas');
        ctx.ensureLive();
        return pngResult(blob, nativeViewCaption(path, native, shownPage, region), `"${path}"`);
    }

    throw new ToolError(`vault_view shows PDFs, notebooks, drawings and images; "${path}" is text — read it with vault_read.`);
}

async function vaultSearch(a: Args, ctx: Ctx): Promise<ToolExecution> {
    const query = String(a.query);
    const scope = a.path !== undefined ? ctx.path(a.path) : '';
    const maxResults = typeof a.maxResults === 'number' ? a.maxResults : 100;
    const token = ctx.host.vaultToken();
    let textFileCount = 0;
    let answer: MatchAnswer;
    try {
        if (scope) {
            const kind = await ctx.host.entryKind(scope);
            if (!kind) throw new ToolError(`"${scope}" does not exist.`);
        }
        ctx.ensureLive();
        const inScope = (p: string) => !scope || p === scope || p.startsWith(`${scope}/`);
        textFileCount = collectFiles(ctx.host.getFileTree()).filter(f => inScope(f.path) && isTextFile(f.name) && !isCanvasFile(f.name)).length;
        answer = await ctx.host.searchAgent({ query, regex: a.regex === true, caseSensitive: a.caseSensitive === true, scope, maxResults }, ctx.signal);
        ctx.ensureLive();
        if (ctx.host.vaultToken() !== token) throw new ToolError(SWITCHED);
    } catch (err) {
        if (err instanceof Error && err.name === 'SyntaxError') throw new ToolError(err.message);
        throw err;
    }
    const { out, count, fileCount, stopped, incomplete } = answer;
    const where = scope ? ` in "${scope}"` : '';
    if (!out.length && !incomplete) {
        return ok(`No matches for ${JSON.stringify(query)}${where}. (Searched ${textFileCount} text files and every file name; EPUB/PDF text, drawings and notebooks are not searched — read those with vault_read.)`);
    }
    const summary = `${count} match${count === 1 ? '' : 'es'} in ${fileCount} file${fileCount === 1 ? '' : 's'} for ${JSON.stringify(query)}${where} (format: path:line: text)`;
    if (stopped) out.push(`…[stopped at maxResults=${maxResults}; narrow the query, pass path to search one folder, or raise maxResults (≤ 500)]`);
    const status = incomplete ? [`…[incomplete:true; ${answer.reason}]`] : [];
    return ok([...status, summary, ...out].join('\n'));
}

function editHints(oldString: string): string {
    const hints: string[] = [];
    if (/⟦\/?(sel|cursor)⟧/.test(oldString)) hints.push('Leave out the ⟦sel⟧/⟦cursor⟧ markers — the context block adds them; they are not in the file.');
    const lines = oldString.split('\n');
    if (lines.length && lines.every(l => /^\d+\t/.test(l))) hints.push('Leave out the "<n><tab>" line-number prefixes vault_read adds.');
    return hints.length ? ` ${hints.join(' ')}` : '';
}

function applyLocally(text: string, changes: TextChange[]): string {
    let out = '';
    let at = 0;
    for (const c of changes) { out += text.slice(at, c.from) + c.insert; at = c.to; }
    return out + text.slice(at);
}

function editSnippet(after: string, changes: TextChange[]): string {
    const first = changes[0];
    const startLine = lineOfOffset(after, first.from);
    const endLine = lineOfOffset(after, first.from + first.insert.length);
    const from = Math.max(1, startLine - 3);
    const to = Math.min(endLine + 3, from + 40);
    return numberedSlice(after, from, to);
}

async function commitText(ctx: Ctx, path: string, before: string, changes: TextChange[], verb: string): Promise<{ after: string; hash: string }> {
    ctx.ensureLive();
    const r = await ctx.host.applyTextChanges(path, before, changes);
    if (!r.ok) throw hostFailure(r, verb, path);
    const after = applyLocally(before, changes);
    return { after, hash: await sha256Hex(after) };
}

async function vaultEdit(a: Args, ctx: Ctx): Promise<ToolExecution> {
    const path = ctx.writablePath(a.path);
    assertEditableText(path);
    await requireFile(ctx, path);
    const oldString = normalizeNewlines(String(a.old_string));
    const newString = normalizeNewlines(String(a.new_string));
    if (oldString === newString) throw new ToolError('old_string and new_string are identical; nothing to change.');
    const current = await ctx.host.readText(path);
    ctx.ensureLive();
    if (current === null) throw new ToolError(`"${path}" could not be read.`);
    assertDecodedText(path, current);

    const hits: number[] = [];
    for (let i = current.indexOf(oldString); i !== -1; i = current.indexOf(oldString, i + oldString.length)) hits.push(i);
    if (!hits.length) {
        throw new ToolError(`old_string was not found in "${path}". It must match the current text exactly, whitespace and line breaks included; the file may also have changed — read it again with vault_read.${editHints(oldString)}`);
    }
    if (hits.length > 1 && a.replace_all !== true) {
        const where = hits.slice(0, 10).map(h => lineOfOffset(current, h)).join(', ');
        throw new ToolError(`old_string occurs ${hits.length} times in "${path}" (lines ${where}${hits.length > 10 ? ', …' : ''}). Include more of the surrounding text to make it unique, or set replace_all: true to change every one.`);
    }
    const changes: TextChange[] = hits.map(from => ({ from, to: from + oldString.length, insert: newString }));
    const { after, hash } = await commitText(ctx, path, current, changes, 'edit');
    const d = lineDiff(current, after);
    return ok(
        `Edited ${path}: replaced ${hits.length} occurrence${hits.length === 1 ? '' : 's'} (+${d.added} −${d.removed} lines). It is in the user's editor now (undoable with ⌘Z).\nnew hash: ${hash}\n\n${editSnippet(after, changes)}`,
        { kind: 'edit', path, added: d.added, removed: d.removed, diff: d.diff },
    );
}

async function vaultWrite(a: Args, ctx: Ctx): Promise<ToolExecution> {
    const path = ctx.writablePath(a.path);
    assertEditableText(path);
    await requireFile(ctx, path);
    const content = normalizeNewlines(String(a.content));
    const current = await ctx.host.readText(path);
    ctx.ensureLive();
    if (current === null) throw new ToolError(`"${path}" could not be read.`);
    assertDecodedText(path, current);
    if ((await sha256Hex(current)) !== String(a.base_hash).trim().toLowerCase()) throw new ToolError(STALE);
    if (content === current) return ok(`${path} already has exactly this text; nothing changed.`);

    let head = 0;
    const maxHead = Math.min(current.length, content.length);
    while (head < maxHead && current.charCodeAt(head) === content.charCodeAt(head)) head++;
    let tail = 0;
    while (tail < current.length - head && tail < content.length - head
        && current.charCodeAt(current.length - 1 - tail) === content.charCodeAt(content.length - 1 - tail)) tail++;
    const changes: TextChange[] = [{ from: head, to: current.length - tail, insert: content.slice(head, content.length - tail) }];
    const { hash } = await commitText(ctx, path, current, changes, 'write');
    const d = lineDiff(current, content);
    return ok(
        `Wrote ${path} (+${d.added} −${d.removed} lines). It is in the user's editor now (undoable with ⌘Z).\nnew hash: ${hash}`,
        { kind: 'edit', path, added: d.added, removed: d.removed, diff: d.diff },
    );
}

async function requireParentFolder(ctx: Ctx, path: string): Promise<void> {
    const parent = parentVaultPath(path);
    const kind = await kindOf(ctx, parent);
    if (kind === 'file') throw new ToolError(`"${parent}" is a file, so nothing can be created inside it.`);
    if (!kind) throw new ToolError(`the folder "${parent}" does not exist; create it first with vault_mkdir.`);
}

async function vaultCreate(a: Args, ctx: Ctx): Promise<ToolExecution> {
    const path = ctx.writablePath(a.path);
    const name = baseName(path);
    const content = normalizeNewlines(typeof a.content === 'string' ? a.content : '');
    if (isCanvasFile(name)) {
        // The host creates a real empty native document when that route is
        // selected; arbitrary agent-authored snapshots never become editor input.
        if (content.trim()) throw new ToolError(`create the ${isNotebookFile(name) ? 'notebook' : 'drawing'} empty (no content), then add to it with canvas_apply.`);
    } else if (isPdfFile(name) || (isImageFile(name) && !/\.svg$/i.test(name)) || !isTextFile(name)) {
        throw new ToolError(`vault_create makes text files (notes are .md), empty drawings (.drawing) and empty notebooks (.notebook); it cannot make "${name}".`);
    }
    await requireParentFolder(ctx, path);
    ctx.ensureLive();
    const r = await ctx.host.createFile(path, isCanvasFile(name) ? '' : content);
    if (!r.ok) throw hostFailure(r, 'create', path);
    if (isCanvasFile(name)) {
        return ok(`Created the empty ${isNotebookFile(name) ? 'notebook' : 'drawing'} ${path}. Add to it with canvas_apply.`, { kind: 'create', path, folder: false, diff: [] });
    }
    const d = creationDiff(content);
    const lines = content === '' ? 0 : content.split('\n').length;
    return ok(`Created ${path} (${lines} line${lines === 1 ? '' : 's'}).\nhash: ${await sha256Hex(content)}`, { kind: 'create', path, folder: false, diff: d.diff });
}

async function vaultMkdir(a: Args, ctx: Ctx): Promise<ToolExecution> {
    const path = ctx.writablePath(a.path);
    await requireParentFolder(ctx, path);
    ctx.ensureLive();
    const r = await ctx.host.mkdir(path);
    if (!r.ok) throw hostFailure(r, 'create the folder', path);
    return ok(`Created the folder ${path}/.`, { kind: 'create', path, folder: true, diff: [] });
}

async function vaultMove(a: Args, ctx: Ctx): Promise<ToolExecution> {
    // Before canonicalPath folds `to` onto `from`: a case-only rename is the
    // same entry on macOS/Windows file systems.
    const rawFrom = normalizeAgentPath(a.from);
    const rawTo = normalizeAgentPath(a.to);
    if (rawFrom !== null && rawTo !== null && rawFrom !== rawTo && foldName(rawFrom) === foldName(rawTo)) {
        throw new ToolError('renaming only the letter case is not supported; rename to a different name.');
    }
    const from = ctx.writablePath(a.from);
    const to = ctx.writablePath(a.to);
    if (isAppFolder(from)) throw new ToolError(`"${from}" is one of the app's own folders and cannot be moved or renamed.`);
    if (from === to) throw new ToolError('from and to are the same path.');
    if (to.startsWith(`${from}/`)) throw new ToolError(`cannot move "${from}" into itself.`);
    const kind = await ctx.host.entryKind(from);
    if (!kind) throw new ToolError(`"${from}" does not exist. Check the name with vault_list.`);
    await requireParentFolder(ctx, to);
    ctx.ensureLive();
    const r = await ctx.host.move(from, to);
    if (!r.ok) throw hostFailure(r, 'move', r.reason === 'taken' || r.reason === 'no-parent' ? to : from);
    return ok(`Moved ${kind === 'directory' ? 'the folder ' : ''}${from} → ${to}. Open tabs followed it.`, { kind: 'move', from, to });
}

async function vaultTrash(a: Args, ctx: Ctx): Promise<ToolExecution> {
    const path = ctx.writablePath(a.path);
    if (isAppFolder(path)) throw new ToolError(`"${path}" is one of the app's own folders and cannot be trashed.`);
    const kind = await ctx.host.entryKind(path);
    if (!kind) throw new ToolError(`"${path}" does not exist. Check the name with vault_list.`);
    ctx.ensureLive();
    const r = await ctx.host.trash(path);
    if (!r.ok) throw hostFailure(r, 'move to the trash', path);
    const bin = `${parentVaultPath(path) ? `${parentVaultPath(path)}/` : ''}${TRASH_DIR}`;
    return ok(`Moved ${kind === 'directory' ? 'the folder ' : ''}${path} to the trash (${bin}). The user can restore it from the Trash panel.`, { kind: 'trash', path });
}

function assertCanvasPath(path: string, supportsNative: boolean): void {
    if (isNativeDrawingFile(path) && supportsNative) return;
    assertSupportedCanvasFormat(path);
    const name = baseName(path);
    if (!isCanvasFile(name) && !isPdfFile(name)) {
        throw new ToolError(`"${path}" is not a drawing (.drawing), notebook (.notebook) or PDF; canvas tools work only on those.`);
    }
}

async function nativeShapePage(ctx: Ctx, path: string, query: CanvasShapeQuery): Promise<CanvasShapePage | undefined> {
    if (!ctx.host.canvasShapePage) return undefined;
    const result = await ctx.host.canvasShapePage(path, query, { signal: ctx.signal, isCurrent: () => {
        try { ctx.ensureLive(); return !ctx.signal?.aborted; } catch { return false; }
    } });
    ctx.ensureLive();
    return result ?? undefined;
}

async function canvasShapes(a: Args, ctx: Ctx): Promise<ToolExecution> {
    const path = ctx.path(a.path);
    assertCanvasPath(path, !!ctx.host.canvasShapePage);
    await requireFile(ctx, path);
    const page = typeof a.page === 'number' ? a.page : undefined;
    if (a.offset !== undefined || a.limit !== undefined || a.revision !== undefined) {
        const query = { page, offset: a.offset as number | undefined, limit: a.limit as number | undefined,
            revision: a.revision as number | undefined };
        const result = await nativeShapePage(ctx, path, query);
        if (ctx.signal?.aborted) throw new ToolError('Canvas read cancelled.');
        if (!result) throw new ToolError(isPdfFile(path)
            ? 'Open the PDF in annotation mode to page its shapes.' : 'Shape paging is unavailable for this board.');
        const offset = result.revisionChanged ? 0 : query.offset ?? 0;
        const shown = pagedShapeLines(result, offset, MAX_TOOL_TEXT_CHARS - 1500), lines = shown.lines;
        const next = offset + shown.count;
        const head = [`path: ${path}`, `revision: ${result.revision}`, `total: ${result.total}`,
            ...(result.revisionChanged ? ['Revision changed; restarted at offset 0.'] : []),
            ...(next < result.total ? [`nextOffset: ${next}`] : []),
            isPdfFile(path) || isNotebookFile(path) ? COORDS_PAGED : COORDS_DRAWING];
        return ok([...head, '', ...lines].join('\n'));
    }
    if (isPdfFile(baseName(path))) {
        const result = await nativeShapePage(ctx, path, { page });
        if (!result) throw new ToolError(`Open "${path}" in annotation mode to read its shapes.`);
        const head = [`path: ${path}`, `revision: ${result.revision}`, `total: ${result.total}`, COORDS_PAGED];
        return ok([...head, '', ...pagedShapeLines(result, 0, MAX_TOOL_TEXT_CHARS - 1500).lines].join('\n'));
    }
    const { head, lines } = await canvasShapesFromAnywhere(ctx, path, page);
    return ok([...head, '', ...lines].join('\n'));
}

const OP_NOUN: Record<string, string> = { text: 'text', note: 'sticky note', geo: 'shape', line: 'line', arrow: 'arrow', draw: 'freehand stroke' };

function canvasSummary(ops: CanvasOp[], r: CanvasApplyResult): string {
    const parts: string[] = [];
    if (r.created.length) {
        const byType = new Map<string, number>();
        for (const op of ops) if (op.op === 'create') byType.set(op.type, (byType.get(op.type) ?? 0) + 1);
        const kinds = [...byType].map(([t, n]) => `${n} ${OP_NOUN[t] ?? t}${n === 1 ? '' : 's'}`).join(', ');
        parts.push(`added ${r.created.length === ops.filter(o => o.op === 'create').length ? kinds : `${r.created.length} shapes`}`);
    }
    if (r.updated.length) parts.push(`changed ${r.updated.length} shape${r.updated.length === 1 ? '' : 's'}`);
    if (r.deleted.length) parts.push(`deleted ${r.deleted.length} shape${r.deleted.length === 1 ? '' : 's'}`);
    const text = parts.join('; ') || 'no change';
    return text.charAt(0).toUpperCase() + text.slice(1);
}

async function canvasApply(a: Args, ctx: Ctx): Promise<ToolExecution> {
    const path = ctx.writablePath(a.path);
    assertCanvasPath(path, !!ctx.host.canvasShapePage);
    await requireFile(ctx, path);
    const ops = a.ops as CanvasOp[];
    let r: CanvasApplyResult;
    try {
        const native = await ctx.host.canvasApplyNative?.(path, ops, { signal: ctx.signal, isCurrent: () => {
            try { ctx.ensureLive(); return !ctx.signal?.aborted; } catch { return false; }
        } });
        if (!native) throw new ToolError(`"${path}" is not a board this build can edit.`);
        r = native;
    } catch (err) {
        throw new ToolError(`the canvas refused the change: ${err instanceof Error ? err.message : String(err)}. Nothing was applied.`);
    }
    const changed = r.created.length + r.updated.length + r.deleted.length;
    const lines = [`${changed ? 'Applied to' : 'Nothing was applied to'} ${path}${changed ? ' as one undo step' : ''}: created ${r.created.length}, updated ${r.updated.length}, deleted ${r.deleted.length}.`];
    if (r.created.length) lines.push(`created ids (in op order): ${r.created.join(', ')}`);
    if (r.updatedShapes?.length) {
        lines.push('updated geometry (read after applying):', ...r.updatedShapes.map(shape =>
            `- ${shape.id}: x=${shape.x}, y=${shape.y}, w=${shape.w}, h=${shape.h}${shape.page === undefined ? '' : `, page=${shape.page}`}${shape.rotation === undefined ? '' : `, rotation=${shape.rotation}`}`));
    }
    if (r.errors.length) lines.push('problems:', ...r.errors.map(e => `- ${e}`));
    if (!changed) return { result: textResult(`Error: ${lines.join('\n')}`, true) };
    return ok(lines.join('\n'), {
        kind: 'canvas', path,
        created: r.created.length, updated: r.updated.length, deleted: r.deleted.length,
        summary: canvasSummary(ops, r),
    });
}

const HANDLERS: Record<ToolName, (a: Args, ctx: Ctx) => Promise<ToolExecution>> = {
    vault_list: vaultList,
    vault_read: vaultRead,
    vault_view: vaultView,
    vault_search: vaultSearch,
    vault_edit: vaultEdit,
    vault_write: vaultWrite,
    vault_create: vaultCreate,
    vault_mkdir: vaultMkdir,
    vault_move: vaultMove,
    vault_trash: vaultTrash,
    canvas_shapes: canvasShapes,
    canvas_apply: canvasApply,
};

const TOOL_DEFS = new Map<string, ToolDef>(VAULT_TOOLS.map(t => [t.name, t]));

export async function executeTool(
    name: string,
    args: Record<string, unknown>,
    host: VaultToolHost,
    run: { vaultToken: object | null; signal?: AbortSignal; helperVersion?: string },
): Promise<ToolExecution> {
    const def = TOOL_DEFS.get(name);
    if (!def) return fail(`unknown tool "${name}". Available: ${VAULT_TOOLS.map(t => t.name).join(', ')}.`);
    try {
        const ctx = makeCtx(host, run);
        ctx.ensureLive();
        const clean = dropNulls(args ?? {});
        if (name === 'canvas_shapes' && clean !== null && typeof clean === 'object'
            && ('offset' in clean || 'limit' in clean || 'revision' in clean)
            && (!run.helperVersion || compareVersions(run.helperVersion, CANVAS_PAGING_VERSION) < 0)) {
            return fail('canvas_shapes paging requires a newer VaultAgent helper.');
        }
        const problems = validateAgainstSchema(def.inputSchema, clean);
        if (problems.length) return fail(`invalid arguments for ${name}:\n- ${problems.join('\n- ')}`);
        const out = await HANDLERS[def.name](clean as Args, ctx);
        return { ...out, result: capContent(out.result) };
    } catch (err) {
        if (err instanceof ToolError) return fail(err.message);
        console.error(`VaultAgent tool ${name} failed:`, err);
        return fail(`${name} failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
    }
}
