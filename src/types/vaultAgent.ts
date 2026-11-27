import type { AgentId, CanvasOp, MirrorFile } from '../../shared/vaultAgentProtocol';
import type { ChatTree } from '../utils/chatTree';
import type { EditorMode, FileTreeNode, TabLayout, Theme } from './index';
import type { CanvasApplyResult, CanvasShapePage, CanvasShapeQuery, DrawingViewInfo, NotebookViewInfo, PdfViewInfo, TextChange, ViewReporter } from '../utils/viewRegistry';
import type { AgentHostDeps } from '../utils/agentHost';
import type { NativeClosedCanvasPicture, NativePdfPicture } from '../utils/nativeCanvasAgentRead';

export interface ChatMeta {
    id: string;
    agent: AgentId;
    sessionId: string | null;
    title: string;
    model: string | null;
    effort: string | null;
    createdAt: number;
    updatedAt: number;
    lastImageHash?: string | null;
}

export interface ChatIndex {
    version: 1;
    chats: ChatMeta[];
    [key: string]: unknown;
}

export type AgentDocKind = 'epub' | 'markdown' | 'text' | 'pdf' | 'drawing' | 'notebook' | 'image' | 'help' | 'other';

export interface AgentTabInfo {
    path: string;
    name: string;
    kind: AgentDocKind;
    mode: EditorMode;
    dirty: boolean;
    unreadable: boolean;
}

export type RememberedPosition =
    | { kind: 'epub'; locator: import('./reading').EpubLocator; flow: import('./reading').ReaderFlow }
    | { kind: 'markdown'; line: number }
    | { kind: 'pdf'; page: number; offset: number; zoom: number | null }
    | { kind: 'drawing'; x: number; y: number; z: number }
    | { kind: 'notebook'; page: number; offset: number; zoom: number | null };

export interface AgentWorkspaceSnapshot {
    vaultName: string;
    mainView: 'editor' | 'graph';
    layout: TabLayout;
    tabs: AgentTabInfo[];
    focusedPath: string | null;
    remembered(path: string): RememberedPosition | null;
    nativeView?(path: string, signal: AbortSignal): Promise<NativeCanvasView | null>;
}

export interface VaultDirEntry {
    name: string;
    kind: 'file' | 'directory';
}

export type HostFailure = 'taken' | 'missing' | 'no-parent' | 'invalid' | 'stale' | 'busy' | 'error';
export type HostResult = { ok: true } | { ok: false; reason: HostFailure; message?: string };

export interface ClosedPdfAgentPage { page: number; text: string; quality?: 'partial'; warnings?: readonly string[] }
export type ClosedPdfEmphasis = { kind: 'active' | 'inactive' | 'unavailable' | 'unknown'; reason?: string };
export interface ClosedPdfAgentAccess {
    read(path: string, bytes: Uint8Array, first: number, maxPages: number, maxChars: number,
        signal: AbortSignal): Promise<{ pageCount: number; pages: ClosedPdfAgentPage[] }>;
    render(path: string, bytes: Uint8Array, page: number, maxSide: number,
        signal: AbortSignal): Promise<{ pageCount: number; png: Blob | null; emphasis?: ClosedPdfEmphasis }>;
}

export interface NativeCanvasView {
    readonly info: DrawingViewInfo | NotebookViewInfo | PdfViewInfo;
    readonly wholeSheet: boolean;
    capture(maxSide: number, signal?: AbortSignal, page?: number, region?: AgentRegion): Promise<Blob>;
}

export interface AgentRegion { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export interface VaultToolHost {
    /** Identity of the open vault — a new object on every switch, null with none.
     *  The executor captures it when a run starts and refuses once it changes. */
    vaultToken(): object | null;
    searchAgent(config: { query: string; regex: boolean; caseSensitive: boolean; scope: string; maxResults: number }, signal?: AbortSignal): Promise<import('../utils/agentMatcher/types').MatchAnswer>;
    getFileTree(): FileTreeNode[];
    listDir(path: string): Promise<VaultDirEntry[] | null>;
    entryKind(path: string): Promise<'file' | 'directory' | null>;
    openBuffer(path: string): string | undefined;
    readText(path: string): Promise<string | null>;
    readBytes(path: string): Promise<Uint8Array | null>;
    closedPdfAgent?(): ClosedPdfAgentAccess | null;
    canvasShapePage?(path: string, query: CanvasShapeQuery,
        guard: { readonly signal?: AbortSignal; isCurrent(): boolean }): Promise<CanvasShapePage | null>;
    canvasApplyNative?(path: string, ops: CanvasOp[],
        guard: { readonly signal?: AbortSignal; isCurrent(): boolean }): Promise<CanvasApplyResult | null>;
    nativeCanvasView?(path: string, guard: { readonly signal?: AbortSignal; isCurrent(): boolean }): Promise<NativeCanvasView | null>;
    nativePdfPicture?(path: string, maxSide: number, guard: { readonly signal?: AbortSignal; isCurrent(): boolean }): Promise<NativePdfPicture | null>;
    nativeClosedPicture?(path: string, page: number | undefined, maxSide: number,
        guard: { readonly signal?: AbortSignal; isCurrent(): boolean }): Promise<NativeClosedCanvasPicture | null>;
    applyTextChanges(path: string, expected: string, changes: TextChange[]): Promise<HostResult>;
    /** Create a NEW file; 'taken' if a file OR folder has the name; never truncates. */
    createFile(path: string, content: string): Promise<HostResult>;
    mkdir(path: string): Promise<HostResult>;
    move(from: string, to: string): Promise<HostResult>;
    trash(path: string): Promise<HostResult>;
    openCanvasForAgent(path: string): Promise<ViewReporter | null>;
    canvasWritable(path: string): boolean;
}

export interface DiffLine {
    type: 'context' | 'add' | 'del' | 'gap';
    text: string;
    oldLine?: number;
    newLine?: number;
}

export type AgentChange =
    | { kind: 'edit'; path: string; added: number; removed: number; diff: DiffLine[] }
    | { kind: 'create'; path: string; folder: boolean; diff: DiffLine[] }
    | { kind: 'move'; from: string; to: string }
    | { kind: 'trash'; path: string }
    | { kind: 'canvas'; path: string; created: number; updated: number; deleted: number; summary: string };

export interface ConfirmRequest {
    title: string;
    body: string;
    confirmLabel: string;
    danger?: boolean;
}

export interface AgentHost {
    toolHost: VaultToolHost;
    workspace(): AgentWorkspaceSnapshot | null;
    ensureVaultUuid(): Promise<string | null>;
    readChatIndex(): Promise<ChatIndex>;
    readChatTree(chatId: string): Promise<ChatTree>;
    writeChatTree(chatId: string, tree: ChatTree): Promise<void>;
    deleteChatTree(chatId: string): Promise<void>;
    updateChatIndex(update: (index: ChatIndex) => ChatIndex): Promise<ChatIndex>;
    collectMirrorFiles(): Promise<MirrorFile[]>;
    ask(request: ConfirmRequest): Promise<boolean>;
    notify(message: string): void;
    openFile(path: string): void;
}

export interface AgentPanelProps {
    vault: { key: string; name: string } | null;
    theme: Theme;
    getHostDeps: () => AgentHostDeps;
    takeFocus: boolean;
    onClose: () => void;
}
