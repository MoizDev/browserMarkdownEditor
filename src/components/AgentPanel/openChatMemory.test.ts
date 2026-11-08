import { describe, expect, test } from 'bun:test';
import { parseOpenChats, withOpenChat } from './openChatMemory';

describe('reading the record back', () => {
    test('keeps vault → chat pairs', () => {
        expect(parseOpenChats('{"v1":"c1","v2":"c2"}')).toEqual({ v1: 'c1', v2: 'c2' });
    });

    test('nothing stored, junk, or the wrong shape all read as nothing remembered', () => {
        expect(parseOpenChats(null)).toEqual({});
        expect(parseOpenChats('not json')).toEqual({});
        expect(parseOpenChats('["c1"]')).toEqual({});
        expect(parseOpenChats('"c1"')).toEqual({});
    });

    test('drops entries that are not a chat id, keeping the ones that are', () => {
        expect(parseOpenChats('{"v1":"c1","v2":42,"v3":"","v4":null}')).toEqual({ v1: 'c1' });
    });
});

describe('writing a choice', () => {
    test('records the chat for its own vault and leaves the others alone', () => {
        expect(withOpenChat({ v1: 'c1' }, 'v2', 'c2')).toEqual({ v1: 'c1', v2: 'c2' });
        expect(withOpenChat({ v1: 'c1' }, 'v1', 'c9')).toEqual({ v1: 'c9' });
    });

    test('a new chat clears the vault rather than leaving the old one to reopen', () => {
        expect(withOpenChat({ v1: 'c1', v2: 'c2' }, 'v1', null)).toEqual({ v2: 'c2' });
    });

    test('keeps the twenty most recently chosen vaults', () => {
        let chats = {};
        for (let i = 0; i < 25; i++) chats = withOpenChat(chats, `v${i}`, `c${i}`);
        const keys = Object.keys(chats);
        expect(keys).toHaveLength(20);
        expect(keys[0]).toBe('v5');          // the first five fell off
        expect(keys[19]).toBe('v24');
    });

    test('choosing again in a vault keeps it from falling off', () => {
        let chats: Record<string, string> = {};
        for (let i = 0; i < 20; i++) chats = withOpenChat(chats, `v${i}`, `c${i}`);
        chats = withOpenChat(chats, 'v0', 'c0-again');     // used again, so youngest now
        chats = withOpenChat(chats, 'v99', 'c99');         // pushes one out
        expect(chats.v0).toBe('c0-again');
        expect(chats.v1).toBeUndefined();                  // the next-oldest went instead
    });
});
