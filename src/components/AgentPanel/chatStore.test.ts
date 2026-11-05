// How a branching transcript becomes what the panel draws, and how a finished
// run becomes one turn in it — plus the store's chat actions, driven against a
// fake host and a stubbed bridge. What any of it LOOKS like is verified in a
// browser (the verify-in-browser skill).

import { describe, expect, test } from 'bun:test';
import {
    ChatStore, foldRunIntoNode, itemsFromTree, keepIdentity, reasoningDurationMs, transcriptPrefix, treeFromItems,
} from './chatStore';
import type { ChatItem } from './chatStore';
import {
    activePath, append, branchFrom, emptyTree, parseTree, serializeTree, versionOf, type ChatTree,
} from '../../utils/chatTree';
import { parseChatIndex, serializeChatIndex } from '../../utils/vaultAgentStore';
import { agentBridge } from '../../utils/agentBridge';
import type { AgentHost, ChatIndex } from '../../types/vaultAgent';

const say = (t: ChatTree, role: 'user' | 'assistant', text: string, id: string, extra: Record<string, unknown> = {}) =>
    append(t, { id, role, text, createdAt: 1, ...extra });

describe('what the panel draws from a tree', () => {
    test('a turn with thinking and tools comes back in the order it streamed', () => {
        let t = emptyTree();
        t = say(t, 'user', 'do it', 'u1', { images: 2 });
        t = say(t, 'assistant', 'done', 'a1', {
            reasoning: 'thinking…',
            tools: [{ callId: 'c1', name: 'vault_edit', status: 'done', own: true, output: 'ok' }],
        });
        const items = itemsFromTree(t);
        expect(items.map(i => i.kind)).toEqual(['user', 'reasoning', 'tool', 'assistant']);
        expect(items[0]).toMatchObject({ imageCount: 2, thumbs: [] });   // object URLs die with the page
        expect(items[2]).toMatchObject({ name: 'vault_edit' });
        expect(items[3]).toMatchObject({ streaming: false });
    });

    test('a failed turn comes back as the error it was', () => {
        let t = emptyTree();
        t = say(t, 'user', 'q', 'u1');
        t = say(t, 'assistant', 'Claude Code is not installed.', 'a1', { error: true });
        const items = itemsFromTree(t);
        expect(items[1]).toMatchObject({ kind: 'notice', tone: 'error', message: 'Claude Code is not installed.' });
    });

    test('only the branch on screen is drawn', () => {
        let t = emptyTree();
        t = say(t, 'user', 'cats', 'u1');
        t = say(t, 'assistant', 'cats are…', 'a1');
        t = branchFrom(t, 'u1', { id: 'u1b', text: 'dogs', createdAt: 2 });
        expect(itemsFromTree(t).map(i => ('text' in i ? i.text : ''))).toEqual(['dogs']);
    });
});

describe('folding a finished run into one turn', () => {
    test('takes only what came after the message it answered', () => {
        const items: ChatItem[] = [
            { kind: 'user', id: 'old', text: 'before', thumbs: [], imageCount: 0, context: null },
            { kind: 'assistant', id: 'x', text: 'old reply', streaming: false },
            { kind: 'user', id: 'u1', text: 'now', thumbs: [], imageCount: 0, context: null },
            { kind: 'reasoning', id: 'r', text: 'hmm', streaming: false, startedAt: null, endedAt: null },
            { kind: 'tool', id: 't', callId: 'c1', name: 'vault_read', input: {}, status: 'done', own: true, output: 'file' },
            { kind: 'assistant', id: 'a', text: 'new reply', streaming: false },
        ];
        const patch = foldRunIntoNode(items, 'u1');
        expect(patch.text).toBe('new reply');
        expect(patch.reasoning).toBe('hmm');
        expect(patch.tools).toHaveLength(1);
        expect(patch.tools?.[0]).toMatchObject({ name: 'vault_read', status: 'done', own: true });
        expect(patch.error).toBeUndefined();
    });

    test('an error notice becomes the turn, and is marked as one', () => {
        const items: ChatItem[] = [
            { kind: 'user', id: 'u1', text: 'go', thumbs: [], imageCount: 0, context: null },
            { kind: 'notice', id: 'n', tone: 'error', message: 'Claude Code is not logged in.' },
        ];
        const patch = foldRunIntoNode(items, 'u1');
        expect(patch).toMatchObject({ text: 'Claude Code is not logged in.', error: true });
    });
});

describe('the transcript a new branch carries', () => {
    test('is the turns above the edited message, and nothing below', () => {
        let t = emptyTree();
        t = say(t, 'user', 'first', 'u1');
        t = say(t, 'assistant', 'answer one', 'a1');
        t = say(t, 'user', 'second', 'u2');
        t = say(t, 'assistant', 'answer two', 'a2');
        t = branchFrom(t, 'u2', { id: 'u2b', text: 'second, but different', createdAt: 9 });
        const prefix = transcriptPrefix(t, 'u2b');
        expect(prefix).toContain('User: first');
        expect(prefix).toContain('You: answer one');
        expect(prefix).not.toContain('answer two');          // that branch is not this one
        expect(prefix).not.toContain('second, but different'); // the message itself follows it
        expect(prefix.startsWith('<bme-history>')).toBe(true);
    });

    test('is empty for the first message of a chat', () => {
        let t = emptyTree();
        t = say(t, 'user', 'hello', 'u1');
        expect(transcriptPrefix(t, 'u1')).toBe('');
    });

    test('drops the oldest turns when it will not fit, and says so', () => {
        let t = emptyTree();
        for (let i = 0; i < 60; i++) {
            t = say(t, 'user', `question ${i} ` + 'x'.repeat(800), `u${i}`);
            t = say(t, 'assistant', `answer ${i} ` + 'y'.repeat(800), `a${i}`);
        }
        t = say(t, 'user', 'last', 'last');
        const prefix = transcriptPrefix(t, 'last');
        expect(prefix.length).toBeLessThan(45_000);
        expect(prefix).toContain('older turns left out for length');
        expect(prefix).toContain('answer 59');      // the recent ones are kept
        expect(prefix).not.toContain('question 0 '); // the oldest are what goes
    });
});

describe('an old chat, read back from the CLI', () => {
    test('becomes a straight line that can then be branched', () => {
        const items: ChatItem[] = [
            { kind: 'user', id: 'u1', text: 'hi', thumbs: [], imageCount: 0, context: null },
            { kind: 'reasoning', id: 'r', text: 'thinking', streaming: false, startedAt: null, endedAt: null },
            { kind: 'assistant', id: 'a', text: 'hello', streaming: false },
            { kind: 'user', id: 'u2', text: 'more', thumbs: [], imageCount: 0, context: null },
            { kind: 'assistant', id: 'a2', text: 'sure', streaming: false },
        ];
        const t = treeFromItems(items, 'sess-9');
        const path = activePath(t);
        expect(path.map(n => `${n.role[0]}:${n.text}`)).toEqual(['u:hi', 'a:hello', 'u:more', 'a:sure']);
        expect(path[1].reasoning).toBe('thinking');
        expect(path[1].sessionId).toBe('sess-9');
        // and the user ids survive, so the edit buttons address the right message
        expect(path[0].id).toBe('u1');
    });
});

/* ───────────── transcript fidelity: a turn reads the same after the next message ───────────── */

const user = (id: string, text: string): ChatItem => ({ kind: 'user', id, text, thumbs: [], imageCount: 0, context: null });

/** The thesis turn as it streams: think, three steps, text, an edit, text. */
function thesisRun(): ChatItem[] {
    return [
        user('u1', 'summarize and tighten'),
        { kind: 'reasoning', id: 'r1', text: 'plan', streaming: false, startedAt: 1_000, endedAt: 4_200 },
        { kind: 'tool', id: 't1', callId: 'c1', name: 'vault_read', input: { path: 'a.md' }, status: 'done', own: true, output: 'x' },
        { kind: 'tool', id: 't2', callId: 'c2', name: 'vault_search', input: { query: 'q' }, status: 'done', own: true, output: 'y' },
        { kind: 'tool', id: 't3', callId: 'c3', name: 'Grep', input: { pattern: 'p' }, status: 'error', own: false, output: 'z' },
        { kind: 'assistant', id: 'a1', text: 'The outline is fine. I will tighten it.', streaming: false, model: 'opus' },
        {
            kind: 'tool', id: 't4', callId: 'c4', name: 'vault_edit', input: {}, status: 'done', own: true, output: 'ok',
            change: { kind: 'edit', path: 'a.md', added: 1, removed: 1, diff: [] },
        },
        { kind: 'assistant', id: 'a2', text: 'Done.', streaming: false, model: 'opus' },
        { kind: 'notice', id: 'n1', tone: 'info', message: 'Stopped.' },
    ];
}

function committed(items: ChatItem[]): ChatTree {
    let t = emptyTree();
    t = append(t, { id: 'u1', role: 'user', text: 'summarize and tighten', createdAt: 1 });
    return append(t, { id: 'node-a', role: 'assistant', text: '', createdAt: 2, model: 'opus', ...foldRunIntoNode(items, 'u1') });
}

describe('a turn folded into the tree comes back exactly as it streamed', () => {
    test('same order, same ids, same thinking time — through the file and back', () => {
        const live = thesisRun();
        const tree = parseTree(serializeTree(committed(live)));
        expect(itemsFromTree(tree)).toEqual(live);
        const thought = itemsFromTree(tree)[1];
        expect(thought.kind === 'reasoning' && reasoningDurationMs(thought)).toBe(3_200);
    });

    test('the flat fields are still written, for builds that predate segments', () => {
        const node = activePath(committed(thesisRun()))[1];
        expect(node.text).toBe('The outline is fine. I will tighten it.\n\nDone.');
        expect(node.reasoning).toBe('plan');
        expect(node.tools?.map(t => t.callId)).toEqual(['c1', 'c2', 'c3', 'c4']);
        // tools are referenced, not copied
        expect(node.segments?.flatMap(s => s.kind === 'tool' ? [s.tool] : [])).toEqual([0, 1, 2, 3]);
    });

    test('keepIdentity hands back the very objects that were on screen', () => {
        const live = thesisRun();
        const kept = keepIdentity(itemsFromTree(committed(live)), live);
        kept.forEach((item, i) => expect(item).toBe(live[i]));
    });

    test('a tree file written before segments still loads, in the old order', () => {
        const legacy = JSON.stringify({
            version: 1, activeLeaf: 'a1', children: { '': ['u1'], u1: ['a1'] },
            nodes: {
                u1: { id: 'u1', parent: null, role: 'user', text: 'q', createdAt: 1 },
                a1: {
                    id: 'a1', parent: 'u1', role: 'assistant', text: 'answer', createdAt: 2, sessionId: 's',
                    reasoning: 'hm', tools: [{ callId: 'c1', name: 'vault_read', status: 'done', own: true }],
                },
            },
        });
        const items = itemsFromTree(parseTree(legacy));
        expect(items.map(i => `${i.kind}:${i.id}`)).toEqual(['user:u1', 'reasoning:a1:think', 'tool:a1:c1', 'assistant:a1']);
        expect(items[1]).toMatchObject({ startedAt: null, endedAt: null });
    });

    test('a segment list this build cannot trust falls back to the flat fields, whole', () => {
        const raw = JSON.parse(serializeTree(committed(thesisRun())));
        raw.nodes['node-a'].segments.push({ kind: 'tool', id: 'bad', tool: 99 });
        raw.nodes['node-a'].mystery = { from: 'a newer build' };
        const parsed = parseTree(JSON.stringify(raw));
        expect(parsed.nodes['node-a'].segments).toBeUndefined();
        expect(itemsFromTree(parsed).map(i => i.kind)).toEqual(['user', 'reasoning', 'tool', 'tool', 'tool', 'tool', 'assistant']);
        // and a key it does not know is carried through a rewrite
        expect(JSON.parse(serializeTree(parsed)).nodes['node-a'].mystery).toEqual({ from: 'a newer build' });
    });

    test('a chat read back from the CLI keeps its item ids in the tree it becomes', () => {
        const items: ChatItem[] = [
            user('u1', 'hi'),
            { kind: 'tool', id: 'h1', callId: 'h1c', name: 'Read', input: {}, status: 'done', own: false },
            { kind: 'assistant', id: 'h2', text: 'hello', streaming: false },
        ];
        expect(itemsFromTree(treeFromItems(items, 's'))).toEqual(items);
    });
});

/* ───────────── the store: retry, rename, star ───────────── */

// The store is a browser module: set() schedules its notification on a
// frame, which a hidden document turns into a timer.
const g = globalThis as Record<string, unknown>;
g.document ??= { hidden: true };
g.window ??= globalThis;
// Bun has no localStorage; the store remembers each vault's open chat in it.
const stored = new Map<string, string>();
g.localStorage ??= {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => { stored.set(k, String(v)); },
    removeItem: (k: string) => { stored.delete(k); },
};

const MODELS = [
    { id: 'opus', label: 'Opus', efforts: ['high', 'max'], defaultEffort: 'high', images: true, isDefault: true },
    { id: 'haiku', label: 'Haiku', efforts: [], defaultEffort: null, images: true },
];

const requests: { name: string; params: Record<string, unknown> }[] = [];
const bridge = agentBridge as unknown as Record<string, unknown>;
bridge.getState = () => ({ status: 'connected', helper: { outdated: false }, update: { status: 'none' } });
bridge.retain = () => () => {};
bridge.request = async (name: string, params: Record<string, unknown>) => {
    requests.push({ name, params });
    if (name === 'agents.status') return [{ agent: 'claude', installed: true, loggedIn: true, version: '1', loginCommand: '', installCommand: '' }];
    if (name === 'models.list') return MODELS;
    return {};
};

const settle = () => new Promise(resolve => setTimeout(resolve, 5));

function fakeHost(indexText: string) {
    const trees = new Map<string, ChatTree>();
    const token = {};
    const file = { index: indexText };
    const host = {
        toolHost: { vaultToken: () => token },
        workspace: () => null,
        ensureVaultUuid: async () => '00000000-0000-4000-8000-000000000001',
        readChatIndex: async () => parseChatIndex(file.index),
        readChatTree: async (id: string) => trees.get(id) ?? emptyTree(),
        writeChatTree: async (id: string, tree: ChatTree) => { trees.set(id, parseTree(serializeTree(tree))); },
        deleteChatTree: async (id: string) => { trees.delete(id); },
        updateChatIndex: async (update: (index: ChatIndex) => ChatIndex) => {
            const next = update(parseChatIndex(file.index));
            file.index = serializeChatIndex(next);
            return next;
        },
        collectMirrorFiles: async () => [],
        ask: async () => true,
        notify: () => {},
        openFile: () => {},
    } as unknown as AgentHost;
    return { host, trees, file };
}

async function storeWithChat(indexText = JSON.stringify({ version: 1, chats: [] })) {
    const { host, trees, file } = fakeHost(indexText);
    const store = new ChatStore();
    store.attach(host, { key: 'vault-1', name: 'Vault' });
    await settle();
    return { store, trees, file };
}

/** Deliver what the helper would send for the run in flight. */
function helperSays(store: ChatStore, event: Record<string, unknown>) {
    const runId = store.getState().run!.runId;
    (store as unknown as { onHelperEvent(e: unknown): void }).onHelperEvent({ runId, ...event });
}

async function answer(store: ChatStore, text: string) {
    if (text) helperSays(store, { type: 'run.event', event: { type: 'text-delta', text } });
    helperSays(store, { type: 'run.done', status: 'ok', sessionId: 'sess-1' });
    await settle();
}

describe('Retry', () => {
    test('asks the same words again as a new version, on the model picked, once', async () => {
        const { store } = await storeWithChat();
        await store.send('what is a CRDT?', []);
        await answer(store, 'A data type that merges.');
        const chatId = store.getState().activeChatId!;
        const firstUser = store.lastUserItemId()!;
        // the CLI default, named by its id
        expect(store.getState().conversations[chatId].items[1]).toMatchObject({ kind: 'assistant', model: 'opus' });

        requests.length = 0;
        store.retry(firstUser, 'haiku');
        await settle();
        expect(requests.find(r => r.name === 'run.start')!.params).toMatchObject({ model: 'haiku', effort: null });
        expect(store.getState().chats[0].model).toBeNull();   // the chat's own choice is untouched

        const tree = store.getState().conversations[chatId].tree;
        const second = store.lastUserItemId()!;
        expect(second).not.toBe(firstUser);
        expect(versionOf(tree, second)).toEqual({ index: 1, count: 2 });
        expect(tree.nodes[second].text).toBe('what is a CRDT?');

        // refused while that run is live
        store.retry(second);
        await settle();
        expect(versionOf(store.getState().conversations[chatId].tree, second).count).toBe(2);

        await answer(store, 'Short answer.');
        expect(store.getState().conversations[chatId].items.at(-1))
            .toMatchObject({ kind: 'assistant', text: 'Short answer.', model: 'haiku' });
    });

    test('an effort picked for a retry is for that run only, checked against the model', async () => {
        const { store } = await storeWithChat();
        await store.send('what is a CRDT?', []);
        await answer(store, 'A data type that merges.');
        const userId = store.lastUserItemId()!;
        const runOf = async (retry: () => void) => {
            requests.length = 0;
            retry();
            await settle();
            const params = requests.find(r => r.name === 'run.start')!.params;
            await answer(store, 'again');
            return { model: params.model, effort: params.effort };
        };

        expect(await runOf(() => store.retry(userId, 'opus', 'max'))).toEqual({ model: 'opus', effort: 'max' });
        // the chat's own model with another effort
        expect(await runOf(() => store.retry(userId, undefined, 'max'))).toEqual({ model: null, effort: 'max' });
        // a level the model does not take falls back to its default (Haiku: none)
        expect(await runOf(() => store.retry(userId, 'haiku', 'max'))).toEqual({ model: 'haiku', effort: null });
        // null asks for the model's own default
        expect(await runOf(() => store.retry(userId, 'opus', null))).toEqual({ model: 'opus', effort: null });

        // none of it reached the chat: its next message goes as it was set
        expect(store.getState().chats[0]).toMatchObject({ model: null, effort: null });
        requests.length = 0;
        await store.send('and then?', []);
        expect(requests.find(r => r.name === 'run.start')!.params).toMatchObject({ model: null, effort: null });
        await answer(store, 'done');
    });

    test('re-sends the pictures it still has', async () => {
        const { store } = await storeWithChat();
        const image = { id: 'i', mimeType: 'image/png' as const, data: 'AAAA', url: 'blob:x', name: 'x.png', bytes: 3 };
        await store.send('look', [image]);
        await answer(store, 'I see it.');
        requests.length = 0;
        store.retry(store.lastUserItemId()!);
        await settle();
        expect(requests.find(r => r.name === 'run.start')!.params.images).toEqual([{ mimeType: 'image/png', data: 'AAAA' }]);
    });
});

describe('a follow-up leaves the turn above it alone', () => {
    test('every earlier item is the same object, and the saved tree draws the same rows', async () => {
        const { store, trees } = await storeWithChat();
        await store.send('first', []);
        helperSays(store, { type: 'run.event', event: { type: 'reasoning-delta', text: 'hm' } });
        helperSays(store, { type: 'run.event', event: { type: 'tool', callId: 'c', name: 'Grep', status: 'done', input: {} } });
        await answer(store, 'one');
        const chatId = store.getState().activeChatId!;
        const before = store.getState().conversations[chatId].items;
        expect(before.map(i => i.kind)).toEqual(['user', 'reasoning', 'tool', 'assistant']);
        await store.send('second', []);
        const after = store.getState().conversations[chatId].items;
        before.forEach((item, i) => expect(after[i]).toBe(item));
        expect(itemsFromTree(trees.get(chatId)!).map(i => i.id)).toEqual(after.map(i => i.id));
    });
});

describe('rename and star', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const index = JSON.stringify({
        version: 1, theme: 'kept',
        chats: [{ id, agent: 'claude', sessionId: null, title: 'Old', model: null, effort: null, createdAt: 1, updatedAt: 1, colour: 'teal' }],
    });

    test('rename shows at once, trims, and is saved without losing unknown keys', async () => {
        const { store, file } = await storeWithChat(index);
        const done = store.renameChat(id, '  A   better\nname ');
        expect(store.getState().chats[0].title).toBe('A better name');
        await done;
        const saved = JSON.parse(file.index);
        expect(saved.chats[0]).toMatchObject({ title: 'A better name', colour: 'teal', updatedAt: 1 });
        expect(saved.theme).toBe('kept');
        await store.renameChat(id, '   ');   // refused
        expect(JSON.parse(file.index).chats[0].title).toBe('A better name');
    });

    test('star writes true, unstar removes the key', async () => {
        const { store, file } = await storeWithChat(index);
        await store.setStarred(id, true);
        expect(store.getState().chats[0].starred).toBe(true);
        expect(JSON.parse(file.index).chats[0]).toMatchObject({ starred: true, colour: 'teal' });
        await store.setStarred(id, false);
        expect('starred' in JSON.parse(file.index).chats[0]).toBe(false);
        expect(store.getState().chats[0].starred).toBeUndefined();
    });

    test('only a real true reads as starred', () => {
        const parsed = parseChatIndex(JSON.stringify({ version: 1, chats: [{ id, agent: 'claude', title: 't', starred: 'yes' }] }));
        expect(parsed.chats[0].starred).toBeUndefined();
    });
});

/* ───────────── pictures on edit and retry ───────────── */

const picture = (id: string) => ({ id, mimeType: 'image/png' as const, data: `DATA-${id}`, url: `blob:${id}`, name: `${id}.png`, bytes: 3 });

describe('pictures on edit and retry', () => {
    test('an edit re-sends the pictures the message went with, and the new version shows them', async () => {
        const { store } = await storeWithChat();
        await store.send('look at these', [picture('a'), picture('b')]);
        await answer(store, 'Two squares.');
        const first = store.lastUserItemId()!;
        expect(store.resendableImages(first)).toEqual({ count: 2, available: 2 });

        requests.length = 0;
        store.editMessage(first, 'look again');
        await settle();
        expect(requests.find(r => r.name === 'run.start')!.params.images)
            .toEqual([{ mimeType: 'image/png', data: 'DATA-a' }, { mimeType: 'image/png', data: 'DATA-b' }]);
        const chatId = store.getState().activeChatId!;
        const edited = store.lastUserItemId()!;
        expect(edited).not.toBe(first);
        expect(store.getState().conversations[chatId].items.find(i => i.id === edited))
            .toMatchObject({ kind: 'user', text: 'look again', thumbs: ['blob:a', 'blob:b'], imageCount: 2 });
        expect(store.getState().conversations[chatId].tree.nodes[edited].images).toBe(2);
        expect(store.resendableImages(edited)).toEqual({ count: 2, available: 2 });
        // nothing said: nothing was dropped
        expect(store.getState().conversations[chatId].items.some(i => i.kind === 'notice')).toBe(false);
        await answer(store, 'Still two.');
    });

    test('after a reload they are gone: reported, and a retry says so in the turn it starts', async () => {
        const { host, trees } = fakeHost(JSON.stringify({ version: 1, chats: [] }));
        const before = new ChatStore();
        before.attach(host, { key: 'vault-pics', name: 'Vault' });
        await settle();
        await before.send('see image', [picture('c')]);
        await answer(before, 'A picture.');
        const chatId = before.getState().activeChatId!;
        const userId = before.lastUserItemId()!;

        // A reload: a fresh store, the same vault on disk.
        const after = new ChatStore();
        after.attach(host, { key: 'vault-pics', name: 'Vault' });
        await settle();
        after.openChat(chatId);
        await settle();
        expect(after.resendableImages(userId)).toEqual({ count: 1, available: 0 });

        requests.length = 0;
        after.retry(userId);
        await settle();
        expect(requests.find(r => r.name === 'run.start')!.params.images).toEqual([]);
        const items = after.getState().conversations[chatId].items;
        const retried = after.lastUserItemId()!;
        // (Not expect.stringContaining inside toMatchObject: Bun 1.4 writes the
        // matcher object INTO the received item, which then fails to save.)
        const said = items[items.findIndex(i => i.id === retried) + 1];
        expect(said).toMatchObject({ kind: 'notice', tone: 'warning' });
        expect(said.kind === 'notice' && said.message).toStartWith("The image from the original message couldn't be sent again");
        await answer(after, 'Without it.');
        // …and the saved turn still says it
        const saved = itemsFromTree(trees.get(chatId)!);
        expect(saved.some(i => i.kind === 'notice' && /couldn't be sent again/.test(i.message))).toBe(true);
    });

    test('a message with no pictures reports none', async () => {
        const { store } = await storeWithChat();
        await store.send('plain', []);
        await answer(store, 'ok');
        expect(store.resendableImages(store.lastUserItemId()!)).toEqual({ count: 0, available: 0 });
        expect(store.resendableImages('no-such-id')).toEqual({ count: 0, available: 0 });
    });
});

/* ───────────── several vaults: the open chat, a reply cut off by a switch ───────────── */

/** One app host over several vaults on "disk", like the real one: every call
 *  reads the vault open NOW, unless a write names its vault by token. */
function fakeVaults() {
    const disks = new Map<object, { trees: Map<string, ChatTree>; index: string }>();
    let open: object | null = null;
    /** A page being torn down: its async file writes never land. */
    const state = { tornDown: false };
    const disk = (token: object | null) => disks.get(token!)!;
    const host = {
        toolHost: { vaultToken: () => open },
        workspace: () => null,
        ensureVaultUuid: async () => '00000000-0000-4000-8000-000000000002',
        readChatIndex: async () => parseChatIndex(disk(open).index),
        readChatTree: async (id: string) => disk(open).trees.get(id) ?? emptyTree(),
        writeChatTree: async (id: string, tree: ChatTree, vault?: object | null) => {
            const target = vault ?? open;
            if (target && !state.tornDown) disk(target).trees.set(id, parseTree(serializeTree(tree)));
        },
        deleteChatTree: async (id: string) => { disk(open).trees.delete(id); },
        updateChatIndex: async (update: (index: ChatIndex) => ChatIndex) => {
            const d = disk(open);
            const next = update(parseChatIndex(d.index));
            d.index = serializeChatIndex(next);
            return next;
        },
        collectMirrorFiles: async () => [],
        ask: async () => true,
        notify: () => {},
        openFile: () => {},
    } as unknown as AgentHost;
    let n = 0;
    return {
        host,
        state,
        /** Create a vault and make it the open one (what the app's picker does). */
        add() {
            const token = { vault: ++n };
            disks.set(token, { trees: new Map(), index: JSON.stringify({ version: 1, chats: [] }) });
            open = token;
            return { token, key: `multi-${n}-${Math.random()}`, disk: disks.get(token)! };
        },
        switchTo(token: object) { open = token; },
    };
}

describe('the chat a vault had open', () => {
    test('comes back when the panel attaches to that vault again (a reload)', async () => {
        const app = fakeVaults();
        const v = app.add();
        const before = new ChatStore();
        before.attach(app.host, { key: v.key, name: 'One' });
        await settle();
        await before.send('remember me', []);
        await answer(before, 'Remembered.');
        const chatId = before.getState().activeChatId!;

        const after = new ChatStore();
        after.attach(app.host, { key: v.key, name: 'One' });
        await settle();
        expect(after.getState().activeChatId).toBe(chatId);
        expect(after.getState().conversations[chatId].items.map(i => i.kind)).toEqual(['user', 'assistant']);
    });

    test('New chat, and deleting the open chat, come back as New chat', async () => {
        const app = fakeVaults();
        const v = app.add();
        const store = new ChatStore();
        store.attach(app.host, { key: v.key, name: 'One' });
        await settle();
        await store.send('first', []);
        await answer(store, 'one');
        store.newChat();
        let reloaded = new ChatStore();
        reloaded.attach(app.host, { key: v.key, name: 'One' });
        await settle();
        expect(reloaded.getState().activeChatId).toBeNull();

        const chatId = store.getState().chats[0].id;
        store.openChat(chatId);
        await store.deleteChat(chatId);
        reloaded = new ChatStore();
        reloaded.attach(app.host, { key: v.key, name: 'One' });
        await settle();
        expect(reloaded.getState().activeChatId).toBeNull();
    });

    test('a chat deleted elsewhere is not reopened', async () => {
        const app = fakeVaults();
        const v = app.add();
        const store = new ChatStore();
        store.attach(app.host, { key: v.key, name: 'One' });
        await settle();
        await store.send('soon gone', []);
        await answer(store, 'ok');
        // another window deletes it from the index
        v.disk.index = JSON.stringify({ version: 1, chats: [] });
        const reloaded = new ChatStore();
        reloaded.attach(app.host, { key: v.key, name: 'One' });
        await settle();
        expect(reloaded.getState().activeChatId).toBeNull();
        expect(reloaded.getState().indexStatus).toBe('ready');
    });

    test('each vault gets its own back when switched to', async () => {
        const app = fakeVaults();
        const one = app.add();
        const store = new ChatStore();
        store.attach(app.host, { key: one.key, name: 'One' });
        await settle();
        await store.send('in one', []);
        await answer(store, 'one');
        const chatOne = store.getState().activeChatId!;

        const two = app.add();
        store.attach(app.host, { key: two.key, name: 'Two' });
        await settle();
        expect(store.getState().activeChatId).toBeNull();   // two has none yet
        await store.send('in two', []);
        await answer(store, 'two');
        const chatTwo = store.getState().activeChatId!;

        app.switchTo(one.token);
        store.attach(app.host, { key: one.key, name: 'One' });
        await settle();
        expect(store.getState().activeChatId).toBe(chatOne);
        app.switchTo(two.token);
        store.attach(app.host, { key: two.key, name: 'Two' });
        await settle();
        expect(store.getState().activeChatId).toBe(chatTwo);
    });

    test('not over a chat the user started while the index loaded', async () => {
        const app = fakeVaults();
        const v = app.add();
        const first = new ChatStore();
        first.attach(app.host, { key: v.key, name: 'One' });
        await settle();
        await first.send('older', []);
        await answer(first, 'ok');
        const store = new ChatStore();
        store.attach(app.host, { key: v.key, name: 'One' });
        // the index is still loading: the user sends from the draft
        void store.send('newer', []);
        await settle();
        const active = store.getState().activeChatId;
        expect(active).not.toBe(first.getState().activeChatId);
        expect(store.getState().chats.find(c => c.id === active)?.title).toBe('newer');
        helperSays(store, { type: 'run.done', status: 'ok', sessionId: 's' });
        await settle();
    });
});

describe('a reply cut off by a vault switch', () => {
    test('is saved, with "Stopped.", into the vault it started in — and nothing lands in the new one', async () => {
        const app = fakeVaults();
        const one = app.add();
        const store = new ChatStore();
        store.attach(app.host, { key: one.key, name: 'One' });
        await settle();
        await store.send('hold', []);
        helperSays(store, { type: 'run.event', event: { type: 'session', sessionId: 'sess-cut' } });
        helperSays(store, { type: 'run.event', event: { type: 'text-delta', text: 'half a rep' } });
        const chatId = store.getState().activeChatId!;
        await settle();
        const indexBefore = one.disk.index;

        requests.length = 0;
        const two = app.add();
        store.attach(app.host, { key: two.key, name: 'Two' });
        await settle();

        expect(store.getState().run).toBeNull();
        expect(requests.some(r => r.name === 'run.cancel')).toBe(true);
        const saved = activePath(one.disk.trees.get(chatId)!);
        expect(saved.map(n => n.role)).toEqual(['user', 'assistant']);
        expect(saved[1]).toMatchObject({ text: 'half a rep', sessionId: 'sess-cut' });
        expect(itemsFromTree(one.disk.trees.get(chatId)!).slice(1).map(i => i.kind === 'notice' ? i.message : i.kind))
            .toEqual(['assistant', 'Stopped.']);
        // the new vault got nothing, and the old index was not rewritten
        expect(two.disk.trees.size).toBe(0);
        expect(JSON.parse(two.disk.index).chats).toEqual([]);
        expect(one.disk.index).toBe(indexBefore);

        // and back in vault one it reads the same
        app.switchTo(one.token);
        store.attach(app.host, { key: one.key, name: 'One' });
        await settle();
        expect(store.getState().activeChatId).toBe(chatId);
        const items = store.getState().conversations[chatId].items;
        expect(items.map(i => i.kind)).toEqual(['user', 'assistant', 'notice']);
        expect(items[2]).toMatchObject({ message: 'Stopped.' });
    });

    test('a run that ends after a switch made with the panel closed is saved in its own vault, not the new one', async () => {
        const app = fakeVaults();
        const one = app.add();
        const store = new ChatStore();
        store.attach(app.host, { key: one.key, name: 'One' });
        await settle();
        await store.send('long one', []);
        const chatId = store.getState().activeChatId!;
        // The panel is closed, so nothing attaches: only the open vault changes.
        const two = app.add();
        await answer(store, 'finished anyway');
        expect(activePath(one.disk.trees.get(chatId)!).map(n => n.text)).toEqual(['long one', 'finished anyway']);
        expect(two.disk.trees.size).toBe(0);
        expect(JSON.parse(two.disk.index).chats).toEqual([]);
    });

    test('a reload mid-reply saves what streamed, then "Stopped."', async () => {
        const app = fakeVaults();
        const one = app.add();
        const store = new ChatStore();
        store.attach(app.host, { key: one.key, name: 'One' });
        await settle();
        await store.send('hold me', []);
        helperSays(store, { type: 'run.event', event: { type: 'text-delta', text: 'so far' } });
        const chatId = store.getState().activeChatId!;

        // into the back/forward cache: the page may come back, run and all
        window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
        expect(store.getState().run).not.toBeNull();

        window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
        await settle();
        expect(store.getState().run).toBeNull();
        const saved = itemsFromTree(one.disk.trees.get(chatId)!);
        expect(saved.map(i => i.kind === 'notice' ? i.message : i.kind)).toEqual(['user', 'assistant', 'Stopped.']);
        expect(saved[1]).toMatchObject({ text: 'so far' });
    });

    /** A run cut off by a reload whose own file write never landed. */
    async function reloadMidReply() {
        const app = fakeVaults();
        const one = app.add();
        const store = new ChatStore();
        store.attach(app.host, { key: one.key, name: 'One' });
        await settle();
        await store.send('hold me', []);
        helperSays(store, { type: 'run.event', event: { type: 'session', sessionId: 'sess-r' } });
        helperSays(store, { type: 'run.event', event: { type: 'text-delta', text: 'so far' } });
        await settle();
        const chatId = store.getState().activeChatId!;
        app.state.tornDown = true;
        window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
        await settle();
        app.state.tornDown = false;
        // what the next page finds on disk: the question alone
        expect(activePath(one.disk.trees.get(chatId)!).map(n => n.role)).toEqual(['user']);
        return { app, one, chatId };
    }

    test('…and when the page went before its write landed, the next load folds the turn back in', async () => {
        const { app, one, chatId } = await reloadMidReply();
        const next = new ChatStore();
        next.attach(app.host, { key: one.key, name: 'One' });
        await settle();
        expect(next.getState().activeChatId).toBe(chatId);
        const shown = next.getState().conversations[chatId].items;
        expect(shown.map(i => i.kind === 'notice' ? i.message : i.kind)).toEqual(['user', 'assistant', 'Stopped.']);
        // written back to the file, with the session the run was in
        const path = activePath(one.disk.trees.get(chatId)!);
        expect(path.map(n => n.role)).toEqual(['user', 'assistant']);
        expect(path[1]).toMatchObject({ text: 'so far', sessionId: 'sess-r' });
        // once: a second load finds nothing more to add
        const again = new ChatStore();
        again.attach(app.host, { key: one.key, name: 'One' });
        await settle();
        expect(activePath(one.disk.trees.get(chatId)!)).toHaveLength(2);
    });

    test('…but never onto a file that moved on since (another window answered)', async () => {
        const { app, one, chatId } = await reloadMidReply();
        const moved = append(one.disk.trees.get(chatId)!, { id: 'other', role: 'assistant', text: 'from elsewhere', createdAt: 5 });
        one.disk.trees.set(chatId, moved);
        const next = new ChatStore();
        next.attach(app.host, { key: one.key, name: 'One' });
        await settle();
        expect(activePath(one.disk.trees.get(chatId)!).map(n => n.text)).toEqual(['hold me', 'from elsewhere']);
        expect(next.getState().conversations[chatId].items.map(i => i.kind)).toEqual(['user', 'assistant']);
    });

    test('…and a garbled copy is dropped without touching the file', async () => {
        const { app, one, chatId } = await reloadMidReply();
        const map = JSON.parse(localStorage.getItem('vaultAgentCutOffTurns')!);
        const key = Object.keys(map).find(k => k.endsWith(chatId))!;
        map[key] = { parent: 42, node: 'nope' };
        localStorage.setItem('vaultAgentCutOffTurns', JSON.stringify(map));
        const next = new ChatStore();
        next.attach(app.host, { key: one.key, name: 'One' });
        await settle();
        expect(activePath(one.disk.trees.get(chatId)!).map(n => n.role)).toEqual(['user']);
        expect(key in JSON.parse(localStorage.getItem('vaultAgentCutOffTurns')!)).toBe(false);
    });
});
