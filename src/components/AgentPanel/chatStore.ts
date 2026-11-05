// The agent panel's state and every action on it, as ONE module-level store.
//
// Not React state, for the reason agentBridge is not: the panel is a lazy
// React tree that App mounts and unmounts as the user toggles it, and a run in
// flight must outlive that — it keeps streaming, and above all keeps answering
// the agent's `tool.call`s (an unanswered call hangs the CLI until the helper's
// 90 s timeout). The store holds the run; the panel is a view onto it.
//
// It is also what makes StrictMode's double effects harmless here: `attach`
// is idempotent, index loads are keyed by vault, and the one run is a field,
// not something an effect starts.

import { agentBridge, BridgeError, helperReady, isTerminalEvent } from '../../utils/agentBridge';
import type { HelperEvent, HelperInfo } from '../../utils/agentBridge';
import { executeTool } from '../../utils/vaultAgentTools';
import { buildAgentContext, stripAgentContext } from '../../utils/agentContext';
import { getReplyModePref, resolveReplyMode } from '../../utils/agentReplyMode';
import { AGENT_IDS, AGENT_LABELS, MAX_IMAGES_PER_MESSAGE } from '../../../shared/vaultAgentProtocol';
import type {
    AgentEvent, AgentId, AgentStatus, HistoryItem, ModelInfo, RunErrorReason, RunImage, ToolResult,
} from '../../../shared/vaultAgentProtocol';
import type { AgentChange, AgentHost, ChatIndex, ChatMeta } from '../../types/vaultAgent';
import {
    activePath, activeSessionId, append as appendNode, branchFrom, emptyTree, isEmpty,
    parseTree, selectVersion as selectVersionIn, serializeTree,
    type ChatNode, type ChatTree, type StoredSegment, type StoredTool,
} from '../../utils/chatTree';
import { readJSON, writeJSON } from '../../utils/storage';

/* ───────────────────────── shapes ───────────────────────── */

/** An image the user attached, already re-encoded (see imagePrep.ts). */
export interface PreparedImage {
    id: string;
    mimeType: RunImage['mimeType'];
    /** base64, no data: prefix. */
    data: string;
    /** Object URL for the thumbnail. */
    url: string;
    name: string;
    bytes: number;
}

export type ChatItem =
    | { kind: 'user'; id: string; text: string; thumbs: string[]; imageCount: number; context: string | null }
    | {
        kind: 'assistant'; id: string; text: string; streaming: boolean;
        /** The model id the turn ran with, when known (see ChatNode.model):
         *  what the reply's action row names. Absent for chats restored from
         *  the CLI and for turns saved before this was recorded. */
        model?: string;
    }
    | {
        kind: 'reasoning'; id: string; text: string; streaming: boolean;
        /** Epoch ms. Saved in the tree with the turn (StoredSegment), so
         *  "Thought for Ns" survives the next message and a reload; null only
         *  for turns read from the CLI or saved before segments existed — the
         *  "Thought" with no duration. reasoningDurationMs() reads them. */
        startedAt: number | null; endedAt: number | null;
    }
    | {
        kind: 'tool'; id: string; callId: string; name: string; input: unknown;
        status: 'running' | 'done' | 'error'; output?: string;
        /** One of OUR vault_/canvas_ tools (a `tool.call`), vs the agent's own
         *  (web search, fetch, a skill) reported as a `tool` event. */
        own: boolean;
        change?: AgentChange;
    }
    | { kind: 'notice'; id: string; tone: 'info' | 'warning' | 'error'; message: string };

export interface Conversation {
    /** What the panel draws: the active branch, plus whatever is streaming. */
    items: ChatItem[];
    /**
     * The durable transcript, WITH its branches (utils/chatTree.ts).
     *
     * The app owns this now. A CLI session is a line, so a conversation that
     * forks cannot be read back out of one — `session.history` survives as the
     * fallback for chats made before this, and as a repair when a tree file is
     * lost.
     */
    tree: ChatTree;
    /** Where the transcript came from: this session, or the CLI's own store. */
    history: 'none' | 'loading' | 'loaded' | 'missing' | 'error';
    historyError?: string;
}

export interface RunInfo {
    runId: string;
    chatId: string;
    phase: 'preparing' | 'running' | 'stopping';
    startedAt: number;
    /** The model id this run asked for (a retry's override included), or the
     *  CLI default's id; null when neither is known yet. */
    model?: string | null;
}

export interface ModelsEntry {
    status: 'loading' | 'ready' | 'error';
    models: ModelInfo[];
    error?: string;
}

export interface ChatConfig {
    agent: AgentId;
    model: string | null;
    effort: string | null;
}

export interface ChatStoreState {
    vaultKey: string | null;
    indexStatus: 'idle' | 'loading' | 'ready' | 'error';
    indexError?: string;
    /** This vault's chats, most recent first. */
    chats: ChatMeta[];
    /** null = a new chat not yet sent (the draft). */
    activeChatId: string | null;
    draft: ChatConfig;
    conversations: Record<string, Conversation>;
    run: RunInfo | null;
    agentsStatus: 'idle' | 'loading' | 'ready' | 'error';
    agents: AgentStatus[];
    models: Partial<Record<AgentId, ModelsEntry>>;
    /**
     * Chats with a lesson under way (conversation keys, the draft included).
     *
     * In memory only: "yes", "no idea" and "why?" carry no learning cues of
     * their own, so `auto` has to remember that the last message was taught —
     * but a reload starting the chat neutral is the right failure, since the
     * next real question re-decides it anyway. The panel reads it to light the
     * cap while `auto` is the pinned mode.
     */
    teaching: Record<string, boolean>;
}

/** The draft's conversation key (a chat id is a UUID, so no clash). */
export const DRAFT_KEY = 'draft';

const EMPTY_CONVERSATION: Conversation = { items: [], tree: emptyTree(), history: 'none' };

/* ───────────────────────── remembered choices (localStorage) ───────────────────────── */

/** The last agent, and each agent's last model/effort — the defaults for a new chat. */
const CHOICE_KEY = 'vaultAgentChoice';

interface StoredChoice {
    agent: AgentId;
    perAgent: Partial<Record<AgentId, { model: string | null; effort: string | null }>>;
}

function readChoice(): StoredChoice {
    const fallback: StoredChoice = { agent: 'claude', perAgent: {} };
    try {
        const raw = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? 'null') as Partial<StoredChoice> | null;
        // Shape-guarded: localStorage is user-editable.
        if (!raw || typeof raw !== 'object') return fallback;
        const agent = AGENT_IDS.includes(raw.agent as AgentId) ? raw.agent as AgentId : 'claude';
        const perAgent: StoredChoice['perAgent'] = {};
        for (const id of AGENT_IDS) {
            const entry = raw.perAgent?.[id];
            if (entry && typeof entry === 'object') {
                perAgent[id] = {
                    model: typeof entry.model === 'string' ? entry.model : null,
                    effort: typeof entry.effort === 'string' ? entry.effort : null,
                };
            }
        }
        return { agent, perAgent };
    } catch {
        return fallback;
    }
}

function writeChoice(config: ChatConfig): void {
    const current = readChoice();
    current.agent = config.agent;
    current.perAgent[config.agent] = { model: config.model, effort: config.effort };
    try { localStorage.setItem(CHOICE_KEY, JSON.stringify(current)); } catch { /* not remembered */ }
}

/**
 * The chat each vault had open, by vault key — reopened when the panel next
 * attaches to that vault (a reload with the panel open lands back in it).
 *
 * Keyed by the vault key `attach` is handed, which is the app's stored-vault id
 * (App's `agentVault`) — the same id `scopedKey` scopes by. Not `scopedKey()`
 * itself: it reads a scope App sets in a PASSIVE effect of its own, and the
 * panel's attach effect is a child's, so it runs first — on a vault switch
 * scopedKey still names the vault being left, and the new vault would read
 * the old one's chat. One small entry per vault, never pruned, like the other
 * per-vault records.
 *
 * Read fresh on every use, not through storage.ts's readRecord cache: two
 * windows on two vaults each write this record, and a cached copy flushed
 * whole would put back the other window's stale entry (or drop its new one).
 */
const OPEN_CHAT_KEY = 'vaultAgentOpenChat';

/** A localStorage map, shape-checked (it is user-editable). */
function readMap(key: string): Record<string, unknown> {
    const raw = readJSON<unknown>(key, {});
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function rememberedChat(vaultKey: string): string | null {
    const id = readMap(OPEN_CHAT_KEY)[vaultKey];
    return typeof id === 'string' ? id : null;
}

function rememberChat(vaultKey: string, chatId: string | null): void {
    const map = readMap(OPEN_CHAT_KEY);
    if ((map[vaultKey] ?? null) === chatId) return;
    if (chatId) map[vaultKey] = chatId; else delete map[vaultKey];
    writeJSON(OPEN_CHAT_KEY, map);
}

/**
 * Turns cut off by a reload, by `<vault key>\0<chat id>` → `{ parent, node }`:
 * the assistant node a stop would have committed under its question.
 *
 * WHY. The pagehide handler does commit and write the turn, but that write is
 * six async File System Access round trips, and the page is gone first
 * (measured: a reload mid-reply left only the question in
 * the file, every time). localStorage is synchronous, so the same node is
 * kept here as well and folded into the tree file when the chat is next
 * loaded (adoptCutOffTurn). Removed once read, whatever happens to it.
 */
const CUT_OFF_KEY = 'vaultAgentCutOffTurns';

function cutOffKey(vaultKey: string, chatId: string): string {
    // U+0000, as scopedKey separates: neither half can contain one.
    return `${vaultKey}\u0000${chatId}`;
}

function draftFor(agent: AgentId): ChatConfig {
    const remembered = readChoice().perAgent[agent];
    return { agent, model: remembered?.model ?? null, effort: remembered?.effort ?? null };
}

/* ───────────────────────── helpers ───────────────────────── */

function uid(): string {
    return crypto.randomUUID();
}

async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function titleFrom(text: string, imageCount: number): string {
    const line = text.replace(/\s+/g, ' ').trim();
    if (line) return line.length > 80 ? `${line.slice(0, 79)}…` : line;
    return imageCount ? 'Image' : 'New chat';
}

function byRecent(a: ChatMeta, b: ChatMeta): number {
    return b.updatedAt - a.updatedAt;
}

function withStar(chat: ChatMeta, on: boolean): ChatMeta {
    if (on) return { ...chat, starred: true };
    const { starred: _Dropped, ...rest } = chat;
    return rest;
}

/** How much image data (base64 characters, summed) sentImages keeps for
 *  Retry. A bound, not a guess at usage: one image may be MAX_IMAGE_BYTES
 *  (10 MB, ~13.4M characters), and the newest message's pictures are always
 *  kept whatever their size; smaller screenshots leave room for several. */
const IMAGE_MEMORY_CHARS = 24 * 1024 * 1024;

/** The user's words and, IN DEVELOPMENT ONLY, the context block that preceded
 *  them: a stored message carries both, and the block is always stripped for
 *  display — it is only kept, and only in dev, for the "Context sent" fold. */
function splitContext(text: string): { words: string; context: string | null } {
    const words = stripAgentContext(text);
    if (words === text || !import.meta.env.DEV) return { words, context: null };
    const context = text.endsWith(words) ? text.slice(0, text.length - words.length).trim() : null;
    return { words, context: context || null };
}

const OUTPUT_PREVIEW_CHARS = 4000;

function resultText(result: ToolResult): string {
    const text = result.content
        .map(part => part.type === 'text' ? part.text : `[image ${part.mimeType}]`)
        .join('\n');
    return text.length > OUTPUT_PREVIEW_CHARS ? `${text.slice(0, OUTPUT_PREVIEW_CHARS)}\n… (${text.length - OUTPUT_PREVIEW_CHARS} more characters)` : text;
}

/** What each run error means to the user. */
function runErrorMessage(reason: RunErrorReason, message: string, agent: AgentId): string {
    const name = AGENT_LABELS[agent];
    switch (reason) {
        case 'busy': return 'VaultAgent is already running a message. Wait for it to finish, or press Stop.';
        case 'agent-missing': return `${name} isn't installed on this computer.`;
        case 'logged-out': return `You're not logged in to ${name}. Log in from a terminal, then try again.`;
        case 'agent-changed': return message || `${name} answered in a way VaultAgent doesn't understand.`;
        case 'cancelled': return 'Stopped.';
        case 'bad-request': return message || 'VaultAgent refused the message.';
        default: return message || `${name} stopped unexpectedly.`;
    }
}

/** A model to judge a config by: the chosen one, else the CLI's default. */
export function resolveModel(models: ModelInfo[] | undefined, id: string | null): ModelInfo | null {
    if (!models?.length) return null;
    return (id && models.find(m => m.id === id)) || models.find(m => m.isDefault) || null;
}

/** The active chat, or null for the draft. */
export function activeChatOf(state: ChatStoreState): ChatMeta | null {
    const id = state.activeChatId;
    return id ? state.chats.find(c => c.id === id) ?? null : null;
}

/** The agent/model/effort the NEXT message in `state`'s active chat goes with. */
export function configOf(state: ChatStoreState): ChatConfig {
    const chat = activeChatOf(state);
    return chat ? { agent: chat.agent, model: chat.model, effort: chat.effort } : state.draft;
}

/* ───────────────────────── the store ───────────────────────── */

/** Only a helper the chat may use counts: an outdated one is connected just
 *  to be updated or uninstalled, and is never asked for agents or history. */
function readyHelper(): HelperInfo | null {
    const state = agentBridge.getState();
    return helperReady(state) ? state.helper : null;
}

/** Exported for the tests, which drive a fresh one against a fake host; the
 *  app has exactly one, `chatStore` below. */
export class ChatStore {
    private state: ChatStoreState = {
        vaultKey: null,
        indexStatus: 'idle',
        chats: [],
        activeChatId: null,
        draft: draftFor(readChoice().agent),
        conversations: {},
        run: null,
        agentsStatus: 'idle',
        agents: [],
        models: {},
        teaching: {},
    };
    private readonly listeners = new Set<() => void>();
    private notifyFrame = 0;
    private host: AgentHost | null = null;
    /** The user message the live run answers: where its reply is committed in
     *  the tree when it finishes — and `vault`, the token of the vault the run
     *  started in, which is where that chat's file is written even if another
     *  vault has been opened since (see abandonRun). */
    private runUserNode: { key: string; nodeId: string; model: string | null; vault: object | null } | null = null;
    /** The CLI session the live run reported (its `session` event), so a turn
     *  cut off before `run.done` still records which session it ran in. */
    private runSessionId: string | null = null;
    /** The vault whose remembered open chat is reopened once its index loads
     *  (set by attach, consumed by loadIndex). */
    private restoreFor: string | null = null;
    /**
     * The pictures each recent message was sent with, by user node id, so a
     * Retry re-sends them. In memory only and capped (IMAGE_MEMORY_CHARS,
     * oldest dropped first): the tree records only a count, since an image's
     * base64 is far too big to rewrite into the chat file on every save. A
     * retry of a message whose pictures are no longer here goes as text only.
     */
    private readonly sentImages = new Map<string, PreparedImage[]>();
    /** Captured when the current run started (host.toolHost.vaultToken()). */
    private runVaultToken: object | null = null;
    private runImageHash: string | null = null;
    /** Tool calls run one at a time, in arrival order. OpenCode and Codex issue
     *  calls in parallel, and two edits racing through the stale check both
     *  passed it: the second overwrote the first (and a hidden tab's cached
     *  EditorState and buffer fell out of step); two creates of one name both
     *  passed nameTaken and the second truncated the first. */
    private toolQueue: Promise<void> = Promise.resolve();
    /** The vault the chat index on screen belongs to (host.toolHost.vaultToken()
     *  at attach). A run's end must not write its chat into another vault's
     *  index when the vault was switched with the panel closed. */
    private indexVaultToken: object | null = null;
    private releaseRun: (() => void) | null = null;
    /** Mirror payload hash per vault uuid, for this connection. */
    private readonly mirrorHashes = new Map<string, string>();
    private indexLoadSeq = 0;
    /** The chat-ready helper last seen. An object per connection, so a new
     *  one is told apart from the same one re-announced with a fresh update
     *  status. */
    private lastHelper: HelperInfo | null = null;

    constructor() {
        const offEvents = agentBridge.subscribe(event => this.onHelperEvent(event));
        const offState = agentBridge.subscribeState(() => this.onBridgeState());
        // This module loads with the panel, but the page-load update check can
        // have connected the bridge first: a helper already there is announced
        // now, or its agents are never asked for (measured: "Checking agents…"
        // for good when the panel opened inside the check's grace).
        this.onBridgeState();
        // globalThis, not window: the tests import this module (and build the
        // app's store below) before they stand a window in.
        globalThis.addEventListener('pagehide', this.onPageHide);
        // Dev only: a hot update re-runs this module and builds a second
        // store. Both listening would answer every tool.call TWICE — a
        // doubled edit in the user's note — so the old one lets go first.
        import.meta.hot?.dispose(() => { offEvents(); offState(); globalThis.removeEventListener('pagehide', this.onPageHide); });
    }

    /* ── store plumbing ── */

    getState = (): ChatStoreState => this.state;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    /** Coalesced to one notification per frame: text deltas arrive every few
     *  characters, and each notification re-renders the message list. */
    private set(patch: Partial<ChatStoreState>): void {
        this.state = { ...this.state, ...patch };
        if (this.notifyFrame) return;
        const fire = () => {
            this.notifyFrame = 0;
            for (const listener of this.listeners) listener();
        };
        // A hidden tab runs no frames; a run there still has to show when the
        // user comes back, and a timer keeps the store's clock moving.
        this.notifyFrame = document.hidden ? window.setTimeout(fire, 50) : requestAnimationFrame(fire);
    }

    private conversation(key: string): Conversation {
        return this.state.conversations[key] ?? EMPTY_CONVERSATION;
    }

    private setConversation(key: string, next: Conversation): void {
        this.set({ conversations: { ...this.state.conversations, [key]: next } });
    }

    private updateItems(key: string, update: (items: ChatItem[]) => ChatItem[]): void {
        const conversation = this.conversation(key);
        this.setConversation(key, { ...conversation, items: update(conversation.items) });
    }

    private pushItem(key: string, item: ChatItem): void {
        this.updateItems(key, items => [...items, item]);
    }

    private notice(key: string, tone: 'info' | 'warning' | 'error', message: string): void {
        this.pushItem(key, { kind: 'notice', id: uid(), tone, message });
    }

    /* ── the vault and the host ── */

    /**
     * Called by the panel on every render that may have changed them. A vault
     * switch cancels a run (its tools would act on the wrong vault; the
     * executor also refuses by token) and starts the index over — then reopens
     * the chat this vault last had open, once its index says it still exists.
     */
    attach(host: AgentHost, vault: { key: string; name: string } | null): void {
        this.host = host;
        const key = vault?.key ?? null;
        if (key === this.state.vaultKey) return;
        // Ended like a stop — what streamed, then "Stopped." — and saved into
        // the chat file of the vault the run STARTED in, before its
        // conversation is dropped below (abandonRun says why that is safe).
        if (this.state.run) this.abandonRun('Stopped.', 'info');
        this.indexVaultToken = host.toolHost.vaultToken();
        this.sentImages.clear();
        this.restoreFor = key;
        this.set({
            vaultKey: key,
            chats: [],
            activeChatId: null,
            conversations: {},
            indexStatus: 'idle',
            indexError: undefined,
        });
        if (key) void this.loadIndex();
    }

    async loadIndex(): Promise<void> {
        const host = this.host;
        if (!host || !this.state.vaultKey) return;
        const seq = ++this.indexLoadSeq;
        const vaultKey = this.state.vaultKey;
        this.set({ indexStatus: 'loading' });
        try {
            const index = await host.readChatIndex();
            if (seq !== this.indexLoadSeq || vaultKey !== this.state.vaultKey) return;
            this.set({ chats: [...index.chats].sort(byRecent), indexStatus: 'ready', indexError: undefined });
            if (this.restoreFor === vaultKey) {
                this.restoreFor = null;
                this.restoreOpenChat(vaultKey);
            }
        } catch (e) {
            if (seq !== this.indexLoadSeq) return;
            this.set({ indexStatus: 'error', indexError: e instanceof Error ? e.message : String(e) });
        }
    }

    /**
     * Reopen the chat `vaultKey` last had open, if the index still lists it. A
     * chat deleted since (here or in another window) is simply not reopened —
     * the panel stays on New chat — and its stale entry is left to be
     * overwritten: an index that read back empty (a garbled chats.json) must
     * not cost the user the remembered chat as well.
     *
     * Only onto an untouched draft: the index can take a moment, and a chat the
     * user opened or started meanwhile is where they want to be.
     */
    private restoreOpenChat(vaultKey: string): void {
        const id = rememberedChat(vaultKey);
        if (!id || !this.state.chats.some(c => c.id === id)) return;
        if (this.state.activeChatId !== null || this.state.run || this.conversation(DRAFT_KEY).items.length) return;
        this.openChat(id);
    }

    /** Remember the chat on screen as this vault's open one (null = New chat). */
    private rememberOpen(chatId: string | null): void {
        if (this.state.vaultKey) rememberChat(this.state.vaultKey, chatId);
    }

    private async writeIndex(update: (index: ChatIndex) => ChatIndex): Promise<void> {
        const host = this.host;
        if (!host) return;
        const vaultKey = this.state.vaultKey;
        if (host.toolHost.vaultToken() !== this.indexVaultToken) return;
        const next = await host.updateChatIndex(update);
        // The write was serialized behind others; a vault switch since then
        // means these chats are no longer the ones on screen.
        if (vaultKey !== this.state.vaultKey) return;
        this.set({ chats: [...next.chats].sort(byRecent) });
    }

    private patchChat(id: string, patch: Partial<ChatMeta>): Promise<void> {
        // The same object back when the chat is not in this index: no write.
        return this.writeIndex(index => !index.chats.some(c => c.id === id) ? index : {
            ...index,
            chats: index.chats.map(c => c.id === id ? { ...c, ...patch } : c),
        });
    }

    /* ── the connection ── */

    private onBridgeState(): void {
        const helper = readyHelper();
        const was = this.lastHelper;
        this.lastHelper = helper;
        if (helper && helper !== was) {
            // A new helper process may have a fresh sessions folder.
            this.mirrorHashes.clear();
            this.set({ models: {} });
            void this.refreshAgents(false);
        }
        if (!helper && was && this.state.run) {
            this.abandonRun(agentBridge.getState().status === 'updating'
                ? 'VaultAgent is updating, so the reply stopped.'
                : 'Lost the connection to VaultAgent, so the reply stopped.', 'warning');
        }
    }

    async refreshAgents(refresh: boolean): Promise<void> {
        if (!helperReady(agentBridge.getState())) return;
        this.set({ agentsStatus: this.state.agents.length ? 'ready' : 'loading' });
        try {
            const agents = await agentBridge.request('agents.status', { refresh });
            this.set({ agents, agentsStatus: 'ready' });
            void this.ensureModels(this.config().agent, refresh);
        } catch {
            this.set({ agentsStatus: 'error' });
        }
    }

    agentStatus(agent: AgentId): AgentStatus | null {
        return this.state.agents.find(a => a.agent === agent) ?? null;
    }

    /** Whether `agent` can take a message now; the panel shows why not. */
    agentUsable(agent: AgentId): boolean {
        const status = this.agentStatus(agent);
        return !!status && status.installed && status.loggedIn !== false;
    }

    async ensureModels(agent: AgentId, force = false): Promise<void> {
        const existing = this.state.models[agent];
        if (!force && existing && existing.status !== 'error') return;
        if (!this.agentUsable(agent) || !helperReady(agentBridge.getState())) return;
        this.set({ models: { ...this.state.models, [agent]: { status: 'loading', models: existing?.models ?? [] } } });
        try {
            const models = await agentBridge.request('models.list', { agent });
            this.set({ models: { ...this.state.models, [agent]: { status: 'ready', models } } });
        } catch (e) {
            this.set({
                models: {
                    ...this.state.models,
                    [agent]: { status: 'error', models: [], error: e instanceof Error ? e.message : String(e) },
                },
            });
        }
    }

    /* ── chats ── */

    activeChat(): ChatMeta | null {
        return activeChatOf(this.state);
    }

    /** The agent/model/effort the NEXT message goes with. */
    config(): ChatConfig {
        return configOf(this.state);
    }

    conversationKey(): string {
        return this.state.activeChatId ?? DRAFT_KEY;
    }

    /** Changing agent starts a new chat — a chat's session belongs to one CLI. */
    selectAgent(agent: AgentId): void {
        const draft = draftFor(agent);
        writeChoice(draft);
        const conversations = { ...this.state.conversations };
        delete conversations[DRAFT_KEY];
        const teaching = { ...this.state.teaching };
        delete teaching[DRAFT_KEY];
        this.set({ draft, activeChatId: null, conversations, teaching });
        this.rememberOpen(null);
        void this.ensureModels(agent);
    }

    /** Remember whether a lesson is under way in `key` (see ChatStoreState). */
    private setTeaching(key: string, on: boolean): void {
        if (!!this.state.teaching[key] === on) return;
        const teaching = { ...this.state.teaching };
        if (on) teaching[key] = true; else delete teaching[key];
        this.set({ teaching });
    }

    /** Is a lesson under way in the chat on screen? The cap reads this. */
    isTeaching(): boolean {
        return !!this.state.teaching[this.conversationKey()];
    }

    newChat(): void {
        this.selectAgent(this.config().agent);
    }

    openChat(id: string): void {
        const chat = this.state.chats.find(c => c.id === id);
        if (!chat) return;
        this.set({ activeChatId: id });
        this.rememberOpen(id);
        void this.ensureModels(chat.agent);
        const conversation = this.state.conversations[id];
        if (!conversation || conversation.history === 'error') void this.loadHistory(chat);
    }

    /**
     * Put a chat on screen.
     *
     * The TREE first: it is the app's own transcript, and the only thing that
     * knows about branches. A chat made before trees existed has none, so the
     * CLI's history is read instead and becomes a straight-line tree — from
     * which that chat can be edited and branched like any other, without
     * anything being written until the user actually does so.
     */
    async loadHistory(chat: ChatMeta): Promise<void> {
        const host = this.host;
        if (!host) {
            this.setConversation(chat.id, { ...EMPTY_CONVERSATION, history: 'loaded' });
            return;
        }
        this.setConversation(chat.id, { ...this.conversation(chat.id), items: [], history: 'loading' });
        const vaultKey = this.state.vaultKey;

        const read = await host.readChatTree(chat.id);
        if (this.conversation(chat.id).history !== 'loading') return;   // a run started meanwhile
        const tree = vaultKey && vaultKey === this.state.vaultKey ? this.adoptCutOffTurn(vaultKey, chat.id, read) : read;
        if (tree !== read) this.persistTree(chat.id, tree, this.indexVaultToken);
        if (!isEmpty(tree)) {
            this.setConversation(chat.id, { items: itemsFromTree(tree), tree, history: 'loaded' });
            return;
        }

        if (!chat.sessionId || !helperReady(agentBridge.getState())) {
            this.setConversation(chat.id, { ...EMPTY_CONVERSATION, history: 'loaded' });
            return;
        }
        try {
            const vaultId = await host.ensureVaultUuid();
            if (!vaultId) throw new Error('This vault has no agent id yet.');
            const history = await agentBridge.request('session.history', { vaultId, agent: chat.agent, sessionId: chat.sessionId });
            if (this.conversation(chat.id).history !== 'loading') return;
            if (!history.found) {
                this.setConversation(chat.id, { ...EMPTY_CONVERSATION, history: 'missing' });
                return;
            }
            const items = history.items.map(historyToItem);
            this.setConversation(chat.id, { items, tree: treeFromItems(items, chat.sessionId), history: 'loaded' });
        } catch (e) {
            this.setConversation(chat.id, {
                ...EMPTY_CONVERSATION,
                history: 'error',
                historyError: e instanceof Error ? e.message : String(e),
            });
        }
    }

    /* ── editing the past ── */

    /**
     * Send `text` as another version of the message `nodeId`.
     *
     * Everything below it on this branch stays where it is; the panel shows the
     * new version, and the arrows under the message walk between them.
     */
    editMessage(nodeId: string, text: string): void {
        const trimmed = text.trim();
        const node = this.conversation(this.conversationKey()).tree.nodes[nodeId];
        if (!trimmed || !node || node.role !== 'user' || this.state.run) return;
        if (trimmed === node.text.trim()) return;   // nothing was changed
        // An edit changes the words, not the attachments. resendableImages()
        // is what the edit box tells the user when some can no longer go.
        void this.send(trimmed, this.sentImages.get(nodeId) ?? [], nodeId, { missingImages: this.missingImages(nodeId) });
    }

    /**
     * Ask the message `userNodeId` again: a new VERSION of it with the same
     * words (an edit that keeps the text), so the answer it replaces stays one
     * arrow away. `model` and `effort` override the chat's for this one run
     * only — the chat's own choice is untouched. A null/undefined model runs
     * with the chat's; an undefined effort runs with the chat's (or, where the
     * model takes no such level, that model's default), null with the model's
     * own default, and a level the model does not offer falls back the same way.
     *
     * Its pictures go again if this store still holds them (sentImages: this
     * page, recent messages only); otherwise the retry goes without them, and
     * the new turn says so. Refused while a run is live, like an edit: a
     * second run would have nowhere to go.
     */
    retry(userNodeId: string, model?: string | null, effort?: string | null): void {
        const node = this.conversation(this.conversationKey()).tree.nodes[userNodeId];
        if (!node || node.role !== 'user' || this.state.run) return;
        void this.send(node.text, this.sentImages.get(userNodeId) ?? [], userNodeId, {
            model: model ?? null, effort, missingImages: this.missingImages(userNodeId),
        });
    }

    /**
     * How many pictures the message `userItemId` (a user item id, which is its
     * tree node id) was sent with, and how many of them an edit or a retry of
     * it can still send. Fewer `available` than `count` after a reload, or once
     * newer pictures pushed them out of the in-memory cap (IMAGE_MEMORY_CHARS):
     * the tree file records only how many there were.
     */
    resendableImages(userItemId: string): { count: number; available: number } {
        const conversation = this.conversation(this.conversationKey());
        const node = conversation.tree.nodes[userItemId];
        const item = conversation.items.find(i => i.id === userItemId);
        const count = node?.role === 'user' ? node.images ?? 0 : item?.kind === 'user' ? item.imageCount : 0;
        return { count, available: Math.min(count, this.sentImages.get(userItemId)?.length ?? 0) };
    }

    private missingImages(userItemId: string): number {
        const { count, available } = this.resendableImages(userItemId);
        return count - available;
    }

    /** The last message the user sent on the branch on screen (↑ in an empty
     *  composer edits it), or null when there is none. */
    lastUserItemId(): string | null {
        const items = this.conversation(this.conversationKey()).items;
        for (let i = items.length - 1; i >= 0; i--) {
            if (items[i].kind === 'user') return items[i].id;
        }
        return null;
    }

    private rememberImages(nodeId: string, images: PreparedImage[]): void {
        if (!images.length) return;
        this.sentImages.set(nodeId, images);
        // Each picture counted once: every version of an edited or retried
        // message holds the SAME objects, which cost their memory only once.
        const holders = new Map<PreparedImage, number>();
        for (const list of this.sentImages.values()) for (const image of list) holders.set(image, (holders.get(image) ?? 0) + 1);
        let total = 0;
        for (const image of holders.keys()) total += image.data.length;
        // A Map iterates in insertion order: the first key is the oldest.
        for (const [id, list] of this.sentImages) {
            if (total <= IMAGE_MEMORY_CHARS || id === nodeId) break;
            for (const image of list) {
                const left = holders.get(image)! - 1;
                holders.set(image, left);
                if (!left) total -= image.data.length;
            }
            this.sentImages.delete(id);
        }
    }

    /** The arrows under a message: show its version `index` instead. */
    selectVersionAt(nodeId: string, index: number): void {
        const tree = this.conversation(this.conversationKey()).tree;
        const node = tree.nodes[nodeId];
        if (!node) return;
        const siblings = tree.children[node.parent ?? ''] ?? [];
        const target = siblings[index];
        if (target) this.selectVersion(target);
    }

    /** Show another version of a message (its own newest line below it). */
    selectVersion(nodeId: string): void {
        const key = this.conversationKey();
        // Not under a live run: its reply is committed below the tree's active
        // leaf when it ends (commitRun), and switching away would hang it
        // under whichever version was on screen at that moment.
        if (this.state.run?.chatId === key) return;
        const conversation = this.conversation(key);
        const tree = selectVersionIn(conversation.tree, nodeId);
        if (tree === conversation.tree) return;
        this.setConversation(key, {
            ...conversation, tree, history: 'loaded',
            items: keepIdentity(itemsFromTree(tree), conversation.items),
        });
        this.persistTree(key, tree, this.indexVaultToken);
    }

    /** Write a chat's transcript out, into `vault` — the vault the chat lives
     *  in, which a run outlives (see writeChatTree). Fire and forget: a tree
     *  that cannot be saved still shows, and the next write tries again. */
    private persistTree(key: string, tree: ChatTree, vault: object | null): void {
        if (key === DRAFT_KEY || !this.host) return;
        void this.host.writeChatTree(key, tree, vault);
    }

    /** Permanent, after the app's own confirm: the index entry AND the CLI's own
     *  record, so it also leaves the terminal's resume list. */
    async deleteChat(id: string): Promise<void> {
        const host = this.host;
        const chat = this.state.chats.find(c => c.id === id);
        if (!host || !chat) return;
        const ok = await host.ask({
            title: 'Delete this chat?',
            body: `“${chat.title}” will be deleted permanently, here and from ${AGENT_LABELS[chat.agent]}'s own history. This can't be undone.`,
            confirmLabel: 'Delete',
            danger: true,
        });
        if (!ok) return;
        if (this.state.run?.chatId === id) await this.stop();
        if (chat.sessionId) {
            try {
                const vaultId = await host.ensureVaultUuid();
                if (vaultId) await agentBridge.request('session.delete', { vaultId, agent: chat.agent, sessionId: chat.sessionId });
            } catch (e) {
                // Keep the index entry: removing it would orphan a session the
                // user asked to have deleted, with nothing left to retry from.
                const message = e instanceof BridgeError ? e.message : String(e);
                this.notice(this.conversationKey(), 'error', `Couldn't delete “${chat.title}”: ${message}`);
                return;
            }
        }
        await this.writeIndex(index => ({ ...index, chats: index.chats.filter(c => c.id !== id) }));
        // The transcript goes with it: a chat deleted on purpose should not
        // leave its branches behind in .VaultAgent/chats/.
        await host.deleteChatTree(id).catch(() => {});
        // …and so does a turn a reload cut off, if it was never loaded back.
        const cutOff = readMap(CUT_OFF_KEY);
        const cutOffEntry = this.state.vaultKey ? cutOffKey(this.state.vaultKey, id) : '';
        if (cutOffEntry in cutOff) {
            delete cutOff[cutOffEntry];
            writeJSON(CUT_OFF_KEY, cutOff);
        }
        const conversations = { ...this.state.conversations };
        revokeThumbs(conversations[id]);
        for (const nodeId of Object.keys(conversations[id]?.tree.nodes ?? {})) this.sentImages.delete(nodeId);
        delete conversations[id];
        const teaching = { ...this.state.teaching };
        delete teaching[id];
        const wasOpen = this.state.activeChatId === id;
        this.set({
            conversations,
            teaching,
            activeChatId: wasOpen ? null : this.state.activeChatId,
        });
        if (wasOpen) this.rememberOpen(null);
    }

    /**
     * Give a chat a name of its own. Whitespace runs collapse to one space (a
     * title is one line in every list that shows it); an empty name is
     * refused rather than saved. Shown at once, then written through the
     * index queue. `updatedAt` is left alone: naming a chat is not talking in
     * it, and bumping it would reorder the chats menu under the pointer.
     */
    async renameChat(chatId: string, title: string): Promise<void> {
        const next = title.replace(/\s+/g, ' ').trim();
        const chat = this.state.chats.find(c => c.id === chatId);
        if (!chat || !next || next === chat.title) return;
        const previous = chat.title;
        this.set({ chats: this.state.chats.map(c => c.id === chatId ? { ...c, title: next } : c) });
        try {
            await this.patchChat(chatId, { title: next });
        } catch (e) {
            // Not saved: show what the file still says, unless something
            // renamed it again meanwhile.
            this.set({ chats: this.state.chats.map(c => c.id === chatId && c.title === next ? { ...c, title: previous } : c) });
            throw e;
        }
    }

    /** Star or unstar a chat (the chats menu's Starred group). Unstarring
     *  removes the key rather than writing `false`, so a chat that was never
     *  starred and one that was unstarred read the same in chats.json. */
    async setStarred(chatId: string, starred: boolean): Promise<void> {
        const chat = this.state.chats.find(c => c.id === chatId);
        if (!chat || !!chat.starred === starred) return;
        const to = (on: boolean) => (c: ChatMeta) => c.id === chatId ? withStar(c, on) : c;
        this.set({ chats: this.state.chats.map(to(starred)) });
        try {
            await this.writeIndex(index => !index.chats.some(c => c.id === chatId) ? index : { ...index, chats: index.chats.map(to(starred)) });
        } catch (e) {
            this.set({ chats: this.state.chats.map(to(!starred)) });
            throw e;
        }
    }

    /** Model/effort apply from the next message, and become the default for
     *  new chats with this agent. */
    setModel(model: string | null, effort: string | null): void {
        const config = { ...this.config(), model, effort };
        writeChoice(config);
        const chat = this.activeChat();
        if (chat) {
            this.set({ chats: this.state.chats.map(c => c.id === chat.id ? { ...c, model, effort } : c) });
            void this.patchChat(chat.id, { model, effort });
        } else {
            this.set({ draft: config });
        }
    }

    private currentRun(): RunInfo | null {
        return this.state.run;
    }

    /* ── sending ── */

    /** One run at a time; the composer is disabled while one is live. */
    /**
     * `editOf` re-sends an earlier message with new words: it becomes another
     * VERSION of that message (a sibling in the tree), the thread under the old
     * one is kept, and the run starts a fresh CLI session carrying the turns
     * above as a transcript — the old session holds the words that were edited
     * away (utils/chatTree.ts).
     */
    async send(
        text: string, images: PreparedImage[], editOf?: string,
        options: { model?: string | null; effort?: string | null; missingImages?: number } = {},
    ): Promise<void> {
        const host = this.host;
        if (!host || !this.state.vaultKey || this.state.run || !helperReady(agentBridge.getState())) return;
        // `config` is the chat's own (what a draft becomes a chat with);
        // `runConfig` is this run's, which a retry may point at another model
        // or effort.
        const config = this.config();
        const runConfig = withRunOverride(config, options.model ?? null, options.effort, this.state.models[config.agent]?.models);
        const existing = this.activeChat();
        const runId = uid();
        let key = this.conversationKey();
        // A run that ended without committing (stopped while preparing) can
        // leave this behind; it must never catch this run's reply.
        this.runUserNode = null;
        this.runSessionId = null;

        // Shown at once; everything below is async and may take a moment
        // (the mirror read, the canvas capture).
        // The message goes into the TREE first, and the panel is redrawn from
        // it: an edit replaces the thread below with its own branch, a new
        // message extends the one on screen. The node's id is the item's id, so
        // everything downstream addresses one message by one name.
        const userItemId = uid();
        const before = this.conversation(key);
        const tree = editOf
            ? branchFrom(before.tree, editOf, { id: userItemId, text, createdAt: Date.now(), images: images.length || undefined })
            : appendNode(before.tree, { id: userItemId, role: 'user', text, createdAt: Date.now(), images: images.length || undefined });
        // The live item keeps its thumbnails, which the tree cannot hold.
        const userItem: ChatItem = { kind: 'user', id: userItemId, text, thumbs: images.map(i => i.url), imageCount: images.length, context: null };
        // A follow-up leaves every item above it EXACTLY as it is — the same
        // objects, so no row re-renders, remounts or moves. (Redrawing them
        // from the tree here is what regrouped the last turn's tools above its
        // text the moment the next message went.) An edit cuts the branch, so
        // it does redraw from the tree, keeping each surviving item's object.
        const items = !editOf && before.history === 'loaded'
            ? [...before.items, userItem]
            : [...keepIdentity(itemsFromTree(tree), before.items).slice(0, -1), userItem];
        this.setConversation(key, { ...before, tree, history: 'loaded', items });
        this.rememberImages(userItemId, images);
        // Never dropped silently: the turn says what did not go with it, and
        // keeps saying so (the notice is saved with the turn).
        const missing = options.missingImages ?? 0;
        if (missing > 0) {
            this.notice(key, 'warning', `${missing === 1 ? 'The image' : `${missing} images`} from the original message couldn't be sent again: pictures are only kept for recent messages, and not after a reload.`);
        }
        // Decided here, from the words just typed, not by the model: the cap in
        // the composer lights on this same answer (see utils/agentReplyMode.ts).
        const mode = resolveReplyMode(getReplyModePref(), text, !!this.state.teaching[key]);
        this.setTeaching(key, mode === 'teach');

        this.runVaultToken = host.toolHost.vaultToken();
        this.runImageHash = null;
        this.releaseRun = agentBridge.retain();
        // The CLI's default when no model is chosen: its id is what the reply
        // names. Unknown until models.list has answered; then left out.
        const runModel = resolveModel(this.state.models[runConfig.agent]?.models, runConfig.model)?.id ?? runConfig.model;
        this.set({ run: { runId, chatId: existing?.id ?? DRAFT_KEY, phase: 'preparing', startedAt: Date.now(), model: runModel } });
        const stillOurs = () => this.state.run?.runId === runId && this.state.run.phase !== 'stopping';

        try {
            const vaultUuid = await host.ensureVaultUuid();
            if (!vaultUuid) throw new Error("Couldn't create the vault's .VaultAgent folder, so the agent has nowhere to keep its chats.");
            if (!stillOurs()) return;

            // The draft becomes a chat on its first message.
            let chat = existing;
            if (!chat) {
                const now = Date.now();
                chat = {
                    id: uid(), agent: config.agent, sessionId: null, title: titleFrom(text, images.length),
                    model: config.model, effort: config.effort, createdAt: now, updatedAt: now, lastImageHash: null,
                };
                const created = chat;
                const conversations = { ...this.state.conversations, [created.id]: { ...this.conversation(DRAFT_KEY), history: 'loaded' as const } };
                delete conversations[DRAFT_KEY];
                // The lesson was decided against the draft's key a moment ago.
                const teaching = { ...this.state.teaching, [created.id]: !!this.state.teaching[DRAFT_KEY] };
                delete teaching[DRAFT_KEY];
                key = created.id;
                this.set({
                    conversations,
                    teaching,
                    activeChatId: created.id,
                    chats: [created, ...this.state.chats],
                    run: { ...this.state.run!, chatId: created.id },
                });
                this.rememberOpen(created.id);
                await this.writeIndex(index => ({ ...index, chats: [...index.chats.filter(c => c.id !== created.id), created] }));
                if (!stillOurs()) return;
            }

            await this.syncMirror(host, vaultUuid);
            if (!stillOurs()) return;

            const model = resolveModel(this.state.models[runConfig.agent]?.models, runConfig.model);
            const imagesSupported = model ? model.images : true;
            const context = await buildAgentContext(host.workspace(), {
                vaultUuid,
                lastImageHash: chat.lastImageHash ?? null,
                imagesSupported,
                mode,
            });
            if (!stillOurs()) return;

            const runImages: RunImage[] = [];
            if (imagesSupported) {
                for (const image of images) runImages.push({ mimeType: image.mimeType, data: image.data });
                // The view image is extra; the user's own pictures come first.
                if (context.image && runImages.length < MAX_IMAGES_PER_MESSAGE) {
                    runImages.unshift({ mimeType: context.image.mimeType, data: context.image.data });
                    this.runImageHash = context.image.hash;
                }
            } else if (images.length) {
                this.notice(key, 'warning', `${model?.label ?? 'This model'} can't see images, so ${images.length === 1 ? 'the image was' : 'the images were'} left out.`);
            }

            // DEV ONLY, and deliberately not a setting: the block is a
            // diagnostic — how the editor described the user's screen to the
            // agent — and in the app it is a fold of machine text under every
            // message the reader did not write. It is also up to 60k characters
            // a message, all of it held for the life of the chat.
            if (import.meta.env.DEV) {
                this.updateItems(key, items => items.map(item =>
                    item.id === userItemId && item.kind === 'user' ? { ...item, context: context.text.trim() || null } : item));
            }

            // The session belongs to the BRANCH, not to the chat: a fork starts
            // its own, and is handed the turns above it as a transcript because
            // the other version's session holds the words that were edited away.
            const branchTree = this.conversation(key).tree;
            const sessionId = activeSessionId(branchTree);
            const prefix = sessionId ? '' : transcriptPrefix(branchTree, userItemId);
            this.runUserNode = { key, nodeId: userItemId, model: runModel, vault: this.runVaultToken };
            // Saved before the run, not only after it: a window closed mid-reply
            // should still have the question, and the branch it was asked on.
            this.persistTree(key, branchTree, this.runVaultToken);

            await agentBridge.request('run.start', {
                runId,
                vaultId: vaultUuid,
                agent: runConfig.agent,
                sessionId,
                model: runConfig.model,
                effort: runConfig.effort,
                text: context.text + prefix + text,
                images: runImages,
            });
            // Stopped while run.start was on the wire: the helper started it
            // anyway, so cancel it there too rather than let the CLI run on.
            // (Read through currentRun(): TS keeps `this.state.run` narrowed
            // across the awaits above, which is exactly what may have changed.)
            const after = this.currentRun();
            if (after?.runId !== runId) {
                agentBridge.request('run.cancel', { runId }).catch(() => {});
                return;
            }
            if (after.phase === 'preparing') this.set({ run: { ...after, phase: 'running' } });
        } catch (e) {
            const now = this.currentRun();
            if (now?.runId !== runId || now.phase === 'stopping') {
                if (now?.runId === runId) this.endRun(key, null);
                return;
            }
            // Committed when run.start itself failed (the question is in the
            // tree by then); an earlier failure has no turn to keep it in.
            this.endRun(key, null, 'error', e instanceof Error ? e.message : String(e));
            if (e instanceof BridgeError && (e.code === 'agent-missing' || e.code === 'logged-out' || e.code === 'agent-changed')) {
                void this.refreshAgents(true);
            }
        }
    }

    /** Copy the vault's CLAUDE.md / AGENTS.md / skills into the agent's working
     *  folder — skipped when nothing changed since the last copy this session
     *  (the read happens either way; the write and the transfer do not). */
    private async syncMirror(host: AgentHost, vaultId: string): Promise<void> {
        const files = await host.collectMirrorFiles();
        const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        const hash = await sha256Hex(JSON.stringify(sorted));
        if (this.mirrorHashes.get(vaultId) === hash) return;
        await agentBridge.request('vault.sync', { vaultId, files: sorted });
        this.mirrorHashes.set(vaultId, hash);
    }

    async stop(): Promise<void> {
        const run = this.state.run;
        if (!run) return;
        if (run.phase === 'preparing') {
            // Nothing reached the helper yet: just stop here.
            this.endRun(run.chatId, null, 'info', 'Stopped.');
            return;
        }
        this.set({ run: { ...run, phase: 'stopping' } });
        try {
            await agentBridge.request('run.cancel', { runId: run.runId }, 10_000);
        } catch {
            // The helper is gone or the run already ended; either way it is over.
            if (this.state.run?.runId === run.runId) this.endRun(run.chatId, null, 'info', 'Stopped.');
        }
    }

    /**
     * Stop listening to a run without waiting for the helper (vault switch,
     * lost connection, the page going away). Its late events are ignored by
     * runId. What it produced is kept as a stop keeps it: closed, `message`
     * after it, committed into its chat.
     *
     * After a VAULT SWITCH that commit is still safe, because it is written
     * through the token captured when the run started (runUserNode.vault →
     * writeChatTree's `vault`): the file is the OLD vault's own
     * .VaultAgent/chats/<chatId>.json, the open vault is never touched, and
     * the chat index is not written at all — so nothing races its queue, whose
     * queued writes each re-check the open root and drop themselves. The index
     * already lists the chat: runUserNode is only set after the draft's index
     * entry was written, so a run cut off earlier than that commits nothing.
     * What the index misses is the run's late `updatedAt` bump, which is
     * cosmetic (its sort order in the chats menu).
     */
    private abandonRun(message: string, tone: 'info' | 'warning'): void {
        const run = this.state.run;
        if (!run) return;
        if (agentBridge.getState().status === 'connected' && run.phase !== 'preparing') {
            agentBridge.request('run.cancel', { runId: run.runId }).catch(() => {});
        }
        this.endRun(run.chatId, this.runSessionId, tone, message);
    }

    /**
     * A reload or a closed tab mid-reply: best effort, the same commit as a
     * stop — what streamed, then "Stopped." The helper cancels the run itself
     * when the socket closes (connection.ts onClose), so only the saving is
     * ours. Not for a page going into the back/forward cache (`persisted`):
     * it may come back, run and all.
     *
     * Neither half can corrupt the tree file:
     *   · the direct write (commitRun) lands whole or not at all —
     *     `createWritable()` writes a swap file that `close()` swaps in
     *     atomically, and a page torn down first aborts the stream and leaves
     *     the old file, the question saved before run.start;
     *   · the copy in localStorage (CUT_OFF_KEY) is only folded in on the next
     *     load, through the ordinary per-chat write queue, and only onto a file
     *     still exactly where this run left it (adoptCutOffTurn).
     * Only for a run in the vault the index on screen belongs to: the key
     * names a vault by `vaultKey`, which a switch made with the panel closed
     * has not caught up with.
     */
    private readonly onPageHide = (event: PageTransitionEvent): void => {
        if (event.persisted || !this.state.run) return;
        const pending = this.runUserNode;
        const vaultKey = this.state.vaultKey;
        this.abandonRun('Stopped.', 'info');
        if (!pending || !vaultKey || pending.vault !== this.indexVaultToken) return;
        const tree = this.conversation(pending.key).tree;
        const node = tree.activeLeaf ? tree.nodes[tree.activeLeaf] : null;
        if (node?.role !== 'assistant' || node.parent !== pending.nodeId) return;
        const map = readMap(CUT_OFF_KEY);
        map[cutOffKey(vaultKey, pending.key)] = { parent: pending.nodeId, node };
        writeJSON(CUT_OFF_KEY, map);
    };

    /**
     * `tree`, with the turn a reload cut off folded back in (onPageHide), or
     * `tree` itself. Only when the file is still exactly where that run left it
     * — its question the active leaf, unanswered: if the direct write landed
     * after all, or another window answered or edited since, the copy is
     * stale and is dropped. Shape-checked through the file's own parser, since
     * localStorage is user-editable.
     */
    private adoptCutOffTurn(vaultKey: string, chatId: string, tree: ChatTree): ChatTree {
        const map = readMap(CUT_OFF_KEY);
        const key = cutOffKey(vaultKey, chatId);
        if (!(key in map)) return tree;
        const saved = map[key] as { parent?: unknown; node?: Partial<ChatNode> } | null;
        delete map[key];
        writeJSON(CUT_OFF_KEY, map);
        const parent = saved?.parent;
        const node = saved?.node;
        if (typeof parent !== 'string' || !node || typeof node !== 'object' || typeof node.id !== 'string') return tree;
        if (tree.nodes[node.id] || tree.activeLeaf !== parent || tree.children[parent]?.length) return tree;
        const merged = parseTree(serializeTree(appendNode(tree, node as Omit<ChatNode, 'parent'>)));
        const adopted = merged.nodes[node.id];
        return adopted?.role === 'assistant' && adopted.parent === parent ? merged : tree;
    }

    /**
     * Every way a run ends that keeps its turn: close what is streaming, add
     * the closing line ("Stopped.", the error) AFTER what the run produced,
     * then commit — in that order, so the line is part of the saved turn and
     * reads the same after the next message and after a reload as it did live.
     */
    private endRun(key: string, sessionId: string | null, tone?: 'info' | 'warning' | 'error', message?: string): void {
        this.finishRun(key);
        if (tone && message) this.notice(key, tone, message);
        this.commitRun(key, sessionId);
    }

    /** Close whatever is still streaming, and free the run slot. */
    private finishRun(key: string): void {
        this.updateItems(key, items => items.map(item => {
            if (item.kind === 'assistant' && item.streaming) return { ...item, streaming: false };
            if (item.kind === 'reasoning' && item.streaming) return { ...item, streaming: false, endedAt: item.endedAt ?? Date.now() };
            if (item.kind === 'tool' && item.status === 'running') return { ...item, status: 'error' as const };
            return item;
        }));
        this.set({ run: null });
        this.runVaultToken = null;
        this.runSessionId = null;
        this.releaseRun?.();
        this.releaseRun = null;
    }

    /**
     * Write what the run produced into the tree, and save it.
     *
     * One assistant node per run, holding its reply, its thinking, its tool
     * calls and its closing notice, in the order they streamed — so the branch
     * reads the same after the next message and after a reload as it did live.
     * The ITEMS are not touched: the node's segments carry their ids, so the
     * tree and the list on screen already agree. A run that produced nothing
     * at all leaves no empty bubble behind: no node, and the branch ends at the
     * message that asked.
     */
    private commitRun(key: string, sessionId: string | null): void {
        const pending = this.runUserNode;
        this.runUserNode = null;
        if (!pending || pending.key !== key) return;
        const conversation = this.conversation(key);
        if (!conversation.tree.nodes[pending.nodeId]) return;

        const patch = foldRunIntoNode(conversation.items, pending.nodeId);
        let tree = conversation.tree;
        if (patch.segments?.length) {
            tree = appendNode(tree, {
                id: uid(), role: 'assistant', text: '', createdAt: Date.now(),
                ...(sessionId ? { sessionId } : {}),
                ...(pending.model ? { model: pending.model } : {}),
                ...patch,
            });
        }
        this.setConversation(key, { ...conversation, tree });
        // Into the vault the run started in, which a switch mid-reply has
        // made a different one from the vault open now (abandonRun).
        this.persistTree(key, tree, pending.vault);
    }

    /* ── the helper's events ── */

    private onHelperEvent(event: HelperEvent): void {
        // The terminal shares the bridge's listener list but not a byte of state.
        if (isTerminalEvent(event)) return;
        if (event.type === 'tool.call') { void this.onToolCall(event); return; }
        const run = this.state.run;
        if (!run || event.runId !== run.runId) return;
        const key = run.chatId;
        if (event.type === 'run.event') { this.onAgentEvent(key, run, event.event); return; }
        const chat = this.state.chats.find(c => c.id === key);
        if (event.type === 'run.done') {
            const imageHash = event.status === 'ok' ? this.runImageHash : null;
            if (event.status === 'cancelled') this.endRun(key, event.sessionId ?? null, 'info', 'Stopped.');
            else this.endRun(key, event.sessionId ?? null);
            if (chat) {
                void this.patchChat(chat.id, {
                    sessionId: event.sessionId ?? chat.sessionId,
                    updatedAt: Date.now(),
                    ...(imageHash ? { lastImageHash: imageHash } : {}),
                }).catch(() => {});
            }
            return;
        }
        // run.error
        const agent = chat?.agent ?? this.config().agent;
        this.endRun(key, null, event.reason === 'cancelled' ? 'info' : 'error', runErrorMessage(event.reason, event.message, agent));
        if (event.reason === 'agent-missing' || event.reason === 'logged-out' || event.reason === 'agent-changed') {
            void this.refreshAgents(true);
        }
        if (chat) void this.patchChat(chat.id, { updatedAt: Date.now() }).catch(() => {});
    }

    private onAgentEvent(key: string, run: RunInfo, event: AgentEvent): void {
        if (run.phase === 'preparing') this.set({ run: { ...run, phase: 'running' } });
        switch (event.type) {
            case 'session': {
                this.runSessionId = event.sessionId;
                const chat = this.state.chats.find(c => c.id === key);
                // Written at once, not at the end: a reload mid-reply must
                // still be able to find this chat's transcript.
                if (chat && chat.sessionId !== event.sessionId) {
                    this.set({ chats: this.state.chats.map(c => c.id === key ? { ...c, sessionId: event.sessionId } : c) });
                    void this.patchChat(key, { sessionId: event.sessionId }).catch(() => {});
                }
                return;
            }
            case 'text-delta':
                this.updateItems(key, items => {
                    const closed = closeReasoning(items);
                    const last = closed[closed.length - 1];
                    if (last?.kind === 'assistant' && last.streaming) {
                        return [...closed.slice(0, -1), { ...last, text: last.text + event.text }];
                    }
                    return [...closed, {
                        kind: 'assistant', id: uid(), text: event.text, streaming: true,
                        ...(run.model ? { model: run.model } : {}),
                    }];
                });
                return;
            case 'reasoning-delta':
                this.updateItems(key, items => {
                    const last = items[items.length - 1];
                    if (last?.kind === 'reasoning' && last.streaming) {
                        return [...items.slice(0, -1), { ...last, text: last.text + event.text }];
                    }
                    return [...endAssistant(items), { kind: 'reasoning', id: uid(), text: event.text, streaming: true, startedAt: Date.now(), endedAt: null }];
                });
                return;
            case 'tool':
                this.updateItems(key, items => {
                    const at = items.findIndex(i => i.kind === 'tool' && i.callId === event.callId && !i.own);
                    if (at >= 0) {
                        const prev = items[at] as Extract<ChatItem, { kind: 'tool' }>;
                        const next = items.slice();
                        next[at] = { ...prev, status: event.status, input: event.input ?? prev.input, output: event.output ?? prev.output };
                        return next;
                    }
                    return [...endAssistant(closeReasoning(items)), {
                        kind: 'tool', id: uid(), callId: event.callId, name: event.name, input: event.input,
                        status: event.status, output: event.output, own: false,
                    }];
                });
                return;
            case 'notice':
                this.notice(key, 'info', event.message);
                return;
        }
    }

    private async onToolCall(call: Extract<HelperEvent, { type: 'tool.call' }>): Promise<void> {
        const host = this.host;
        const run = this.state.run;
        const reply = (result: ToolResult) => {
            agentBridge.send({ type: 'tool.result', runId: call.runId, callId: call.callId, result });
        };
        if (!host || !run || run.runId !== call.runId) {
            reply({ content: [{ type: 'text', text: 'No run is active in the editor.' }], isError: true });
            return;
        }
        const key = run.chatId;
        const itemId = uid();
        this.updateItems(key, items => [...endAssistant(closeReasoning(items)), {
            kind: 'tool', id: itemId, callId: call.callId, name: call.name, input: call.args, status: 'running', own: true,
        }]);
        const queued = this.toolQueue.then(() => this.runToolCall(call, host, key, itemId, reply));
        this.toolQueue = queued.catch(() => {});
        await queued;
    }

    private async runToolCall(
        call: Extract<HelperEvent, { type: 'tool.call' }>, host: AgentHost, key: string, itemId: string,
        reply: (result: ToolResult) => void,
    ): Promise<void> {
        const markRefused = (text: string) => {
            reply({ content: [{ type: 'text', text }], isError: true });
            this.updateItems(key, items => items.map(item =>
                item.id === itemId && item.kind === 'tool' ? { ...item, status: 'error' as const, output: text } : item));
        };
        // Queued behind others: the run may have ended or been stopped since.
        // A call the user pressed Stop on must not still edit or trash things.
        const run = this.state.run;
        if (!run || run.runId !== call.runId || run.phase === 'stopping') {
            markRefused('The user stopped this run; nothing was done.');
            return;
        }
        // A switched vault must never receive this run's edits. The executor
        // refuses on its own too; this also stops the run.
        if (host.toolHost.vaultToken() !== this.runVaultToken) {
            reply({ content: [{ type: 'text', text: 'The user closed or switched the vault; this run is being stopped.' }], isError: true });
            this.abandonRun('Stopped.', 'info');
            return;
        }
        let result: ToolResult;
        let change: AgentChange | undefined;
        try {
            const execution = await executeTool(call.name, call.args, host.toolHost, { vaultToken: this.runVaultToken });
            result = execution.result;
            change = execution.change;
        } catch (e) {
            result = { content: [{ type: 'text', text: `The editor failed to run ${call.name}: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
        reply(result);
        const output = resultText(result);
        this.updateItems(key, items => items.map(item =>
            item.id === itemId && item.kind === 'tool'
                ? { ...item, status: result.isError ? 'error' as const : 'done' as const, output, change }
                : item));
    }

    /** The helper removed itself: whatever was running is gone with it. */
    onUninstalled(): void {
        if (this.state.run) this.finishRun(this.state.run.chatId);
        this.set({ agents: [], agentsStatus: 'idle', models: {} });
    }
}

function closeReasoning(items: ChatItem[]): ChatItem[] {
    const last = items[items.length - 1];
    if (last?.kind === 'reasoning' && last.streaming) {
        return [...items.slice(0, -1), { ...last, streaming: false, endedAt: Date.now() }];
    }
    return items;
}

/** A tool call or thought between two runs of text splits the reply in two. */
function endAssistant(items: ChatItem[]): ChatItem[] {
    const last = items[items.length - 1];
    if (last?.kind === 'assistant' && last.streaming) {
        return [...items.slice(0, -1), { ...last, streaming: false }];
    }
    return items;
}

/* ───────────────────────── the tree ⇄ what is drawn ───────────────────────── */

/**
 * The branch on screen, as panel items.
 *
 * Node ids become item ids on purpose: the edit button, the version arrows and
 * the streaming updates all address the same message by one id, so nothing has
 * to map between "the third item" and "the node it came from". An assistant
 * node with segments comes back as exactly the items it was folded from — same
 * order, same ids, same thinking times — so a reloaded chat, a switched-back
 * branch and the turn above a follow-up all look as they did live.
 */
export function itemsFromTree(tree: ChatTree): ChatItem[] {
    const items: ChatItem[] = [];
    for (const node of activePath(tree)) {
        if (node.role === 'user') {
            items.push({
                kind: 'user', id: node.id, text: node.text,
                // Thumbnails are object URLs; they die with the page, and the
                // count is what survives to say pictures went with it.
                thumbs: [], imageCount: node.images ?? 0, context: null,
            });
            continue;
        }
        if (node.segments) {
            for (const segment of node.segments) items.push(segmentItem(node, segment));
            continue;
        }
        // A node saved before segments: its parts in a fixed order, the only
        // one the flat fields can give (thinking, tools, then the reply), with
        // ids derived from the node so they are at least stable between draws.
        if (node.reasoning) {
            items.push({ kind: 'reasoning', id: `${node.id}:think`, text: node.reasoning, streaming: false, startedAt: null, endedAt: null });
        }
        for (const tool of node.tools ?? []) items.push(toolItem(tool, `${node.id}:${tool.callId}`));
        if (node.text || !node.tools?.length) {
            items.push(node.error
                ? { kind: 'notice', id: node.id, tone: 'error', message: node.text }
                : { kind: 'assistant', id: node.id, text: node.text, streaming: false });
        }
    }
    return items;
}

function segmentItem(node: ChatNode, segment: StoredSegment): ChatItem {
    switch (segment.kind) {
        case 'text':
            return {
                kind: 'assistant', id: segment.id, text: segment.text, streaming: false,
                ...(node.model ? { model: node.model } : {}),
            };
        case 'reasoning':
            return {
                kind: 'reasoning', id: segment.id, text: segment.text, streaming: false,
                startedAt: segment.startedAt ?? null, endedAt: segment.endedAt ?? null,
            };
        case 'tool':
            // parseTree checked the index against `tools`.
            return toolItem(node.tools![segment.tool], segment.id);
        case 'notice':
            return { kind: 'notice', id: segment.id, tone: segment.tone, message: segment.message };
    }
}

function toolItem(tool: StoredTool, id: string): ChatItem {
    return {
        kind: 'tool', id, callId: tool.callId, name: tool.name,
        input: tool.input, status: tool.status, output: tool.output, own: tool.own,
        ...(tool.change ? { change: tool.change as AgentChange } : {}),
    };
}

/** How long a finished thought took, or null when that was not recorded (a
 *  turn read from the CLI, or saved before segments) — "Thought" alone. */
export function reasoningDurationMs(item: Extract<ChatItem, { kind: 'reasoning' }>): number | null {
    return item.startedAt != null && item.endedAt != null ? Math.max(0, item.endedAt - item.startedAt) : null;
}

/**
 * `next`, with every item `previous` already had (same id, same kind) swapped
 * for that earlier object.
 *
 * Identity is the message list's memo key and the id its React key: a row
 * whose object did not change is not re-rendered, and one whose id did not
 * change is not remounted — so a reply keeps its rendered view and its height,
 * and nothing above the fold moves. The earlier object also still carries
 * what the tree cannot: a user message's thumbnails, the dev context fold.
 */
export function keepIdentity(next: ChatItem[], previous: ChatItem[]): ChatItem[] {
    if (!previous.length) return next;
    const byId = new Map(previous.map(item => [item.id, item]));
    return next.map(item => {
        const before = byId.get(item.id);
        return before && before.kind === item.kind ? before : item;
    });
}

/**
 * A run's config with a retry's `model` and `effort` in place of the chat's
 * (null model / undefined effort: the chat's own). The effort asked for is
 * kept when the model takes it, else becomes that model's own default (Haiku
 * takes none; sending "max" would be refused); null asks for no level at all,
 * the model's default.
 */
function withRunOverride(
    config: ChatConfig, model: string | null, effort: string | null | undefined, models: ModelInfo[] | undefined,
): ChatConfig {
    const runModel = model ?? config.model;
    if (runModel === config.model && effort === undefined) return config;
    const wanted = effort === undefined ? config.effort : effort;
    // An id the list does not (yet) hold is sent as asked, unchecked.
    const info = runModel ? models?.find(m => m.id === runModel) : resolveModel(models, null);
    const runEffort = !info || wanted == null || info.efforts.includes(wanted) ? wanted : info.defaultEffort;
    return { ...config, model: runModel, effort: runEffort };
}

/**
 * Fold everything a run produced into the one assistant node that records it.
 *
 * The live items are the source — they are what the user watched arrive — and
 * `after` is the user item the run answered, so a chat with several turns
 * commits only the newest one.
 *
 * `segments` keeps them as they were: in order, with their ids and thinking
 * times (StoredSegment). The flat fields are written too, for builds that
 * predate segments and for the transcript a new branch carries.
 */
export function foldRunIntoNode(items: ChatItem[], afterId: string): Partial<ChatNode> {
    const start = items.findIndex(item => item.id === afterId);
    const tail = start < 0 ? items : items.slice(start + 1);
    const text: string[] = [];
    const reasoning: string[] = [];
    const tools: StoredTool[] = [];
    const segments: StoredSegment[] = [];
    let error = false;
    for (const item of tail) {
        if (item.kind === 'assistant') {
            text.push(item.text);
            segments.push({ kind: 'text', id: item.id, text: item.text });
        } else if (item.kind === 'reasoning') {
            reasoning.push(item.text);
            segments.push({
                kind: 'reasoning', id: item.id, text: item.text,
                ...(item.startedAt != null ? { startedAt: item.startedAt } : {}),
                ...(item.endedAt != null ? { endedAt: item.endedAt } : {}),
            });
        } else if (item.kind === 'tool') {
            tools.push({
                callId: item.callId, name: item.name, input: item.input, output: item.output,
                status: item.status === 'error' ? 'error' : 'done', own: item.own,
                ...(item.change ? { change: item.change } : {}),
            });
            segments.push({ kind: 'tool', id: item.id, tool: tools.length - 1 });
        } else if (item.kind === 'notice') {
            segments.push({ kind: 'notice', id: item.id, tone: item.tone, message: item.message });
            if (item.tone === 'error') {
                // A run that ended badly is kept as the turn's text: a branch whose
                // answer failed should say so when it is come back to, not be blank.
                text.push(item.message);
                error = true;
            }
        }
    }
    return {
        text: text.join('\n\n').trim(),
        ...(reasoning.length ? { reasoning: reasoning.join('\n\n') } : {}),
        ...(tools.length ? { tools } : {}),
        ...(error ? { error: true } : {}),
        ...(segments.length ? { segments } : {}),
    };
}

/** How much of a branch's history is replayed into a new CLI session. */
const PREFIX_BUDGET = 40_000;

/**
 * The turns above this message, as text for an agent that has not seen them.
 *
 * A BRANCH IS A NEW CLI SESSION, and it has to be: the session the other
 * version ran in holds the very message the user edited away, and resuming it
 * would have the agent answer with that still in mind. So the kept turns are
 * handed over as a transcript instead. Oldest turns are dropped first when it
 * does not fit, with a line saying so — the recent ones are what the next
 * message is actually about.
 */
export function transcriptPrefix(tree: ChatTree, upTo: string | null): string {
    const path = activePath(tree);
    const end = upTo ? path.findIndex(node => node.id === upTo) : path.length;
    const turns = (end < 0 ? path : path.slice(0, end))
        .filter(node => node.text.trim())
        .map(node => `${node.role === 'user' ? 'User' : 'You'}: ${node.text.trim()}`);
    if (!turns.length) return '';

    const kept: string[] = [];
    let used = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
        if (used + turns[i].length > PREFIX_BUDGET) break;
        used += turns[i].length;
        kept.unshift(turns[i]);
    }
    const dropped = turns.length - kept.length;
    return [
        '<bme-history>',
        'Earlier in this conversation (the user edited a message, so this part of it is being',
        'continued in a new session; answer as though it had all happened here):',
        ...(dropped ? [`[${dropped} older turn${dropped === 1 ? '' : 's'} left out for length]`] : []),
        ...kept,
        '</bme-history>',
        '',
    ].join('\n');
}

/**
 * A straight-line tree from what the CLI remembers.
 *
 * For chats that predate the tree file. Consecutive non-user items fold into
 * the one assistant turn they belonged to, which is the shape the rest of this
 * module expects — and gives the old chat working edit arrows from then on.
 */
export function treeFromItems(items: ChatItem[], sessionId: string | null): ChatTree {
    let tree = emptyTree();
    let pendingUser: string | null = null;
    const flush = (upto: number, from: number) => {
        if (pendingUser === null) return;
        const patch = foldRunIntoNode(items.slice(from, upto), pendingUser);
        tree = appendNode(tree, { id: uid(), role: 'assistant', text: '', createdAt: Date.now(), sessionId, ...patch });
        pendingUser = null;
    };
    let runStart = 0;
    items.forEach((item, index) => {
        if (item.kind !== 'user') return;
        flush(index, runStart);
        tree = appendNode(tree, { id: item.id, role: 'user', text: item.text, createdAt: Date.now(), images: item.imageCount || undefined });
        pendingUser = item.id;
        runStart = index;
    });
    flush(items.length, runStart);
    return tree;
}

function historyToItem(item: HistoryItem): ChatItem {
    switch (item.kind) {
        case 'user': {
            const { words, context } = splitContext(item.text);
            return { kind: 'user', id: uid(), text: words, thumbs: [], imageCount: item.imageCount, context };
        }
        case 'assistant':
            return { kind: 'assistant', id: uid(), text: item.text, streaming: false };
        case 'reasoning':
            return { kind: 'reasoning', id: uid(), text: item.text, streaming: false, startedAt: null, endedAt: null };
        case 'tool':
            return {
                kind: 'tool', id: uid(), callId: uid(), name: item.name, input: item.input,
                status: item.isError ? 'error' : 'done', output: item.output,
                own: /^(mcp__vault__)?(vault|canvas)_/.test(item.name),
            };
    }
}

function revokeThumbs(conversation: Conversation | undefined): void {
    for (const item of conversation?.items ?? []) {
        if (item.kind === 'user') for (const url of item.thumbs) URL.revokeObjectURL(url);
    }
}

/** The panel's one store. */
export const chatStore = new ChatStore();
