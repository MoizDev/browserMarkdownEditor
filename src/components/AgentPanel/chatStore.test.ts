// How a branching transcript becomes what the panel draws, and how a finished
// run becomes one turn in it. Pure functions only — the store itself is driven
// in a browser (the verify-in-browser skill).

import { describe, expect, test } from 'bun:test';
import { foldRunIntoNode, itemsFromTree, transcriptPrefix, treeFromItems } from './chatStore';
import type { ChatItem } from './chatStore';
import { activePath, append, branchFrom, emptyTree, type ChatTree } from '../../utils/chatTree';

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
