// The editor-side contracts of the AI agent panel ("VaultAgent"):
//
//   App ──AgentHost──▶ AgentPanel ──▶ agentBridge (WebSocket to the helper)
//                                          │ tool.call
//                                          ▼
//                     vaultAgentTools.executeTool(name, args, VaultToolHost)
//
// Both hosts are built ONCE (utils/agentHost.ts, from App's live state, in the
// panel's lazy chunk), as objects stable for the app's life (their
// methods read refs), so nothing downstream re-renders or re-subscribes when
// App's state changes. The wire protocol with the helper is
// shared/vaultAgentProtocol.ts; what each pane reports is utils/viewRegistry.ts.

import type { AgentId, MirrorFile } from '../../shared/vaultAgentProtocol';
import type { EditorMode, FileTreeNode, TabLayout, Theme } from './index';
import type { TextChange, ViewReporter } from '../utils/viewRegistry';
import type { AgentHostDeps } from '../utils/agentHost';

/* ───────────────────────── the vault's chat index (.VaultAgent/chats.json) ───────────────────────── */

/** One chat started from the panel. Only this index lives in the vault; the
 *  conversation itself is the CLI's own session, in its own store. */
export interface ChatMeta {
    /** Ours (random UUID), stable for the chat's life — the React key. */
    id: string;
    agent: AgentId;
    /** The CLI's session/thread id; null until the first run reports one. */
    sessionId: string | null;
    title: string;
    /** The model/effort for the NEXT message (per chat). null = CLI default. */
    model: string | null;
    effort: string | null;
    createdAt: number;
    updatedAt: number;
    /** SHA-256 of the last canvas/PDF image sent, so an unchanged view is not
     *  re-sent — even after a reload. */
    lastImageHash?: string | null;
}

export interface ChatIndex {
    version: 1;
    chats: ChatMeta[];
    /** Unknown keys a newer build wrote, carried through untouched. */
    [key: string]: unknown;
}

/* ───────────────────────── what App tells the context builder ───────────────────────── */

export type AgentDocKind = 'markdown' | 'text' | 'pdf' | 'drawing' | 'notebook' | 'image' | 'help' | 'other';

export interface AgentTabInfo {
    path: string;
    name: string;
    kind: AgentDocKind;
    mode: EditorMode;
    dirty: boolean;
    /** The tab could not be read (OpenTab.readError) — its content is not the file's. */
    unreadable: boolean;
}

/** Where a tab with NO mounted view was left — from the same localStorage records
 *  its pane restores from. Pages are 1-based. */
export type RememberedPosition =
    | { kind: 'markdown'; line: number }
    | { kind: 'pdf'; page: number; offset: number; zoom: number | null }
    | { kind: 'drawing'; x: number; y: number; z: number }
    | { kind: 'notebook'; page: number; offset: number; zoom: number | null };

export interface AgentWorkspaceSnapshot {
    vaultName: string;
    /** What the editor's main area shows; 'graph' means no document is mounted. */
    mainView: 'editor' | 'graph';
    layout: TabLayout;
    tabs: AgentTabInfo[];
    /** Focused pane's active tab, or null. */
    focusedPath: string | null;
    /** Stored position for a tab that is not on screen. */
    remembered(path: string): RememberedPosition | null;
}

/* ───────────────────────── VaultToolHost — the agent's hands, implemented by App ───────────────────────── */

export interface VaultDirEntry {
    name: string;
    kind: 'file' | 'directory';
}

export type HostFailure = 'taken' | 'missing' | 'no-parent' | 'invalid' | 'stale' | 'busy' | 'error';
export type HostResult = { ok: true } | { ok: false; reason: HostFailure; message?: string };

/**
 * Every path is vault-relative and ALREADY normalized and validated by the
 * executor (vaultAgentTools.normalizeAgentPath): no leading '/', no '.', '..',
 * '\\', NUL or empty segment. The host may assume it.
 */
export interface VaultToolHost {
    /** Identity of the open vault — a new object on every switch, null with none.
     *  The executor captures it when a run starts and refuses once it changes. */
    vaultToken(): object | null;
    /** The file tree as the sidebar has it (root hidden folders excluded). */
    getFileTree(): FileTreeNode[];
    /** Direct children of a vault folder, straight from disk, hidden ones
     *  included (`.claude`, `.Assets`, …). '' = root. null = no such folder. */
    listDir(path: string): Promise<VaultDirEntry[] | null>;
    entryKind(path: string): Promise<'file' | 'directory' | null>;
    /** An open tab's live text (unsaved edits included), or undefined when the
     *  path has no readable open tab. Synchronous: search overlays it. */
    openBuffer(path: string): string | undefined;
    /** The open tab's live text, else the file on disk (CRLF normalized). null =
     *  missing, a folder, or unreadable. */
    readText(path: string): Promise<string | null>;
    readBytes(path: string): Promise<Uint8Array | null>;
    /**
     * Apply `changes` (offsets into `expected`) to a text file. Refused as
     * 'stale' unless the current text (readText) still equals `expected`. Lands
     * in the live editor when the file is on screen (one undoable transaction),
     * else in the tab's cached EditorState, else on disk through the normal save
     * tail. Works in reading mode too (a tool, not a keystroke).
     */
    applyTextChanges(path: string, expected: string, changes: TextChange[]): Promise<HostResult>;
    /** Create a NEW file; 'taken' if a file OR folder has the name; never truncates. */
    createFile(path: string, content: string): Promise<HostResult>;
    mkdir(path: string): Promise<HostResult>;
    /** Rename/move (tabs follow). 'taken' if the target name is used. */
    move(from: string, to: string): Promise<HostResult>;
    /** Move to the folder's `.Garbage`, without the confirm dialog. */
    trash(path: string): Promise<HostResult>;
    /** The reporter (with `canvas`) of a drawing / notebook / PDF. Opens it
     *  beside the user's focused pane without taking focus when it is not on
     *  screen, switches a PDF to annotate, and waits for it to mount. */
    openCanvasForAgent(path: string): Promise<ViewReporter | null>;
}

/* ───────────────────────── change cards ───────────────────────── */

export interface DiffLine {
    type: 'context' | 'add' | 'del' | 'gap';
    text: string;
    oldLine?: number;
    newLine?: number;
}

/** What a mutating tool call did, for the panel's change card. */
export type AgentChange =
    | { kind: 'edit'; path: string; added: number; removed: number; diff: DiffLine[] }
    | { kind: 'create'; path: string; folder: boolean; diff: DiffLine[] }
    | { kind: 'move'; from: string; to: string }
    | { kind: 'trash'; path: string }
    | { kind: 'canvas'; path: string; created: number; updated: number; deleted: number; summary: string };

/* ───────────────────────── AgentHost — what App hands the panel ───────────────────────── */

export interface ConfirmRequest {
    title: string;
    body: string;
    confirmLabel: string;
    danger?: boolean;
}

/** Stable for the app's life; every method reads the CURRENT vault. */
export interface AgentHost {
    toolHost: VaultToolHost;
    /** The workspace right now, or null with no vault open. */
    workspace(): AgentWorkspaceSnapshot | null;
    /** The vault's permanent agent id (`.VaultAgent/vault.json`), created on
     *  first call. null with no vault, or if it could not be written. */
    ensureVaultUuid(): Promise<string | null>;
    readChatIndex(): Promise<ChatIndex>;
    /** Serialized read-modify-write: re-reads the file, applies `update`, writes. */
    updateChatIndex(update: (index: ChatIndex) => ChatIndex): Promise<ChatIndex>;
    /** The vault's CLAUDE.md, AGENTS.md, .claude/skills/**, .agents/skills/**. */
    collectMirrorFiles(): Promise<MirrorFile[]>;
    /** The app's own confirm dialog (never a native one). */
    ask(request: ConfirmRequest): Promise<boolean>;
    /** The app's own one-button notice (App.notify) — a refused clipboard. */
    notify(message: string): void;
    /** Open/focus a vault file in the editor (change cards' "Open"). */
    openFile(path: string): void;
}

export interface AgentPanelProps {
    /** The open vault, or null. `key` is the browser's vault id; changes on a switch. */
    vault: { key: string; name: string } | null;
    theme: Theme;
    /** App's live state for the hosts, read at call time. Stable for the app's
     *  life; the panel chunk builds the hosts from it (utils/agentHost.ts is
     *  kept out of the main bundle that way). */
    getHostDeps: () => AgentHostDeps;
    /** The reader opened the panel (vs. it being restored open with the
     *  page): read at mount, to hand the keyboard to the composer. */
    takeFocus: boolean;
    onClose: () => void;
}
