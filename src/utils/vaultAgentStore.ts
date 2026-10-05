// The AI agent panel's footprint INSIDE the vault: one hidden folder at the
// root, `.VaultAgent/`, holding
//
//   vault.json  { version: 1, id }        the vault's permanent agent id
//   chats.json  { version: 1, chats: [] } which chats the panel started here
//
// Everything else about a chat — the conversation itself — is the agent CLI's
// own session, kept where that CLI keeps it (~/.claude, ~/.codex, OpenCode's
// database), under the working folder ~/.bme-agent-sessions/<id>/. The id lives
// IN the vault, not in browser storage, so the same vault maps to the same
// working folder in every browser and on every machine it is synced to; the
// browser's own vault ids (recentVaults) differ per browser.
//
// Pure parsing plus the folder's name; App does the reads and writes.

import type { ChatIndex, ChatMeta } from '../types/vaultAgent';
import { AGENT_IDS, isUuid, type AgentId } from '../../shared/vaultAgentProtocol';

export const VAULT_AGENT_DIR = '.VaultAgent';
export const VAULT_ID_FILE = 'vault.json';
export const CHAT_INDEX_FILE = 'chats.json';

/**
 * Folders hidden from the file tree AT THE VAULT ROOT ONLY (and so from vault
 * search and the graph, which are built from the tree). The app's own
 * `.VaultAgent`, and the agent CLIs' per-project folders — a user who drops
 * skills or settings into `.claude`/`.agents` put them there for the agent,
 * not as notes. Root-only because that is the only place the CLIs look; a
 * `.claude` deeper down is the user's own business and stays visible.
 */
export const ROOT_HIDDEN_DIRS: ReadonlySet<string> = new Set([VAULT_AGENT_DIR, '.claude', '.agents', '.codex', '.opencode']);

export function emptyChatIndex(): ChatIndex {
    return { version: 1, chats: [] };
}

function isAgentId(value: unknown): value is AgentId {
    return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value);
}

function str(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function num(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** One chat entry, or null when it is not one this build can use. Unknown keys
 *  on the entry are kept (spread first), so a newer build's fields survive an
 *  older build rewriting the file. */
function parseChat(raw: unknown): ChatMeta | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (!isUuid(r.id) || !isAgentId(r.agent)) return null;
    const created = num(r.createdAt, 0);
    return {
        ...r,
        id: r.id,
        agent: r.agent,
        sessionId: str(r.sessionId),
        title: str(r.title) ?? 'Untitled chat',
        model: str(r.model),
        effort: str(r.effort),
        createdAt: created,
        updatedAt: num(r.updatedAt, created),
        lastImageHash: str(r.lastImageHash),
    };
}

/** Never throws: the file is in the user's vault, where anything can edit it. A
 *  file that is not JSON reads as empty — and is then only replaced by a write
 *  the user caused (a new chat), never proactively. */
export function parseChatIndex(text: string | null): ChatIndex {
    if (!text) return emptyChatIndex();
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return emptyChatIndex(); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyChatIndex();
    const r = raw as Record<string, unknown>;
    const chats = Array.isArray(r.chats) ? r.chats.map(parseChat).filter((c): c is ChatMeta => c !== null) : [];
    return { ...r, version: 1, chats };
}

export function serializeChatIndex(index: ChatIndex): string {
    return JSON.stringify(index, null, 2) + '\n';
}

/** The vault id from `vault.json`, or null when missing/invalid. */
export function parseVaultId(text: string | null): string | null {
    if (!text) return null;
    try {
        const raw = JSON.parse(text) as unknown;
        const id = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).id : null;
        return isUuid(id) ? id.toLowerCase() : null;
    } catch {
        return null;
    }
}

export function serializeVaultId(id: string): string {
    return JSON.stringify({ version: 1, id }, null, 2) + '\n';
}

/**
 * The vault's id, read from `.VaultAgent/vault.json` or minted and written.
 *
 * ONE implementation, two callers that could not be further apart: the agent
 * host (which names the CLI's working folder after it) and the terminal (which
 * asks the helper "where is this vault on disk?" with it). Both need the same
 * answer for the same vault, and a second minting would split a vault in two.
 *
 * Serialized here rather than by each caller: StrictMode runs effects twice,
 * and the first terminal and the first message can land together.
 */
let idInFlight: Promise<string | null> = Promise.resolve(null);

export function ensureVaultId(
    root: FileSystemDirectoryHandle,
    writeFile: (handle: FileSystemFileHandle, text: string) => Promise<unknown>,
): Promise<string | null> {
    const next = idInFlight.then(async () => {
        try {
            const dir = await root.getDirectoryHandle(VAULT_AGENT_DIR);
            const existing = parseVaultId(await (await (await dir.getFileHandle(VAULT_ID_FILE)).getFile()).text());
            if (existing) return existing;
        } catch { /* no folder, no file, or unreadable: mint one below */ }
        try {
            const id = crypto.randomUUID();
            const dir = await root.getDirectoryHandle(VAULT_AGENT_DIR, { create: true });
            // Never createFile: it truncates, and then walks the whole vault to
            // refresh a tree this hidden folder is not in.
            await writeFile(await dir.getFileHandle(VAULT_ID_FILE, { create: true }), serializeVaultId(id));
            return id;
        } catch (err) {
            console.error('Could not write the vault id:', err);
            return null;
        }
    });
    idInFlight = next.catch(() => null);
    return next;
}
