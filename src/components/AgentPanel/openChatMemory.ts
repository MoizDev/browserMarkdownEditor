import { writeJSON } from '../../utils/storage';

const KEY = 'vaultAgentOpenChat';

const MAX_VAULTS = 20;

export type OpenChats = Record<string, string>;

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

export function withOpenChat(chats: OpenChats, vaultKey: string, chatId: string | null): OpenChats {
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
        return {};
    }
}

export function readOpenChat(vaultKey: string | null): string | null {
    if (!vaultKey) return null;
    return read()[vaultKey] ?? null;
}

export function rememberOpenChat(vaultKey: string | null, chatId: string | null): void {
    if (!vaultKey) return;
    writeJSON(KEY, withOpenChat(read(), vaultKey, chatId));
}
