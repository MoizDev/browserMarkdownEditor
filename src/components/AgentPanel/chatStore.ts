import { agentBridge, BridgeError, helperReady, isTerminalEvent } from '../../utils/agentBridge';
import type { HelperEvent, HelperInfo } from '../../utils/agentBridge';
import { executeTool } from '../../utils/vaultAgentTools';
import { releaseAgentMatcher } from '../../utils/agentMatcher/client';
import { buildAgentContext, stripAgentContext } from '../../utils/agentContext';
import { getReplyModePref, resolveReplyMode } from '../../utils/agentReplyMode';
import { AGENT_IDS, AGENT_LABELS, MAX_IMAGES_PER_MESSAGE } from '../../../shared/vaultAgentProtocol';
import type {
    AgentEvent, AgentId, AgentStatus, HistoryItem, ModelInfo, RunErrorReason, RunImage, ToolResult,
} from '../../../shared/vaultAgentProtocol';
import type { AgentChange, AgentHost, ChatIndex, ChatMeta } from '../../types/vaultAgent';
import {
    activePath, activeSessionId, append as appendNode, branchFrom, emptyTree, isEmpty,
    selectVersion as selectVersionIn, tagSession, type ChatNode, type ChatTree, type StoredTool,
} from '../../utils/chatTree';
import { readOpenChat, rememberOpenChat } from './openChatMemory';
import { writeJSON } from '../../utils/storage';

export interface PreparedImage {
    id: string;
    mimeType: RunImage['mimeType'];
    data: string;
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
        own: boolean;
        change?: AgentChange;
    }
    | { kind: 'notice'; id: string; tone: 'info' | 'warning' | 'error'; message: string };

export interface Conversation {
    items: ChatItem[];
    tree: ChatTree;
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
    chats: ChatMeta[];
    activeChatId: string | null;
    draft: ChatConfig;
    conversations: Record<string, Conversation>;
    run: RunInfo | null;
    agentsStatus: 'idle' | 'loading' | 'ready' | 'error';
    agents: AgentStatus[];
    models: Partial<Record<AgentId, ModelsEntry>>;
    teaching: Record<string, boolean>;
}

export const DRAFT_KEY = 'draft';

const EMPTY_CONVERSATION: Conversation = { items: [], tree: emptyTree(), history: 'none' };

const CHOICE_KEY = 'vaultAgentChoice';

interface StoredChoice {
    agent: AgentId;
    perAgent: Partial<Record<AgentId, { model: string | null; effort: string | null }>>;
}

function readChoice(): StoredChoice {
    const fallback: StoredChoice = { agent: 'claude', perAgent: {} };
    try {
        const raw = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? 'null') as Partial<StoredChoice> | null;
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
    writeJSON(CHOICE_KEY, current);
}

function draftFor(agent: AgentId): ChatConfig {
    const remembered = readChoice().perAgent[agent];
    return { agent, model: remembered?.model ?? null, effort: remembered?.effort ?? null };
}

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

export function resolveModel(models: ModelInfo[] | undefined, id: string | null): ModelInfo | null {
    if (!models?.length) return null;
    return (id && models.find(m => m.id === id)) || models.find(m => m.isDefault) || null;
}

export function activeChatOf(state: ChatStoreState): ChatMeta | null {
    const id = state.activeChatId;
    return id ? state.chats.find(c => c.id === id) ?? null : null;
}

export function configOf(state: ChatStoreState): ChatConfig {
    const chat = activeChatOf(state);
    return chat ? { agent: chat.agent, model: chat.model, effort: chat.effort } : state.draft;
}

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
    private runUserNode: { key: string; nodeId: string } | null = null;
    private runVaultToken: object | null = null;
    private runAbort: AbortController | null = null;
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
    private readonly mirrorHashes = new Map<string, string>();
    private indexLoadSeq = 0;
    private lastHelper: HelperInfo | null = null;

    constructor() {
        const offEvents = agentBridge.subscribe(event => this.onHelperEvent(event));
        const offState = agentBridge.subscribeState(() => this.onBridgeState());
        this.onBridgeState();
        // Dev only: a hot update re-runs this module and builds a second
        // store. Both listening would answer every tool.call TWICE — a
        // doubled edit in the user's note — so the old one lets go first.
        import.meta.hot?.dispose(() => { offEvents(); offState(); });
    }

    getState = (): ChatStoreState => this.state;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    private set(patch: Partial<ChatStoreState>): void {
        this.state = { ...this.state, ...patch };
        if (this.notifyFrame) return;
        const fire = () => {
            this.notifyFrame = 0;
            for (const listener of this.listeners) listener();
        };
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

    attach(host: AgentHost, vault: { key: string; name: string } | null): void {
        this.host = host;
        const key = vault?.key ?? null;
        if (key === this.state.vaultKey) return;
        this.indexVaultToken = host.toolHost.vaultToken();
        if (this.state.run) this.abandonRun('The vault changed, so the agent was stopped.');
        releaseAgentMatcher();
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
            if (!this.state.activeChatId) {
                const remembered = readOpenChat(vaultKey);
                if (remembered && this.state.chats.some(c => c.id === remembered)) this.openChat(remembered);
            }
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
        if (vaultKey !== this.state.vaultKey) return;
        this.set({ chats: [...next.chats].sort(byRecent) });
    }

    private patchChat(id: string, patch: Partial<ChatMeta>): Promise<void> {
        return this.writeIndex(index => !index.chats.some(c => c.id === id) ? index : {
            ...index,
            chats: index.chats.map(c => c.id === id ? { ...c, ...patch } : c),
        });
    }

    private onBridgeState(): void {
        const helper = readyHelper();
        const was = this.lastHelper;
        this.lastHelper = helper;
        if (helper && helper !== was) {
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

    activeChat(): ChatMeta | null {
        return activeChatOf(this.state);
    }

    config(): ChatConfig {
        return configOf(this.state);
    }

    conversationKey(): string {
        return this.state.activeChatId ?? DRAFT_KEY;
    }

    selectAgent(agent: AgentId): void {
        const draft = draftFor(agent);
        writeChoice(draft);
        const conversations = { ...this.state.conversations };
        delete conversations[DRAFT_KEY];
        const teaching = { ...this.state.teaching };
        delete teaching[DRAFT_KEY];
        this.set({ draft, activeChatId: null, conversations, teaching });
        rememberOpenChat(this.state.vaultKey, null);
        void this.ensureModels(agent);
    }

    private setTeaching(key: string, on: boolean): void {
        if (!!this.state.teaching[key] === on) return;
        const teaching = { ...this.state.teaching };
        if (on) teaching[key] = true; else delete teaching[key];
        this.set({ teaching });
    }

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
        rememberOpenChat(this.state.vaultKey, id);
        void this.ensureModels(chat.agent);
        const conversation = this.state.conversations[id];
        if (!conversation || conversation.history === 'error') void this.loadHistory(chat);
    }

    async loadHistory(chat: ChatMeta): Promise<void> {
        const host = this.host;
        if (!host) {
            this.setConversation(chat.id, { ...EMPTY_CONVERSATION, history: 'loaded' });
            return;
        }
        this.setConversation(chat.id, { ...this.conversation(chat.id), items: [], history: 'loading' });

        const tree = await host.readChatTree(chat.id);
        if (this.conversation(chat.id).history !== 'loading') return;
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

    editMessage(nodeId: string, text: string): void {
        const trimmed = text.trim();
        const node = this.conversation(this.conversationKey()).tree.nodes[nodeId];
        if (!trimmed || !node || node.role !== 'user' || this.state.run) return;
        if (trimmed === node.text.trim()) return;
        void this.send(trimmed, [], nodeId);
    }

    selectVersionAt(nodeId: string, index: number): void {
        const tree = this.conversation(this.conversationKey()).tree;
        const node = tree.nodes[nodeId];
        if (!node) return;
        const siblings = tree.children[node.parent ?? ''] ?? [];
        const target = siblings[index];
        if (target) this.selectVersion(target);
    }

    selectVersion(nodeId: string): void {
        const key = this.conversationKey();
        const conversation = this.conversation(key);
        const tree = selectVersionIn(conversation.tree, nodeId);
        if (tree === conversation.tree) return;
        this.setConversation(key, { ...conversation, tree, items: itemsFromTree(tree), history: 'loaded' });
        this.persistTree(key, tree);
    }

    private persistTree(key: string, tree: ChatTree): void {
        if (key === DRAFT_KEY || !this.host) return;
        void this.host.writeChatTree(key, tree);
    }

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
                const message = e instanceof BridgeError ? e.message : String(e);
                this.notice(this.conversationKey(), 'error', `Couldn't delete “${chat.title}”: ${message}`);
                return;
            }
        }
        await this.writeIndex(index => ({ ...index, chats: index.chats.filter(c => c.id !== id) }));
        await host.deleteChatTree(id).catch(() => {});
        const conversations = { ...this.state.conversations };
        revokeThumbs(conversations[id]);
        delete conversations[id];
        const teaching = { ...this.state.teaching };
        delete teaching[id];
        if (readOpenChat(this.state.vaultKey) === id) rememberOpenChat(this.state.vaultKey, null);
        this.set({
            conversations,
            teaching,
            activeChatId: this.state.activeChatId === id ? null : this.state.activeChatId,
        });
    }

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

    async send(text: string, images: PreparedImage[], editOf?: string): Promise<void> {
        const host = this.host;
        if (!host || !this.state.vaultKey || this.state.run || !helperReady(agentBridge.getState())) return;
        const config = this.config();
        const existing = this.activeChat();
        const runId = uid();
        let key = this.conversationKey();

        const userItemId = uid();
        const before = this.conversation(key);
        const tree = editOf
            ? branchFrom(before.tree, editOf, { id: userItemId, text, createdAt: Date.now(), images: images.length || undefined })
            : appendNode(before.tree, { id: userItemId, role: 'user', text, createdAt: Date.now(), images: images.length || undefined });
        this.setConversation(key, {
            ...before,
            tree,
            history: 'loaded',
            items: [
                ...itemsFromTree(tree).slice(0, -1),
                { kind: 'user', id: userItemId, text, thumbs: images.map(i => i.url), imageCount: images.length, context: null },
            ],
        });
        const mode = resolveReplyMode(getReplyModePref(), text, !!this.state.teaching[key]);
        this.setTeaching(key, mode === 'teach');

        this.runVaultToken = host.toolHost.vaultToken();
        this.runAbort = new AbortController();
        this.runImageHash = null;
        this.releaseRun = agentBridge.retain();
        this.set({ run: { runId, chatId: existing?.id ?? DRAFT_KEY, phase: 'preparing', startedAt: Date.now() } });
        const stillOurs = () => this.state.run?.runId === runId && this.state.run.phase !== 'stopping';

        try {
            const vaultUuid = await host.ensureVaultUuid();
            if (!vaultUuid) throw new Error("Couldn't create the vault's .VaultAgent folder, so the agent has nowhere to keep its chats.");
            if (!stillOurs()) return;

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
                rememberOpenChat(this.state.vaultKey, created.id);
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
                if (context.image && runImages.length < MAX_IMAGES_PER_MESSAGE) {
                    runImages.unshift({ mimeType: context.image.mimeType, data: context.image.data });
                    this.runImageHash = context.image.hash;
                }
            } else if (images.length) {
                this.notice(key, 'warning', `${model?.label ?? 'This model'} can't see images, so ${images.length === 1 ? 'the image was' : 'the images were'} left out.`);
            }

            if (import.meta.env.DEV) {
                this.updateItems(key, items => items.map(item =>
                    item.id === userItemId && item.kind === 'user' ? { ...item, context: context.text.trim() || null } : item));
            }

            const shown = this.conversation(key);
            const sessionId = activeSessionId(shown.tree);
            const prefix = sessionId ? '' : transcriptPrefix(shown.tree, userItemId);
            const branchTree = sessionId ? tagSession(shown.tree, userItemId, sessionId) : shown.tree;
            if (branchTree !== shown.tree) this.setConversation(key, { ...shown, tree: branchTree });
            this.runUserNode = { key, nodeId: userItemId };
            this.persistTree(key, branchTree);

            await agentBridge.request('run.start', {
                runId,
                vaultId: vaultUuid,
                agent: config.agent,
                sessionId,
                model: config.model,
                effort: config.effort,
                text: context.text + prefix + text,
                images: runImages,
            });
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
        this.runAbort?.abort();
        if (run.phase === 'preparing') {
            this.finishRun(run.chatId);
            this.notice(run.chatId, 'info', 'Stopped.');
            return;
        }
        this.set({ run: { ...run, phase: 'stopping' } });
        try {
            await agentBridge.request('run.cancel', { runId: run.runId }, 10_000);
        } catch {
            if (this.state.run?.runId === run.runId) {
                this.finishRun(run.chatId);
                this.notice(run.chatId, 'info', 'Stopped.');
            }
        }
    }

    private abandonRun(message: string): void {
        const run = this.state.run;
        if (!run) return;
        if (agentBridge.getState().status === 'connected' && run.phase !== 'preparing') {
            agentBridge.request('run.cancel', { runId: run.runId }).catch(() => {});
        }
        this.finishRun(run.chatId);
        this.notice(run.chatId, 'warning', message);
    }

    private finishRun(key: string): void {
        this.runAbort?.abort();
        this.runAbort = null;
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

    private commitRun(key: string, sessionId: string | null): void {
        const pending = this.runUserNode;
        this.runUserNode = null;
        if (!pending || pending.key !== key) return;
        const conversation = this.conversation(key);
        if (!conversation.tree.nodes[pending.nodeId]) return;

        const patch = foldRunIntoNode(conversation.items, pending.nodeId);
        const empty = !patch.text && !patch.tools?.length && !patch.reasoning;
        let tree = sessionId ? tagSession(conversation.tree, pending.nodeId, sessionId) : conversation.tree;
        if (!empty) {
            tree = appendNode(tree, {
                id: uid(), role: 'assistant', text: '', createdAt: Date.now(),
                ...(sessionId ? { sessionId } : {}),
                ...patch,
            });
        }
        this.setConversation(key, { ...conversation, tree });
        this.persistTree(key, tree);
    }

    private onHelperEvent(event: HelperEvent): void {
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
            this.commitRun(key, event.sessionId ?? null);
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
        this.finishRun(key);
        this.commitRun(key, null);
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
                const pending = this.runUserNode;
                if (pending?.key === key) {
                    const conversation = this.conversation(key);
                    const tree = tagSession(conversation.tree, pending.nodeId, event.sessionId);
                    if (tree !== conversation.tree) {
                        this.setConversation(key, { ...conversation, tree });
                        this.persistTree(key, tree);
                    }
                }
                const chat = this.state.chats.find(c => c.id === key);
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
            const bridge = agentBridge.getState();
            const execution = await executeTool(call.name, call.args, host.toolHost, { vaultToken: this.runVaultToken,
                signal: this.runAbort?.signal, helperVersion: helperReady(bridge) ? bridge.helper.version : undefined });
            result = execution.result;
            change = execution.change;
        } catch (e) {
            result = { content: [{ type: 'text', text: `The editor failed to run ${call.name}: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
        if (this.state.run?.runId === call.runId) reply(result);
        const output = resultText(result);
        this.updateItems(key, items => items.map(item =>
            item.id === itemId && item.kind === 'tool'
                ? { ...item, status: result.isError ? 'error' as const : 'done' as const, output, change }
                : item));
    }

    onUninstalled(): void {
        if (this.state.run) this.finishRun(this.state.run.chatId);
        releaseAgentMatcher();
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

function endAssistant(items: ChatItem[]): ChatItem[] {
    const last = items[items.length - 1];
    if (last?.kind === 'assistant' && last.streaming) {
        return [...items.slice(0, -1), { ...last, streaming: false }];
    }
    return items;
}

export function itemsFromTree(tree: ChatTree): ChatItem[] {
    const items: ChatItem[] = [];
    for (const node of activePath(tree)) {
        if (node.role === 'user') {
            items.push({
                kind: 'user', id: node.id, text: node.text,
                thumbs: [], imageCount: node.images ?? 0, context: null,
            });
            continue;
        }
        if (node.reasoning) {
            items.push({ kind: 'reasoning', id: `${node.id}:think`, text: node.reasoning, streaming: false, startedAt: null, endedAt: null });
        }
        for (const tool of node.tools ?? []) {
            items.push({
                kind: 'tool', id: `${node.id}:${tool.callId}`, callId: tool.callId, name: tool.name,
                input: tool.input, status: tool.status, output: tool.output, own: tool.own,
                ...(tool.change ? { change: tool.change as AgentChange } : {}),
            });
        }
        if (node.text || !node.tools?.length) {
            items.push(node.error
                ? { kind: 'notice', id: node.id, tone: 'error', message: node.text }
                : { kind: 'assistant', id: node.id, text: node.text, streaming: false });
        }
    }
    return items;
}

export function foldRunIntoNode(items: ChatItem[], afterId: string): Partial<ChatNode> {
    const start = items.findIndex(item => item.id === afterId);
    const tail = start < 0 ? items : items.slice(start + 1);
    const text: string[] = [];
    const reasoning: string[] = [];
    const tools: StoredTool[] = [];
    let error = false;
    for (const item of tail) {
        if (item.kind === 'assistant') text.push(item.text);
        else if (item.kind === 'reasoning') reasoning.push(item.text);
        else if (item.kind === 'tool') {
            tools.push({
                callId: item.callId, name: item.name, input: item.input, output: item.output,
                status: item.status === 'error' ? 'error' : 'done', own: item.own,
                ...(item.change ? { change: item.change } : {}),
            });
        } else if (item.kind === 'notice' && item.tone === 'error') {
            text.push(item.message);
            error = true;
        }
    }
    return {
        text: text.join('\n\n').trim(),
        ...(reasoning.length ? { reasoning: reasoning.join('\n\n') } : {}),
        ...(tools.length ? { tools } : {}),
        ...(error ? { error: true } : {}),
    };
}

const PREFIX_BUDGET = 40_000;

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

export const chatStore = new ChatStore();
