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
    | { kind: 'assistant'; id: string; text: string; streaming: boolean }
    | { kind: 'reasoning'; id: string; text: string; streaming: boolean; startedAt: number | null; endedAt: number | null }
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
    items: ChatItem[];
    /** Where the transcript came from: this session, or the CLI's own store. */
    history: 'none' | 'loading' | 'loaded' | 'missing' | 'error';
    historyError?: string;
}

export interface RunInfo {
    runId: string;
    chatId: string;
    phase: 'preparing' | 'running' | 'stopping';
    startedAt: number;
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

const EMPTY_CONVERSATION: Conversation = { items: [], history: 'none' };

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

class ChatStore {
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
        // Dev only: a hot update re-runs this module and builds a second
        // store. Both listening would answer every tool.call TWICE — a
        // doubled edit in the user's note — so the old one lets go first.
        import.meta.hot?.dispose(() => { offEvents(); offState(); });
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
     * executor also refuses by token) and starts the index over.
     */
    attach(host: AgentHost, vault: { key: string; name: string } | null): void {
        this.host = host;
        const key = vault?.key ?? null;
        if (key === this.state.vaultKey) return;
        this.indexVaultToken = host.toolHost.vaultToken();
        if (this.state.run) this.abandonRun('The vault changed, so the agent was stopped.');
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
        } catch (e) {
            if (seq !== this.indexLoadSeq) return;
            this.set({ indexStatus: 'error', indexError: e instanceof Error ? e.message : String(e) });
        }
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
                : 'Lost the connection to VaultAgent, so the reply stopped.');
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
        void this.ensureModels(chat.agent);
        const conversation = this.state.conversations[id];
        if (!conversation || conversation.history === 'error') void this.loadHistory(chat);
    }

    async loadHistory(chat: ChatMeta): Promise<void> {
        const host = this.host;
        if (!chat.sessionId || !host) {
            this.setConversation(chat.id, { items: [], history: 'loaded' });
            return;
        }
        if (!helperReady(agentBridge.getState())) return;
        this.setConversation(chat.id, { items: [], history: 'loading' });
        try {
            const vaultId = await host.ensureVaultUuid();
            if (!vaultId) throw new Error('This vault has no agent id yet.');
            const history = await agentBridge.request('session.history', { vaultId, agent: chat.agent, sessionId: chat.sessionId });
            // A run may have started on this chat while the history loaded.
            if (this.conversation(chat.id).history !== 'loading') return;
            if (!history.found) {
                this.setConversation(chat.id, { items: [], history: 'missing' });
                return;
            }
            this.setConversation(chat.id, { items: history.items.map(historyToItem), history: 'loaded' });
        } catch (e) {
            this.setConversation(chat.id, {
                items: [],
                history: 'error',
                historyError: e instanceof Error ? e.message : String(e),
            });
        }
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
        const conversations = { ...this.state.conversations };
        revokeThumbs(conversations[id]);
        delete conversations[id];
        const teaching = { ...this.state.teaching };
        delete teaching[id];
        this.set({
            conversations,
            teaching,
            activeChatId: this.state.activeChatId === id ? null : this.state.activeChatId,
        });
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
    async send(text: string, images: PreparedImage[]): Promise<void> {
        const host = this.host;
        if (!host || !this.state.vaultKey || this.state.run || !helperReady(agentBridge.getState())) return;
        const config = this.config();
        const existing = this.activeChat();
        const runId = uid();
        let key = this.conversationKey();

        // Shown at once; everything below is async and may take a moment
        // (the mirror read, the canvas capture).
        const userItemId = uid();
        this.pushItem(key, {
            kind: 'user', id: userItemId, text,
            thumbs: images.map(i => i.url), imageCount: images.length, context: null,
        });
        // Decided here, from the words just typed, not by the model: the cap in
        // the composer lights on this same answer (see utils/agentReplyMode.ts).
        const mode = resolveReplyMode(getReplyModePref(), text, !!this.state.teaching[key]);
        this.setTeaching(key, mode === 'teach');

        this.runVaultToken = host.toolHost.vaultToken();
        this.runImageHash = null;
        this.releaseRun = agentBridge.retain();
        this.set({ run: { runId, chatId: existing?.id ?? DRAFT_KEY, phase: 'preparing', startedAt: Date.now() } });
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
                await this.writeIndex(index => ({ ...index, chats: [...index.chats.filter(c => c.id !== created.id), created] }));
                if (!stillOurs()) return;
            }

            await this.syncMirror(host, vaultUuid);
            if (!stillOurs()) return;

            const model = resolveModel(this.state.models[config.agent]?.models, config.model);
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

            await agentBridge.request('run.start', {
                runId,
                vaultId: vaultUuid,
                agent: config.agent,
                sessionId: chat.sessionId,
                model: config.model,
                effort: config.effort,
                text: context.text + text,
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
                if (now?.runId === runId) this.finishRun(key);
                return;
            }
            const message = e instanceof Error ? e.message : String(e);
            this.finishRun(key);
            this.notice(key, 'error', message);
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
            this.finishRun(run.chatId);
            this.notice(run.chatId, 'info', 'Stopped.');
            return;
        }
        this.set({ run: { ...run, phase: 'stopping' } });
        try {
            await agentBridge.request('run.cancel', { runId: run.runId }, 10_000);
        } catch {
            // The helper is gone or the run already ended; either way it is over.
            if (this.state.run?.runId === run.runId) {
                this.finishRun(run.chatId);
                this.notice(run.chatId, 'info', 'Stopped.');
            }
        }
    }

    /** Stop listening to a run without waiting for the helper (vault switch,
     *  lost connection). Its late events are ignored by runId. */
    private abandonRun(message: string): void {
        const run = this.state.run;
        if (!run) return;
        if (agentBridge.getState().status === 'connected' && run.phase !== 'preparing') {
            agentBridge.request('run.cancel', { runId: run.runId }).catch(() => {});
        }
        this.finishRun(run.chatId);
        this.notice(run.chatId, 'warning', message);
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
        this.releaseRun?.();
        this.releaseRun = null;
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
            this.finishRun(key);
            if (event.status === 'cancelled') this.notice(key, 'info', 'Stopped.');
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
        this.finishRun(key);
        const agent = chat?.agent ?? this.config().agent;
        this.notice(key, event.reason === 'cancelled' ? 'info' : 'error', runErrorMessage(event.reason, event.message, agent));
        if (event.reason === 'agent-missing' || event.reason === 'logged-out' || event.reason === 'agent-changed') {
            void this.refreshAgents(true);
        }
        if (chat) void this.patchChat(chat.id, { updatedAt: Date.now() }).catch(() => {});
    }

    private onAgentEvent(key: string, run: RunInfo, event: AgentEvent): void {
        if (run.phase === 'preparing') this.set({ run: { ...run, phase: 'running' } });
        switch (event.type) {
            case 'session': {
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
                    return [...closed, { kind: 'assistant', id: uid(), text: event.text, streaming: true }];
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
            this.abandonRun('The vault changed, so the agent was stopped.');
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
