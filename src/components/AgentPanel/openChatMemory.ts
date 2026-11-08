// Which chat the panel was showing, per vault.
//
// The transcripts themselves already survive a reload — they are files in
// `.VaultAgent/chats/` (utils/chatTree.ts) — but WHICH of them was on screen
// was not written down anywhere, so every reload opened the panel on a blank
// new chat and the conversation someone was in the middle of appeared to be
// gone. It wasn't: it was one click away in the chat list. This is the rest of
// what the editor already does for tabs, scroll places and canvas cameras.
//
// localStorage, not the vault, for the same reason the open-tab session is in
// localStorage: it describes THIS browser's view of the vault, not the vault.
// Two windows on one vault may sit in different chats, and neither should
// reach into the other's.
//
// Keyed by the panel's vault key, and capped, so hopping through vaults cannot
// grow the record without bound.

const KEY = 'vaultAgentOpenChat';

/** How many vaults' choices are kept. Past this the oldest-written goes: a
 *  vault not opened in the last twenty is one whose chat has almost certainly
 *  moved on anyway, and the cost of being wrong is one extra click. */
const MAX_VAULTS = 20;

/** Insertion order is the record's age order — `withOpenChat` re-inserts on
 *  every write, so the first key is the least recently chosen. */
export type OpenChats = Record<string, string>;

/** Parse the stored record. localStorage is user-editable and holds whatever an
 *  older build wrote, so anything unrecognisable reads as "nothing remembered"
 *  rather than reaching the store as a half-built object. */
export function parseOpenChats(raw: string | null): OpenChats {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: OpenChats = {};
        for (const [vault, chat] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof chat === 'string' && chat) out[vault] = chat;
        }
        return out;
    } catch {
        return {};
    }
}

/**
 * The record with `vaultKey` set to `chatId` — or cleared, when the panel is on
 * a new chat that has not been saved yet (there is nothing to come back to, and
 * leaving the old id behind would reopen a chat the user had left).
 */
export function withOpenChat(chats: OpenChats, vaultKey: string, chatId: string | null): OpenChats {
    // Rebuilt rather than mutated so the key moves to the end — that is what
    // makes the trim below drop the least recently chosen.
    const next: OpenChats = {};
    for (const [key, value] of Object.entries(chats)) {
        if (key !== vaultKey) next[key] = value;
    }
    if (chatId) next[vaultKey] = chatId;

    const keys = Object.keys(next);
    if (keys.length <= MAX_VAULTS) return next;
    const trimmed: OpenChats = {};
    for (const key of keys.slice(keys.length - MAX_VAULTS)) trimmed[key] = next[key];
    return trimmed;
}

function read(): OpenChats {
    try {
        return parseOpenChats(localStorage.getItem(KEY));
    } catch {
        return {};   // storage blocked outright
    }
}

/** The chat this vault was last left in, if any. */
export function readOpenChat(vaultKey: string | null): string | null {
    if (!vaultKey) return null;
    return read()[vaultKey] ?? null;
}

/** Remember (or, with null, forget) the chat on screen for this vault. */
export function rememberOpenChat(vaultKey: string | null, chatId: string | null): void {
    if (!vaultKey) return;
    try {
        localStorage.setItem(KEY, JSON.stringify(withOpenChat(read(), vaultKey, chatId)));
    } catch {
        // Full or blocked: the panel opens on a new chat next time, which is
        // what it always used to do.
    }
}
