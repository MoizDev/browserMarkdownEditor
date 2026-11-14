// The AI agent's hands: every `vault_*` / `canvas_*` tool call the agent CLI
// makes arrives here (CLI → helper MCP → WebSocket → agentBridge) and is run
// against the OPEN VAULT through App's VaultToolHost — never against a path on
// disk. This file is where the vault tools' rules are enforced (the CLI's own
// tools are outside it):
//
//   1. Paths. Everything is vault-relative and normalized here
//      (normalizeAgentPath) before the host sees it: nothing absolute, no `..`,
//      no `\`, no control characters. The host resolves the rest by walking
//      handles down from the vault's root handle, so there is no string that
//      names anything outside it.
//   2. The app's own ground. `.VaultAgent/` (the chat index and vault id) can
//      be neither read nor written; a `.Garbage/` trash is read-only (deleting
//      goes through vault_trash, which moves rather than erases); the root's
//      `.appearance.json` is the app's settings file and read-only.
//   3. One vault per run. A run captures `host.vaultToken()` when it starts;
//      once the user switches vaults every call is refused, re-checked after
//      each await before anything is written.
//   4. Arguments. Validated against the very schemas the agent was served
//      (shared/vaultAgentTools.ts VAULT_TOOLS, via agentSchema.ts).
//
// NEVER THROWS: every failure comes back as an `isError` result whose text
// tells the agent what to do next ("read it again and retry", "create the
// folder first"), because a thrown error would reach it as an opaque failure.
//
// Bundle discipline: this module is on the agent panel's lazy path and imports
// no renderer. pdf.js is reached only through `import('./pdfText')` for a PDF
// that is not open; open documents are read through their panes' reporters
// (utils/viewRegistry.ts); tldraw is never imported — closed canvases are read
// from their JSON (canvasFileSummary.ts), and changes go through the live
// canvas the host opens.

import { CANVAS_PAGING_VERSION, MAX_TOOL_TEXT_CHARS, compareVersions, type CanvasOp, type ToolContent, type ToolName, type ToolResult } from '../../shared/vaultAgentProtocol';
import { VAULT_TOOLS, type ToolDef } from '../../shared/vaultAgentTools';
import type { AgentChange, HostResult, VaultToolHost } from '../types/vaultAgent';
import type { FileTreeNode } from '../types';
import { getView, type CanvasApplyResult, type CanvasShapePage, type ShapeSummary, type TextChange, type ViewReporter } from './viewRegistry';
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
import { routeEngines } from './engineRouting';
import type { MatchAnswer } from './agentMatcher/types';

export interface ToolExecution {
    result: ToolResult;
    /** Present when the call changed the vault (the panel's change card). */
    change?: AgentChange;
}

/* ───────────────────────── limits ───────────────────────── */

/** vault_list stops walking after this many entries. */
const MAX_LIST_ENTRIES = 2000;
/** A single line longer than this is cut in vault_read output (minified files). */
const MAX_READ_LINE = 4000;
/** vault_read of a PDF reads at most this many pages per call. */
const MAX_PDF_PAGES_PER_READ = 50;
/** Waiting on a pane's reporter (a render, a text extraction). */
const REPORTER_TIMEOUT_MS = 20_000;

/* ───────────────────────── results ───────────────────────── */

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

/** Thrown inside a handler to end the call with an error result. */
class ToolError extends Error {}

/** Last-resort size cap — each handler pages its own output first, so this
 *  only catches what a handler under-estimated. */
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

/* ───────────────────────── paths ───────────────────────── */

/** NUL and the other C0 controls, and DEL: no file name needs one, and a NUL
 *  is how a path smuggles a second meaning past a string check. */
function hasControlChar(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) return true;
    }
    return false;
}

/** Normalize an agent-supplied path, or say exactly why it is refused. */
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

/** Case- and Unicode-normalization-folded, for matching names the way the
 *  macOS and Windows file systems do. */
const foldName = (s: string) => s.normalize('NFC').toLowerCase();

/**
 * Rewrite each segment to the entry's real on-disk spelling, as the file tree
 * has it. The file systems under the vault (APFS, NTFS) resolve `notes/idea.md`
 * to `Notes/Idea.md`, but everything the app keys on a path — open tabs, the
 * view registry, "is this inside that" — compares exactly. Unresolved, a
 * mis-cased edit bypassed the open tab (its next autosave clobbered it) and a
 * mis-cased `vault_move Notes → notes/Sub` passed the into-itself check and
 * moveFile then deleted the folder it had copied into itself. A segment with
 * no single match (a new name, a hidden folder) is kept as the agent wrote it.
 */
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

/** Vault-relative, '/'-separated, normalized path, or null when invalid. */
export function normalizeAgentPath(input: unknown): string | null {
    const r = checkPath(input);
    return 'path' in r ? r.path : null;
}

const lower = (s: string) => s.toLowerCase();
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function inTrash(path: string): boolean {
    return path.split('/').some(seg => lower(seg) === lower(TRASH_DIR));
}

/** Why `path` may not be created/changed/moved/removed by the agent, or null. */
function writeRefusal(path: string): string | null {
    if (path === '') return 'the vault root itself cannot be changed';
    if (inTrash(path)) {
        return `"${path}" is in a ${TRASH_DIR} folder (the trash), which is read-only. Delete things with vault_trash; restoring from the trash is for the user (the Trash panel in the sidebar).`;
    }
    // At every depth for the looks file: there is one per customized folder.
    if (lower(baseName(path)) === lower(ENTRY_STYLE_FILE)
        || (!path.includes('/') && lower(path) === lower(LEGACY_STYLE_FILE))) {
        return `"${path}" is the app's own settings file (icons, colours, custom order) and cannot be changed with tools`;
    }
    return null;
}

/** App folders a moved/trashed entry may not BE (their contents are fine). */
function isAppFolder(path: string): boolean {
    const name = lower(baseName(path));
    return name === lower(ASSETS_DIR) || name === lower(TRASH_DIR);
}

/* ───────────────────────── the call context ───────────────────────── */

type Args = Record<string, unknown>;

interface Ctx {
    host: VaultToolHost;
    signal?: AbortSignal;
    /** Throws a ToolError unless the run's vault is still the open one. */
    ensureLive(): void;
    /** A normalized path argument, or a ToolError saying why not. */
    path(value: unknown): string;
    /** `path` plus the agent's write rules. */
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

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new ToolError(`${what} timed out`)), ms);
        promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
    });
}

async function describe(view: ViewReporter) {
    return withTimeout(Promise.resolve(view.describe()), REPORTER_TIMEOUT_MS, 'reading the open view');
}

/** A PDF's reporter can serve reads only while it is the one showing the file. */
function openPdfView(path: string): ViewReporter | undefined {
    const view = getView(path);
    return view && (view.kind === 'pdf' || view.kind === 'pdf-annotate') ? view : undefined;
}

/** Existence as the host sees it; the root always exists. */
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

/** Text files the agent may edit as text: not a PDF/image/binary, and not a
 *  drawing or notebook (JSON on disk, but edited through canvas_apply so the
 *  open canvas and its undo history stay the source of truth). */
function assertEditableText(path: string): void {
    assertSupportedCanvasFormat(path);
    const name = baseName(path);
    if (isCanvasFile(name)) throw new ToolError(`"${path}" is a ${isNotebookFile(name) ? 'notebook' : 'drawing'}; change it with canvas_apply, not as text.`);
    if (isPdfFile(name)) throw new ToolError(`"${path}" is a PDF; its text cannot be edited. Annotate it with canvas_apply.`);
    if (!isTextFile(name)) throw new ToolError(`"${path}" is not a text file.`);
}

/** Tool arguments with `null`s dropped: the schemas treat an explicit null
 *  for an optional argument as absent, and so does every handler. */
function dropNulls(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(dropNulls);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) if (v !== null) out[k] = dropNulls(v);
        return out;
    }
    return value;
}

/** `\r\n` → `\n`: every buffer and file the app holds is normalized
 *  (readFile, CodeMirror), so agent text must be too or nothing ever matches. */
const normalizeNewlines = (text: string) => text.replace(/\r\n?/g, '\n');

function lineOfOffset(text: string, offset: number): number {
    let line = 1;
    for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++;
    return line;
}

/** Numbered lines `from..to` (1-based, inclusive) of `text`. */
function numberedSlice(text: string, from: number, to: number): string {
    const lines = text.split('\n');
    const out: string[] = [];
    for (let n = Math.max(1, from); n <= Math.min(lines.length, to); n++) {
        const line = lines[n - 1];
        out.push(`${n}\t${line.length > MAX_READ_LINE ? `${line.slice(0, MAX_READ_LINE)}…` : line}`);
    }
    return out.join('\n');
}

/* ───────────────────────── vault_list ───────────────────────── */

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
            // .VaultAgent is never listed, includeHidden or not: every read and
            // write of it is refused, so showing it would only invite attempts.
            if (dir === '' && name === lower(VAULT_AGENT_DIR)) return false;
            // `.git` (a folder, or the file a worktree/submodule has) is hidden
            // from the sidebar at every depth (utils/vaultEntries.ts) and from
            // this default listing too: thousands of object files that are not
            // notes. Only that one rule is shared with the tree — NOT the whole
            // isHiddenVaultEntry, which would also hide `.claude`/`.agents`
            // that the agent is meant to see.
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

/* ───────────────────────── vault_read ───────────────────────── */

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
        // A few pages per request, so a long document stops at the budget
        // rather than extracting fifty pages to keep three.
        for (let p = first; p <= pageCount && pages.length < maxPages;) {
            const batch = Array.from({ length: Math.min(5, maxPages - pages.length, pageCount - p + 1) }, (_, i) => p + i);
            const got = await withTimeout(view.pdfText(batch), REPORTER_TIMEOUT_MS, 'extracting the PDF text');
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
        const tiled = routeEngines().pdfViewer === 'tiled';
        const access = tiled ? ctx.host.closedPdfAgent?.() : null;
        if (tiled && !access) throw new ToolError('The PDF engine is unavailable. Open the PDF in the app and try again.');
        const r = access
            ? await withClosedPdfDeadline(ctx, signal => access.read(path, bytes, first, maxPages, budget, signal))
            : await (await import('./pdfText')).readPdfText(bytes, first, maxPages, budget);
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

/** Shape lines up to the char budget, with an overflow note. */
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

/** Shapes of a drawing/notebook from its live pane, or failing that its file. */
async function canvasShapesFromAnywhere(ctx: Ctx, path: string, page: number | undefined): Promise<{ lines: string[]; head: string[] }> {
    const name = baseName(path);
    const notebook = isNotebookFile(name);
    const view = getView(path);
    // The new session owns unsaved data and validates its own SourceOwner; a
    // disk reread here could observe a different revision from the open board.
    if (view?.canvas?.shapePage) {
        const result = view.canvas.shapePage({ page });
        const head = [`path: ${path}`, `${notebook ? 'notebook' : 'drawing'}, open in a pane (live)`,
            `${result.total} shape${result.total === 1 ? '' : 's'}${page ? ` on page ${page}` : ''}`,
            notebook ? COORDS_PAGED : COORDS_DRAWING];
        const lines = shapeLines(result.shapes, MAX_TOOL_TEXT_CHARS - 1500, 'pass page to narrow the result');
        if (result.nextOffset !== undefined) lines.push(`…[${result.total - result.nextOffset} more shapes not shown]`);
        return { head, lines };
    }
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

    if (view?.canvas) {
        const info = await describe(view);
        const shapes = view.canvas.shapes(page);
        const head = [`path: ${path}`, `${notebook ? 'notebook' : 'drawing'}, open in a pane (live)`];
        if (info.kind === 'notebook') head.push(`${info.pageCount} page${info.pageCount === 1 ? '' : 's'}; the user is on page ${info.page}`);
        if (info.kind === 'drawing') head.push(`tldraw page "${info.pageName}" (${info.pageIndex + 1} of ${info.pageCount})`);
        head.push(`${shapes.length} shape${shapes.length === 1 ? '' : 's'}${page ? ` on page ${page}` : ''}`, notebook ? COORDS_PAGED : COORDS_DRAWING);
        return { head, lines: shapeLines(shapes, budget, pageHint) };
    }

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
        if (perPage) lines.push(`— tldraw page "${pg.name}": ${shapes.length} shape${shapes.length === 1 ? '' : 's'}`);
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

/* ───────────────────────── vault_view ───────────────────────── */

async function pngResult(blob: Blob | null, caption: string, what: string): Promise<ToolExecution> {
    if (!blob) throw new ToolError(`${what} could not be rendered.`);
    const img = await prepareImageForAgent(await blobBytes(blob), blob.type || 'image/png');
    return ok(caption, undefined, [{ type: 'image', data: img.data, mimeType: img.mimeType }]);
}

async function vaultView(a: Args, ctx: Ctx): Promise<ToolExecution> {
    const path = ctx.path(a.path);
    if (!getView(path)?.canvas?.shapePage && !ctx.host.canvasShapePage) assertSupportedCanvasFormat(path);
    await requireFile(ctx, path);
    const name = baseName(path);
    const page = typeof a.page === 'number' ? a.page : undefined;
    const max = AGENT_IMAGE_MAX_SIDE;

    if (isEpubFile(name)) throw new ToolError('EPUB image capture is unavailable. vault_read can provide bounded visible canonical text from an open book.');
    if (isImageFile(name)) return readImage(ctx, path, 'view');

    if (isPdfFile(name)) {
        const view = openPdfView(path);
        if (view) {
            const info = await describe(view);
            if (info.kind === 'pdf' && info.surface === 'text') throw new ToolError('PDF Text image capture is unavailable. Use vault_read for canonical text or switch to Original to view page images.');
        }
        if (view?.renderPage) {
            const info = await describe(view);
            const count = 'pageCount' in info ? info.pageCount : 0;
            const target = page ?? ('page' in info ? info.page : 1);
            if (target > count) throw new ToolError(`page ${target} is past the end of "${path}", which has ${count} page${count === 1 ? '' : 's'}.`);
            const blob = await withTimeout(view.renderPage(target, max), REPORTER_TIMEOUT_MS, 'rendering the page');
            ctx.ensureLive();
            return pngResult(blob, `${path}, page ${target} of ${count}${view.kind === 'pdf-annotate' ? ' (with its annotations)' : ''}:`, `page ${target}`);
        }
        const bytes = await ctx.host.readBytes(path);
        if (!bytes) throw new ToolError(`"${path}" could not be read.`);
        const target = page ?? 1;
        const tiled = routeEngines().pdfViewer === 'tiled';
        const access = tiled ? ctx.host.closedPdfAgent?.() : null;
        if (tiled && !access) throw new ToolError('The PDF engine is unavailable. Open the PDF in the app and try again.');
        const r = access
            ? await withClosedPdfDeadline(ctx, signal => access.render(path, bytes, target, max, signal))
            : await (await import('./pdfText')).renderPdfPage(bytes, target, max);
        ctx.ensureLive();
        if (!r.png) throw new ToolError(`page ${target} is past the end of "${path}", which has ${r.pageCount} page${r.pageCount === 1 ? '' : 's'}.`);
        return pngResult(r.png, `${path}, page ${target} of ${r.pageCount}:`, `page ${target}`);
    }

    if (isCanvasFile(name) || isNativeDrawingFile(name)) {
        // A closed canvas opens beside the user without taking focus.
        let view = getView(path);
        if (!view?.canvas) {
            view = (await ctx.host.openCanvasForAgent(path)) ?? undefined;
            ctx.ensureLive();
        }
        if (!view) throw new ToolError(`"${path}" could not be opened to look at (it did not finish loading).`);
        if (isNativeDrawingFile(name) && !view.canvas?.shapePage) throw new ToolError(`"${path}" is not open as a native board.`);
        if (isNotebookFile(name) && view.renderPage) {
            const info = await describe(view);
            const count = info.kind === 'notebook' ? info.pageCount : 1;
            const target = page ?? (info.kind === 'notebook' ? info.page : 1);
            if (target > count) throw new ToolError(`page ${target} is past the end of "${path}", which has ${count} page${count === 1 ? '' : 's'}.`);
            const blob = await withTimeout(view.renderPage(target, max), REPORTER_TIMEOUT_MS, 'rendering the page');
            ctx.ensureLive();
            return pngResult(blob, `${path}, page ${target} of ${count}:`, `page ${target}`);
        }
        if (!view.capture) throw new ToolError(`"${path}" cannot be rendered.`);
        const blob = await withTimeout(view.capture(max), REPORTER_TIMEOUT_MS, 'capturing the canvas');
        ctx.ensureLive();
        const info = await describe(view);
        const where = info.kind === 'drawing'
            ? ` — the part on screen: x ${Math.round(info.viewport.x)}…${Math.round(info.viewport.x + info.viewport.w)}, y ${Math.round(info.viewport.y)}…${Math.round(info.viewport.y + info.viewport.h)}`
            : '';
        return pngResult(blob, `${path}${where}:`, `"${path}"`);
    }

    throw new ToolError(`vault_view shows PDFs, notebooks, drawings and images; "${path}" is text — read it with vault_read.`);
}

/* ───────────────────────── vault_search ───────────────────────── */

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
    // Measured: 295 acknowledged matches filled the 60k text cap and clipped a trailing timeout.
    // Even query text is unbounded, so status must precede the summary as well as the rows.
    const status = incomplete ? [`…[incomplete:true; ${answer.reason}]`] : [];
    return ok([...status, summary, ...out].join('\n'));
}

/* ───────────────────────── text edits ───────────────────────── */

function editHints(oldString: string): string {
    const hints: string[] = [];
    if (/⟦\/?(sel|cursor)⟧/.test(oldString)) hints.push('Leave out the ⟦sel⟧/⟦cursor⟧ markers — the context block adds them; they are not in the file.');
    const lines = oldString.split('\n');
    if (lines.length && lines.every(l => /^\d+\t/.test(l))) hints.push('Leave out the "<n><tab>" line-number prefixes vault_read adds.');
    return hints.length ? ` ${hints.join(' ')}` : '';
}

/** Apply `changes` to `text` locally (to diff and hash what the host applied). */
function applyLocally(text: string, changes: TextChange[]): string {
    let out = '';
    let at = 0;
    for (const c of changes) { out += text.slice(at, c.from) + c.insert; at = c.to; }
    return out + text.slice(at);
}

/** The lines around the first change, as they read now — so the agent can see
 *  its edit landed as meant without another read. */
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

    // ONE change covering only what differs (common head and tail kept), so
    // the user's cursor and undo history outside it are left alone.
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

/* ───────────────────────── create / mkdir / move / trash ───────────────────────── */

async function requireParentFolder(ctx: Ctx, path: string): Promise<void> {
    const parent = parentVaultPath(path);
    const kind = await kindOf(ctx, parent);
    if (kind === 'file') throw new ToolError(`"${parent}" is a file, so nothing can be created inside it.`);
    if (!kind) throw new ToolError(`the folder "${parent}" does not exist; create it first with vault_mkdir.`);
}

async function vaultCreate(a: Args, ctx: Ctx): Promise<ToolExecution> {
    const path = ctx.writablePath(a.path);
    if (isNativeDrawingFile(path)) throw new ToolError('This build cannot create native .drawing whiteboards. Create an empty .tldraw drawing instead.');
    const name = baseName(path);
    const content = normalizeNewlines(typeof a.content === 'string' ? a.content : '');
    if (isCanvasFile(name)) {
        // An empty file IS a new drawing/notebook — the app's own "New drawing"
        // and "New notebook" write nothing else (both panes open '' as a blank
        // canvas; a notebook gets default paper). Agent-written JSON would be a
        // snapshot no one validated, loaded straight into tldraw.
        if (content.trim()) throw new ToolError(`create the ${isNotebookFile(name) ? 'notebook' : 'drawing'} empty (no content), then add to it with canvas_apply.`);
    } else if (isPdfFile(name) || (isImageFile(name) && !/\.svg$/i.test(name)) || !isTextFile(name)) {
        throw new ToolError(`vault_create makes text files (notes are .md), empty drawings (.tldraw) and empty notebooks (.notebook); it cannot make "${name}".`);
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

/* ───────────────────────── canvas ───────────────────────── */

function assertCanvasPath(path: string, supportsNative: boolean): void {
    if (isNativeDrawingFile(path) && (supportsNative || getView(path)?.canvas?.shapePage)) return;
    assertSupportedCanvasFormat(path);
    const name = baseName(path);
    if (!isCanvasFile(name) && !isPdfFile(name)) {
        throw new ToolError(`"${path}" is not a drawing (.tldraw), notebook (.notebook) or PDF; canvas tools work only on those.`);
    }
}

async function liveCanvas(ctx: Ctx, path: string): Promise<ViewReporter & { canvas: NonNullable<ViewReporter['canvas']> }> {
    let view = getView(path);
    // Native boards are admitted by their session, never by the legacy text
    // sniffer. A session-backed reporter then fences its own SourceOwner.
    if (isNativeDrawingFile(path) && !view?.canvas?.shapePage) {
        view = (await ctx.host.openCanvasForAgent(path)) ?? undefined;
        ctx.ensureLive();
        if (!view?.canvas?.shapePage) throw new ToolError(`"${path}" could not be opened as a native board.`);
    }
    // Legacy reporters need the loaded representation check; new session
    // reporters instead fence their live SourceOwner immediately before edits.
    if (!isPdfFile(path) && !view?.canvas?.shapePage) await readableCanvasText(ctx, path);
    if (!view?.canvas) {
        view = (await ctx.host.openCanvasForAgent(path)) ?? undefined;
        ctx.ensureLive();
    }
    if (!view?.canvas) {
        throw new ToolError(`"${path}" could not be opened as a canvas (it did not finish loading${isPdfFile(path) ? ', or the PDF cannot be annotated' : ''}). Try again, or ask the user to open it.`);
    }
    return view as ViewReporter & { canvas: NonNullable<ViewReporter['canvas']> };
}

async function canvasShapes(a: Args, ctx: Ctx): Promise<ToolExecution> {
    const path = ctx.path(a.path);
    assertCanvasPath(path, !!ctx.host.canvasShapePage);
    await requireFile(ctx, path);
    const page = typeof a.page === 'number' ? a.page : undefined;
    if (a.offset !== undefined || a.limit !== undefined || a.revision !== undefined) {
        const query = { page, offset: a.offset as number | undefined, limit: a.limit as number | undefined,
            revision: a.revision as number | undefined };
        const view = getView(path);
        let result = view?.canvas?.shapePage?.(query);
        if (!result && !isPdfFile(path) && ctx.host.canvasShapePage) {
            result = (await ctx.host.canvasShapePage(path, query, { signal: ctx.signal, isCurrent: () => {
                try { ctx.ensureLive(); return !ctx.signal?.aborted; } catch { return false; }
            } })) ?? undefined;
            ctx.ensureLive();
        }
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
        // A PDF's annotations live inside the PDF; only its annotate view
        // reads them out, so this one does open it (beside the user).
        const view = await liveCanvas(ctx, path);
        const result = view.canvas.shapePage?.({ page });
        const shapes = result?.shapes ?? view.canvas.shapes(page), total = result?.total ?? shapes.length;
        const head = [`path: ${path}`, `PDF annotations (live)`, `${total} shape${total === 1 ? '' : 's'}${page ? ` on page ${page}` : ''}`, COORDS_PAGED];
        const lines = shapeLines(shapes, MAX_TOOL_TEXT_CHARS - 1500, 'pass page to see one page at a time');
        if (result?.nextOffset !== undefined) lines.push(`…[${result.total - result.nextOffset} more shapes not shown]`);
        return ok([...head, '', ...lines].join('\n'));
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
    const view = await liveCanvas(ctx, path);
    ctx.ensureLive();
    if (ctx.signal?.aborted) throw new ToolError('Canvas edit cancelled. Nothing was applied.');
    if (!ctx.host.canvasWritable(path)) throw new ToolError('This canvas is open read-only. Nothing was applied.');
    let r: CanvasApplyResult;
    try {
        r = await view.canvas.apply(ops, { signal: ctx.signal, isCurrent: () => {
            try { ctx.ensureLive(); return !ctx.signal?.aborted && ctx.host.canvasWritable(path); } catch { return false; }
        } });
    } catch (err) {
        throw new ToolError(`the canvas refused the change: ${err instanceof Error ? err.message : String(err)}. Nothing was applied.`);
    }
    const changed = r.created.length + r.updated.length + r.deleted.length;
    const lines = [`${changed ? 'Applied to' : 'Nothing was applied to'} ${path}${changed ? ' as one undo step' : ''}: created ${r.created.length}, updated ${r.updated.length}, deleted ${r.deleted.length}.`];
    if (r.created.length) lines.push(`created ids (in op order): ${r.created.join(', ')}`);
    if (r.errors.length) lines.push('problems:', ...r.errors.map(e => `- ${e}`));
    if (!changed) return { result: textResult(`Error: ${lines.join('\n')}`, true) };
    return ok(lines.join('\n'), {
        kind: 'canvas', path,
        created: r.created.length, updated: r.updated.length, deleted: r.deleted.length,
        summary: canvasSummary(ops, r),
    });
}

/* ───────────────────────── dispatch ───────────────────────── */

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

/** Run one agent tool call against the vault. Never throws: failures come back
 *  as `isError` results the agent can read. */
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
