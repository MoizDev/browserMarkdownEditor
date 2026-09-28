// App's side of the AI agent panel: the two host objects the panel and the
// tool executor are handed (types/vaultAgent.ts), built ONCE for the app's life.
//
// Every method reads the CURRENT App through `getDeps()` (refs App refreshes
// after each commit), so the objects themselves never change identity — the
// panel is lazy, subscribes a WebSocket and holds long-running runs, and a host
// that changed with App's state would restart all of that on every keystroke.
//
// The agent never reaches the disk except through here, and everything here goes
// through the same App handlers the reader's own gestures use: an edit lands in
// the open editor (undoable), a new note refuses a taken name instead of
// truncating it, a move carries its tabs, a deletion goes to `.Garbage`.

import type { EditorState } from '@codemirror/state';
import { MAX_MIRROR_FILE_BYTES, MAX_MIRROR_TOTAL_BYTES, type MirrorFile } from '../../shared/vaultAgentProtocol';
import type { ActiveFile, EditorMode, FileTreeNode, MainView, OpenTab, TabLayout } from '../types';
import type {
    AgentDocKind, AgentHost, AgentTabInfo, AgentWorkspaceSnapshot, ChatIndex, ConfirmRequest,
    HostResult, RememberedPosition, VaultDirEntry, VaultToolHost,
} from '../types/vaultAgent';
import { getView, whenViewReady, type TextChange, type ViewReporter } from './viewRegistry';
import { focusedPath as focusedPathOf } from './tabPanes';
import { joinVaultPath, parentVaultPath } from './paths';
import { readRecord, scopedKey } from './storage';
import { readPdfViewPos } from './pdfViewState';
import { readCanvasViewPos } from './canvasViewState';
import { isScrollAnchor } from '../editor/scrollAnchor';
import {
    isCanvasFile, isDrawingFile, isImageFile, isMarkdownFile, isNotebookFile, isPdfFile,
} from './fileTypes';
import { isTextFile } from './vaultSearch';
import { nameTaken } from './entryNames';
import {
    CHAT_INDEX_FILE, VAULT_AGENT_DIR, VAULT_ID_FILE, emptyChatIndex, parseChatIndex, parseVaultId,
    serializeChatIndex, serializeVaultId,
} from './vaultAgentStore';

/** How long `openCanvasForAgent` waits for a canvas to mount and register. */
const CANVAS_MOUNT_TIMEOUT_MS = 15_000;

/** What the hosts need from App, re-read on every call. */
export interface AgentHostDeps {
    root: FileSystemDirectoryHandle | null;
    fileTree: FileTreeNode[];
    tabs: OpenTab[];
    layout: TabLayout;
    mainView: MainView;
    /** App's EditorState cache, keyed `${tab.id}|${path}`. */
    stateCache: Map<string, EditorState>;
    readFile(handle: FileSystemFileHandle): Promise<string>;
    readFileBytes(handle: FileSystemFileHandle): Promise<Uint8Array>;
    writeFile(handle: FileSystemFileHandle, content: string): Promise<void>;
    createFile(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle>;
    createFolder(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle>;
    /** The save funnel (App.updateTabContent). */
    updateTabContent(path: string, content: string): void;
    /** Everything a save does after its write, for a file written with no tab
     *  open: file time, asset reconcile, graph, search epoch. */
    afterWrite(file: ActiveFile, before: string, after: string): void;
    renameEntry(node: FileTreeNode, newName: string): Promise<boolean>;
    moveEntry(node: FileTreeNode, target: FileSystemDirectoryHandle, targetPath: string): Promise<boolean>;
    /** Confirm-free trash (App.trashEntry). */
    trashEntry(node: FileTreeNode): Promise<'ok' | 'busy' | 'failed'>;
    /** Add a tab for `node` without focusing it; resolves false on a failed read. */
    addTabQuietly(node: FileTreeNode, mode: EditorMode): Promise<boolean>;
    setTabMode(path: string, mode: EditorMode): void;
    /** Show `path` beside the reader without moving the focus (tabPanes.openInSidePane),
     *  switching the main view back to the editor if the graph is up. */
    showBeside(path: string): void;
    openFile(path: string): void;
    ask(request: ConfirmRequest): Promise<boolean>;
    notify(message: string): void;
}

/* ── Paths ── every path reaching here is already normalized by the executor. */

function splitPath(path: string): string[] {
    return path ? path.split('/') : [];
}

async function dirAt(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemDirectoryHandle | null> {
    let dir = root;
    try {
        for (const seg of splitPath(path)) dir = await dir.getDirectoryHandle(seg);
        return dir;
    } catch {
        return null;
    }
}

async function fileAt(root: FileSystemDirectoryHandle, path: string) {
    const parent = await dirAt(root, parentVaultPath(path));
    if (!parent) return null;
    const name = path.slice(path.lastIndexOf('/') + 1);
    try {
        return { handle: await parent.getFileHandle(name), parentHandle: parent, name };
    } catch {
        return null;
    }
}

function findNode(tree: FileTreeNode[], path: string): FileTreeNode | null {
    const segs = splitPath(path);
    let level = tree;
    let node: FileTreeNode | null = null;
    for (const seg of segs) {
        node = level.find(n => n.name === seg) ?? null;
        if (!node) return null;
        level = node.kind === 'directory' ? node.children : [];
    }
    return node;
}

function openTabAt(deps: AgentHostDeps, path: string): OpenTab | undefined {
    return deps.tabs.find(t => t.file.path === path && !t.file.isHelp);
}

function docKind(tab: OpenTab): AgentDocKind {
    const name = tab.file.name;
    if (tab.file.isHelp) return 'help';
    if (isPdfFile(name)) return 'pdf';
    if (isDrawingFile(name)) return 'drawing';
    if (isNotebookFile(name)) return 'notebook';
    if (isMarkdownFile(name)) return 'markdown';
    if (isImageFile(name)) return 'image';
    return isTextFile(name) ? 'text' : 'other';
}

/** Same key and shape DocumentPane writes (its SCROLL_ANCHORS_KEY). */
const SCROLL_ANCHORS_KEY = 'fileScrollAnchors';

function lineAt(text: string, pos: number): number {
    let line = 1;
    const end = Math.min(pos, text.length);
    for (let i = text.indexOf('\n'); i !== -1 && i < end; i = text.indexOf('\n', i + 1)) line++;
    return line;
}

function rememberedPosition(deps: AgentHostDeps, path: string): RememberedPosition | null {
    const tab = openTabAt(deps, path);
    if (!tab) return null;
    const name = tab.file.name;
    if (isPdfFile(name)) {
        const pos = readPdfViewPos(path);
        return pos ? { kind: 'pdf', page: pos.page + 1, offset: pos.offset, zoom: pos.zoom ?? null } : null;
    }
    if (isCanvasFile(name)) {
        const pos = readCanvasViewPos(path);
        if (!pos) return null;
        return pos.kind === 'drawing'
            ? { kind: 'drawing', x: pos.x, y: pos.y, z: pos.z }
            : { kind: 'notebook', page: pos.page + 1, offset: pos.offset, zoom: pos.zoom ?? null };
    }
    const anchor = readRecord<unknown>(SCROLL_ANCHORS_KEY)[scopedKey(path)];
    return isScrollAnchor(anchor) ? { kind: 'markdown', line: lineAt(tab.content, anchor.pos) } : null;
}

/** The live text of an open, readable, text document: the mounted editor first
 *  (it is ahead of `tab.content` by at most the commit in flight), else the tab
 *  buffer. Undefined for anything else — a PDF's buffer is a tldraw snapshot. */
function liveText(deps: AgentHostDeps, path: string): string | undefined {
    const tab = openTabAt(deps, path);
    if (!tab || tab.readError || isPdfFile(tab.file.name)) return undefined;
    return getView(path)?.getText?.() ?? tab.content;
}

function applyToText(text: string, changes: TextChange[]): string {
    const sorted = [...changes].sort((a, b) => a.from - b.from);
    let out = '';
    let at = 0;
    for (const c of sorted) {
        out += text.slice(at, c.from) + c.insert;
        at = c.to;
    }
    return out + text.slice(at);
}

function validChanges(text: string, changes: TextChange[]): boolean {
    const sorted = [...changes].sort((a, b) => a.from - b.from);
    let at = 0;
    for (const c of sorted) {
        if (!Number.isInteger(c.from) || !Number.isInteger(c.to) || c.from < at || c.to < c.from || c.to > text.length) return false;
        at = c.to;
    }
    return true;
}

/** Serializes each vault file's read-modify-write, in call order. */
function queue() {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(work: () => Promise<T>): Promise<T> => {
        const run = tail.then(work, work);
        tail = run.catch(() => undefined);
        return run;
    };
}

export function createAgentHosts(getDeps: () => AgentHostDeps): AgentHost {
    const serializeIndex = queue();
    const serializeId = queue();

    const toolHost: VaultToolHost = {
        vaultToken: () => getDeps().root,

        getFileTree: () => getDeps().fileTree,

        async listDir(path) {
            const root = getDeps().root;
            if (!root) return null;
            const dir = await dirAt(root, path);
            if (!dir) return null;
            const out: VaultDirEntry[] = [];
            try {
                for await (const [name, handle] of dir.entries()) {
                    if (name === '.DS_Store' || name.endsWith('.crswap')) continue;
                    out.push({ name, kind: handle.kind });
                }
            } catch {
                return null;
            }
            return out.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'directory' ? -1 : 1) : a.name.localeCompare(b.name)));
        },

        async entryKind(path) {
            const root = getDeps().root;
            if (!root) return null;
            if (!path) return 'directory';
            if (await fileAt(root, path)) return 'file';
            return (await dirAt(root, path)) ? 'directory' : null;
        },

        openBuffer: path => liveText(getDeps(), path),

        async readText(path) {
            const deps = getDeps();
            const live = liveText(deps, path);
            if (live !== undefined) return live;
            if (!deps.root || isPdfFile(path)) return null;
            const found = await fileAt(deps.root, path);
            if (!found) return null;
            try { return await deps.readFile(found.handle); } catch { return null; }
        },

        async readBytes(path) {
            const deps = getDeps();
            if (!deps.root) return null;
            const found = await fileAt(deps.root, path);
            if (!found) return null;
            try { return await deps.readFileBytes(found.handle); } catch { return null; }
        },

        async applyTextChanges(path, expected, changes): Promise<HostResult> {
            const deps = getDeps();
            if (!deps.root) return { ok: false, reason: 'error', message: 'No vault is open.' };
            // A canvas is JSON on disk but a live tldraw store on screen, which
            // would re-serialize over any text edit at its next change.
            if (isCanvasFile(path) || isPdfFile(path)) {
                return { ok: false, reason: 'invalid', message: 'Drawings, notebooks and PDFs are changed with canvas_apply, not as text.' };
            }
            if (!validChanges(expected, changes)) return { ok: false, reason: 'invalid', message: 'Change ranges are out of bounds or overlap.' };
            const tab = openTabAt(deps, path);
            if (tab?.readError) return { ok: false, reason: 'error', message: 'This file could not be read by the editor; it cannot be changed until it is reopened.' };

            if (tab) {
                const view = getView(path);
                if (view?.applyTextChanges && view.getText) {
                    if (view.getText() !== expected) return { ok: false, reason: 'stale' };
                    // The pane's own update listener carries it into the save
                    // funnel, exactly like typing.
                    try {
                        return view.applyTextChanges(changes) ? { ok: true } : { ok: false, reason: 'error', message: 'The editor closed mid-edit.' };
                    } catch {
                        // CodeMirror's RangeError: ranges that no longer fit the text.
                        return { ok: false, reason: 'stale' };
                    }
                }
                if (tab.content !== expected) return { ok: false, reason: 'stale' };
                // Open but not on screen: the document's cached EditorState is what
                // its next pane adopts, text AND undo history — update it so the
                // agent's edit is one ⌘Z there too, and never leave it disagreeing
                // with the buffer (the next mount would show the old text).
                const next = applyToText(expected, changes);
                // The exact key (App's paneKey), not a `|path` suffix: a path may
                // itself contain `|`, and another document's state must not match.
                const key = `${tab.id}|${path}`;
                const cached = deps.stateCache.get(key);
                if (cached && cached.doc.toString() === expected) {
                    deps.stateCache.set(key, cached.update({ changes, userEvent: 'input.agent' }).state);
                }
                deps.updateTabContent(path, next);
                return { ok: true };
            }

            // Closed: straight to disk, then the same tail a save runs.
            const found = await fileAt(deps.root, path);
            if (!found) return { ok: false, reason: 'missing' };
            let current: string;
            try { current = await deps.readFile(found.handle); } catch { return { ok: false, reason: 'error', message: 'The file could not be read.' }; }
            if (current !== expected) return { ok: false, reason: 'stale' };
            const next = applyToText(expected, changes);
            try {
                await deps.writeFile(found.handle, next);
            } catch {
                return { ok: false, reason: 'error', message: 'The file could not be written.' };
            }
            deps.afterWrite({ name: found.name, path, kind: 'file', handle: found.handle, parentHandle: found.parentHandle }, expected, next);
            return { ok: true };
        },

        async createFile(path, content) {
            const deps = getDeps();
            if (!deps.root) return { ok: false, reason: 'error', message: 'No vault is open.' };
            const root = deps.root;
            const parent = await dirAt(root, parentVaultPath(path));
            if (!parent) return { ok: false, reason: 'no-parent' };
            const name = path.slice(path.lastIndexOf('/') + 1);
            // Refused rather than numbered: createFile opens-or-TRUNCATES, and an
            // agent that asked for "Ideas.md" and silently got "Ideas (1).md"
            // would go on editing the one it named.
            if (await nameTaken(parent, name)) return { ok: false, reason: 'taken' };
            try {
                const handle = await deps.createFile(parent, name);
                if (content) {
                    await deps.writeFile(handle, content);
                    deps.afterWrite({ name, path, kind: 'file', handle, parentHandle: parent }, '', content);
                }
                return { ok: true };
            } catch (err) {
                console.error('Agent could not create a file:', err);
                return { ok: false, reason: 'error', message: 'The file could not be created.' };
            }
        },

        async mkdir(path) {
            const deps = getDeps();
            if (!deps.root) return { ok: false, reason: 'error', message: 'No vault is open.' };
            const parent = await dirAt(deps.root, parentVaultPath(path));
            if (!parent) return { ok: false, reason: 'no-parent' };
            const name = path.slice(path.lastIndexOf('/') + 1);
            if (await nameTaken(parent, name)) return { ok: false, reason: 'taken' };
            try {
                await deps.createFolder(parent, name);
                return { ok: true };
            } catch (err) {
                console.error('Agent could not create a folder:', err);
                return { ok: false, reason: 'error', message: 'The folder could not be created.' };
            }
        },

        async move(from, to) {
            const deps = getDeps();
            if (!deps.root) return { ok: false, reason: 'error', message: 'No vault is open.' };
            if (from === to) return { ok: true };
            if (to.startsWith(`${from}/`)) return { ok: false, reason: 'invalid', message: 'A folder cannot be moved into itself.' };
            const node = findNode(deps.fileTree, from);
            if (!node) return { ok: false, reason: 'missing', message: 'Only files and folders shown in the file tree can be moved.' };
            const toParentPath = parentVaultPath(to);
            const toName = to.slice(to.lastIndexOf('/') + 1);
            const toParent = await dirAt(deps.root, toParentPath);
            if (!toParent) return { ok: false, reason: 'no-parent' };
            // By identity, not by spelling: moveFile copies a folder into the
            // target and then removes the source — with the target inside the
            // source, that removal takes the copy with it, bypassing .Garbage.
            if (node.kind === 'directory' && await node.handle.resolve(toParent) !== null) {
                return { ok: false, reason: 'invalid', message: 'A folder cannot be moved into itself.' };
            }
            // renameFile/moveFile deliberately OVERWRITE (a user dragging onto a
            // name means it). An agent's move never does: nothing it could be
            // told justifies destroying a file it did not name as the target.
            // The case-only rename of the entry itself is the one exception.
            const sameEntry = parentVaultPath(from) === toParentPath && from.toLowerCase() === to.toLowerCase();
            if (!sameEntry && await nameTaken(toParent, toName)) return { ok: false, reason: 'taken' };
            try {
                if (parentVaultPath(from) === toParentPath) {
                    return await deps.renameEntry(node, toName)
                        ? { ok: true }
                        : { ok: false, reason: 'error', message: 'The rename failed; nothing changed.' };
                }
                const moved = await deps.moveEntry(node, toParent, toParentPath);
                if (!moved) return { ok: false, reason: 'error', message: 'The move failed; nothing changed.' };
                if (toName !== node.name) {
                    const after = findNode(getDeps().fileTree, joinVaultPath(toParentPath, node.name));
                    if (!after) return { ok: false, reason: 'error', message: `Moved, but could not rename to "${toName}".` };
                    if (!await deps.renameEntry(after, toName)) {
                        return { ok: false, reason: 'error', message: `Moved into "${toParentPath || 'the vault root'}", but could not rename it to "${toName}".` };
                    }
                }
                return { ok: true };
            } catch (err) {
                console.error('Agent move failed:', err);
                return { ok: false, reason: 'error', message: 'The move failed.' };
            }
        },

        async trash(path) {
            const deps = getDeps();
            const node = findNode(deps.fileTree, path);
            if (!node) return { ok: false, reason: 'missing', message: 'Only files and folders shown in the file tree can be trashed.' };
            const result = await deps.trashEntry(node);
            if (result === 'ok') return { ok: true };
            return result === 'busy'
                ? { ok: false, reason: 'busy', message: 'Another deletion is still running; try again in a moment.' }
                : { ok: false, reason: 'error', message: 'Nothing was moved; something inside may be in use.' };
        },

        async openCanvasForAgent(path) {
            const deps = getDeps();
            const pdf = isPdfFile(path);
            if (!pdf && !isCanvasFile(path)) return null;
            const hasCanvas = (r: ViewReporter) => !!r.canvas;
            const now = getView(path);
            if (now?.canvas) return now;

            const tab = openTabAt(deps, path);
            if (!tab) {
                const node = findNode(deps.fileTree, path);
                if (!node || node.kind !== 'file') return null;
                if (!(await deps.addTabQuietly(node, pdf ? 'edit' : 'read'))) return null;
            } else if (tab.readError) {
                return null;
            } else if (pdf && tab.mode !== 'edit') {
                // A PDF is drawn on in annotate mode, which is its tab's 'edit'.
                deps.setTabMode(path, 'edit');
            }
            deps.showBeside(path);
            return whenViewReady(path, CANVAS_MOUNT_TIMEOUT_MS, hasCanvas);
        },
    };

    const readVaultAgentFile = async (root: FileSystemDirectoryHandle, name: string): Promise<string | null> => {
        try {
            const dir = await root.getDirectoryHandle(VAULT_AGENT_DIR);
            return await (await (await dir.getFileHandle(name)).getFile()).text();
        } catch {
            return null;
        }
    };

    /** One writable, replaced whole — never createFile (it truncates, then walks
     *  the whole vault to refresh a tree this hidden folder is not in). */
    const writeVaultAgentFile = async (root: FileSystemDirectoryHandle, name: string, text: string) => {
        const dir = await root.getDirectoryHandle(VAULT_AGENT_DIR, { create: true });
        await getDeps().writeFile(await dir.getFileHandle(name, { create: true }), text);
    };

    const readMirrorFile = async (dir: FileSystemDirectoryHandle, name: string): Promise<string | null> => {
        try {
            const file = await (await dir.getFileHandle(name)).getFile();
            if (file.size > MAX_MIRROR_FILE_BYTES) return null;
            const text = await file.text();
            // Text only: a NUL is as good a binary sniff as any here.
            return text.includes('\u0000') ? null : text.replace(/\r\n?/g, '\n');
        } catch {
            return null;
        }
    };

    return {
        toolHost,

        workspace(): AgentWorkspaceSnapshot | null {
            const deps = getDeps();
            if (!deps.root) return null;
            const tabs: AgentTabInfo[] = deps.tabs.map(t => ({
                path: t.file.path,
                name: t.file.name,
                kind: docKind(t),
                mode: t.mode,
                dirty: t.dirty,
                unreadable: !!t.readError,
            }));
            return {
                vaultName: deps.root.name,
                mainView: deps.mainView,
                layout: deps.layout,
                tabs,
                focusedPath: focusedPathOf(deps.layout),
                remembered: path => rememberedPosition(getDeps(), path),
            };
        },

        ensureVaultUuid() {
            const root = getDeps().root;
            if (!root) return Promise.resolve(null);
            // Serialized: StrictMode and a double send would otherwise both find
            // no file and mint two ids, the second orphaning the first's folder.
            return serializeId(async () => {
                const existing = parseVaultId(await readVaultAgentFile(root, VAULT_ID_FILE));
                if (existing) return existing;
                if (getDeps().root !== root) return null;
                const id = crypto.randomUUID();
                try {
                    await writeVaultAgentFile(root, VAULT_ID_FILE, serializeVaultId(id));
                    return id;
                } catch (err) {
                    console.error('Could not write the vault id:', err);
                    return null;
                }
            });
        },

        async readChatIndex(): Promise<ChatIndex> {
            const root = getDeps().root;
            if (!root) return emptyChatIndex();
            return parseChatIndex(await readVaultAgentFile(root, CHAT_INDEX_FILE));
        },

        updateChatIndex(update) {
            const root = getDeps().root;
            if (!root) return Promise.resolve(emptyChatIndex());
            // Re-read under the queue, so two windows on one vault merge per chat
            // (each update edits the chats it means to) rather than the later one
            // putting back the whole list it read at startup.
            return serializeIndex(async () => {
                const current = parseChatIndex(await readVaultAgentFile(root, CHAT_INDEX_FILE));
                const next = update(current);
                if (next === current) return current;
                // A write queued past a vault switch must not land in the next vault.
                if (getDeps().root !== root) return current;
                await writeVaultAgentFile(root, CHAT_INDEX_FILE, serializeChatIndex(next));
                return next;
            });
        },

        async collectMirrorFiles(): Promise<MirrorFile[]> {
            const root = getDeps().root;
            if (!root) return [];
            const out: MirrorFile[] = [];
            let total = 0;
            const add = (path: string, text: string | null) => {
                if (text === null || total + text.length > MAX_MIRROR_TOTAL_BYTES) return;
                total += text.length;
                out.push({ path, text });
            };
            for (const name of ['CLAUDE.md', 'AGENTS.md']) add(name, await readMirrorFile(root, name));
            const walk = async (dir: FileSystemDirectoryHandle, path: string, depth: number) => {
                if (depth > 8) return;
                try {
                    for await (const [name, handle] of dir.entries()) {
                        if (name === '.DS_Store' || name.endsWith('.crswap')) continue;
                        const child = `${path}/${name}`;
                        if (handle.kind === 'directory') await walk(handle, child, depth + 1);
                        else add(child, await readMirrorFile(dir, name));
                    }
                } catch { /* unreadable: mirror what was read */ }
            };
            for (const base of ['.claude/skills', '.agents/skills']) {
                const dir = await dirAt(root, base);
                if (dir) await walk(dir, base, 0);
            }
            return out;
        },

        ask: request => getDeps().ask(request),

        notify: message => getDeps().notify(message),

        openFile: path => getDeps().openFile(path),
    };
}

