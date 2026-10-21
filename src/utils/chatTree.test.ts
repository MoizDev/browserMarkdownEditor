// The branching transcript's rules, which the whole edit-a-message feature
// rests on: what a fork keeps, what the arrows walk between, which session a
// branch continues in, and what a file the user broke degrades to.
//
// `bun test src` (npm run test:app). The APP has no other tests — everything
// about the DOM is verified in a browser (the verify-in-browser skill) — but
// this module is pure data, where a test says in two lines what a screenshot
// cannot say at all.

import { expect, test, describe } from 'bun:test';
import {
    ROOT, activePath, activeSessionId, append, branchFrom, emptyTree,
    parseTree, selectVersion, serializeTree, versionOf,
    type ChatTree,
} from './chatTree';;

const say = (tree: ChatTree, role: 'user' | 'assistant', text: string, id: string) =>
    append(tree, { id, role, text, createdAt: Date.now() });
const texts = (tree: ChatTree) => activePath(tree).map(n => `${n.role[0]}:${n.text}`);

describe('a straight conversation', () => {
    test('appends and shows in order', () => {
        let t = emptyTree();
        t = say(t, 'user', 'hi', 'u1');
        t = say(t, 'assistant', 'hello', 'a1');
        t = say(t, 'user', 'more', 'u2');
        expect(texts(t)).toEqual(['u:hi', 'a:hello', 'u:more']);
        expect(t.activeLeaf).toBe('u2');
        expect(versionOf(t, 'u1')).toEqual({ index: 0, count: 1 });
    });
});

describe('editing a message', () => {
    test('keeps the old thread and shows the new one', () => {
        let t = emptyTree();
        t = say(t, 'user', 'hi', 'u1');
        t = say(t, 'assistant', 'hello', 'a1');
        t = say(t, 'user', 'tell me about cats', 'u2');
        t = say(t, 'assistant', 'cats are…', 'a2');
        // edit u2 → a sibling, thread below the old one untouched
        t = branchFrom(t, 'u2', { id: 'u2b', text: 'tell me about dogs', createdAt: Date.now() });
        expect(texts(t)).toEqual(['u:hi', 'a:hello', 'u:tell me about dogs']);
        expect(versionOf(t, 'u2b')).toEqual({ index: 1, count: 2 });
        t = say(t, 'assistant', 'dogs are…', 'a2b');
        expect(texts(t)).toEqual(['u:hi', 'a:hello', 'u:tell me about dogs', 'a:dogs are…']);
        // and back again: the old branch is intact, with its own answer
        t = selectVersion(t, 'u2');
        expect(texts(t)).toEqual(['u:hi', 'a:hello', 'u:tell me about cats', 'a:cats are…']);
        expect(versionOf(t, 'u2')).toEqual({ index: 0, count: 2 });
        // forward again
        t = selectVersion(t, 'u2b');
        expect(texts(t)).toEqual(['u:hi', 'a:hello', 'u:tell me about dogs', 'a:dogs are…']);
    });

    test('a third version sits beside the other two', () => {
        let t = emptyTree();
        t = say(t, 'user', 'v1', 'u1');
        t = branchFrom(t, 'u1', { id: 'u1b', text: 'v2', createdAt: 2 });
        t = branchFrom(t, 'u1', { id: 'u1c', text: 'v3', createdAt: 3 });
        expect(versionOf(t, 'u1c')).toEqual({ index: 2, count: 3 });
        expect(t.children[ROOT]).toEqual(['u1', 'u1b', 'u1c']);
    });

    test('switching versions lands on that branch\'s newest tip, however deep', () => {
        let t = emptyTree();
        t = say(t, 'user', 'q', 'u1');
        t = say(t, 'assistant', 'a', 'a1');
        t = say(t, 'user', 'deep', 'u2');
        t = say(t, 'assistant', 'deeper', 'a2');
        t = say(t, 'user', 'deepest', 'u3');
        t = branchFrom(t, 'u1', { id: 'u1b', text: 'q2', createdAt: 9 });
        t = say(t, 'assistant', 'short', 'a1b');
        t = selectVersion(t, 'u1');
        expect(texts(t)).toEqual(['u:q', 'a:a', 'u:deep', 'a:deeper', 'u:deepest']);
        t = selectVersion(t, 'u1b');
        expect(texts(t)).toEqual(['u:q2', 'a:short']);
    });
});

describe('sessions follow the branch', () => {
    test('the newest assistant turn on THIS branch names the session', () => {
        let t = emptyTree();
        t = say(t, 'user', 'q', 'u1');
        t = append(t, { id: 'a1', role: 'assistant', text: 'a', createdAt: 1, sessionId: 'sess-one' });
        expect(activeSessionId(t)).toBe('sess-one');
        t = branchFrom(t, 'u1', { id: 'u1b', text: 'q2', createdAt: 2 });
        // a fresh branch has no session yet: the caller must start one
        expect(activeSessionId(t)).toBeNull();
        t = append(t, { id: 'a1b', role: 'assistant', text: 'a2', createdAt: 3, sessionId: 'sess-two' });
        expect(activeSessionId(t)).toBe('sess-two');
        expect(activeSessionId(selectVersion(t, 'u1'))).toBe('sess-one');
    });
});

describe('the file on disk', () => {
    test('round-trips', () => {
        let t = emptyTree();
        t = say(t, 'user', 'hi', 'u1');
        t = append(t, { id: 'a1', role: 'assistant', text: 'yo', createdAt: 1, sessionId: 's', tools: [{ callId: 'c', name: 'vault_read', status: 'done', own: true }] });
        t = branchFrom(t, 'u1', { id: 'u1b', text: 'hey', createdAt: 2 });
        const back = parseTree(serializeTree(t));
        expect(back.activeLeaf).toBe(t.activeLeaf);
        expect(Object.keys(back.nodes).sort()).toEqual(['a1', 'u1', 'u1b']);
        expect(back.children[ROOT]).toEqual(['u1', 'u1b']);
        expect(back.nodes.a1.tools?.[0].name).toBe('vault_read');
    });

    test('survives a file the user broke', () => {
        expect(parseTree(null).nodes).toEqual({});
        expect(parseTree('{ not json').nodes).toEqual({});
        expect(parseTree('[]').nodes).toEqual({});
        // a node whose parent is gone is kept, as a root of its own
        const orphaned = JSON.stringify({ version: 1, nodes: { x: { id: 'x', parent: 'nope', role: 'user', text: 'hi', createdAt: 1 } }, children: {}, activeLeaf: 'x' });
        const t = parseTree(orphaned);
        expect(t.nodes.x.parent).toBe('nope');
        expect(activePath(t).map(n => n.text)).toEqual(['hi']);
        // an activeLeaf pointing at nothing still shows the conversation
        const lost = JSON.stringify({ version: 1, nodes: { x: { id: 'x', parent: null, role: 'user', text: 'hi', createdAt: 1 } }, children: { '': ['x'] }, activeLeaf: 'gone' });
        expect(parseTree(lost).activeLeaf).toBe('x');
    });

    test('a cycle cannot hang the panel', () => {
        const cyclic = JSON.stringify({
            version: 1,
            nodes: { a: { id: 'a', parent: 'b', role: 'user', text: 'a', createdAt: 1 }, b: { id: 'b', parent: 'a', role: 'user', text: 'b', createdAt: 2 } },
            children: {}, activeLeaf: 'a',
        });
        expect(activePath(parseTree(cyclic)).length).toBeLessThanOrEqual(2);
    });

    test('keys a newer build wrote are carried through', () => {
        const t = parseTree(JSON.stringify({ version: 1, nodes: {}, children: {}, activeLeaf: null, futureThing: { a: 1 } }));
        expect((t as unknown as { futureThing: unknown }).futureThing).toEqual({ a: 1 });
        expect(JSON.parse(serializeTree(t)).futureThing).toEqual({ a: 1 });
    });
});
