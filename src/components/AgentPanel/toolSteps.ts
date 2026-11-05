// What a tool step SAYS: the verb (present while it runs, past once done),
// what it acted on, and which kind of glyph it wears — for our own vault_/
// canvas_ tools and every CLI's own. Pure, and apart from the components
// (ToolCallCard.tsx, MessageList.tsx) so each of those files exports only
// components and Fast Refresh keeps working on them.

import type { ChatItem } from './chatStore';
import type { AgentChange } from '../../types/vaultAgent';

export type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/** Which glyph a step wears. */
export type StepKind = 'file' | 'folder' | 'search' | 'terminal' | 'globe' | 'bot';

/** [while running, once done, what it acted on, its kind]. */
type Description = [string, string, string, StepKind];

function str(input: unknown, key: string): string {
    if (input && typeof input === 'object' && key in input) {
        const v = (input as Record<string, unknown>)[key];
        if (typeof v === 'string') return v;
        if (typeof v === 'number') return String(v);
    }
    return '';
}

/** Our own vault_/canvas_ tools. */
export function describeOwn(rawName: string, input: unknown): Description {
    const name = rawName.replace(/^mcp__vault__/, '');
    const path = str(input, 'path');
    const page = str(input, 'page');
    switch (name) {
        case 'vault_list': return ['Listing', 'Listed', path || 'the vault', 'folder'];
        case 'vault_read': return ['Reading', 'Read', path, 'file'];
        case 'vault_view': return ['Looking at', 'Looked at', path + (page ? ` (page ${page})` : ''), 'file'];
        case 'vault_search': return ['Searching the vault for', 'Searched the vault for', `“${str(input, 'query')}”`, 'search'];
        case 'vault_edit': return ['Editing', 'Edited', path, 'file'];
        case 'vault_write': return ['Rewriting', 'Rewrote', path, 'file'];
        case 'vault_create': return ['Creating', 'Created', path, 'file'];
        case 'vault_mkdir': return ['Creating the folder', 'Created the folder', path, 'folder'];
        case 'vault_move': return ['Moving', 'Moved', `${str(input, 'from')} → ${str(input, 'to')}`, 'file'];
        case 'vault_trash': return ['Moving to the trash', 'Moved to the trash', path, 'file'];
        case 'canvas_shapes': return ['Reading the shapes in', 'Read the shapes in', path, 'file'];
        case 'canvas_apply': return ['Drawing on', 'Drew on', path, 'file'];
        default: return ['Running', 'Ran', name, 'terminal'];
    }
}

/** A CLI's own tools name files by absolute path, and the row ellipsizes at its
 *  END — "Read /Users/me/Developer/…" would hide the very file it read. Keep the
 *  name and, when it is short, its folder: Codex works in a folder named by a
 *  36-character session id, which alone filled the row and hid "+2 more"
 *  (measured: 1532px of text in a 273px box). The full path is in the call's
 *  input, one click away. */
export function shortPath(path: string): string {
    const sep = path.includes('/') ? '/' : '\\';
    const segments = path.split(sep).filter(Boolean);
    if (segments.length <= 3) return path;
    const [parent, name] = segments.slice(-2);
    return parent.length > 20 ? `…${sep}${name}` : `…${sep}${parent}${sep}${name}`;
}

/** The file a CLI's own file tool acted on: Claude says `file_path` (and
 *  `notebook_path`), OpenCode `filePath`, Codex `path`. */
function file(input: unknown): string {
    return shortPath(str(input, 'file_path') || str(input, 'filePath') || str(input, 'path') || str(input, 'notebook_path'));
}

/** A patch can touch several files; one row fits only the first. Codex's item
 *  lists them (`paths`); OpenCode's `apply_patch` (its edit tool for GPT models)
 *  carries only the patch text, whose `*** Update File: <path>` lines name them. */
export function patchTarget(input: unknown): string {
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const named = Array.isArray(record.paths)
        ? record.paths.filter((p): p is string => typeof p === 'string')
        : typeof record.patchText === 'string'
            ? [...record.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m => m[1].trim())
            : [];
    if (!named.length) return '';
    const first = shortPath(named[0]);
    return named.length > 1 ? `${first} +${named.length - 1} more` : first;
}

/** The agent's own tools, whatever each CLI calls them. Exact names first:
 *  `read`, `write` and `edit` recur inside other tools' names — a substring
 *  test would call `TodoWrite` a file write, or an MCP server's `edit_issue`
 *  a file edit. The substring fallbacks catch the rest by family. */
export function describeForeign(name: string, input: unknown): Description {
    const n = name.toLowerCase();
    switch (n) {
        case 'bash':
        case 'shell': return ['Running a command', 'Ran a command', str(input, 'command'), 'terminal'];
        case 'read': return ['Reading', 'Read', file(input), 'file'];
        case 'write': return ['Writing', 'Wrote', file(input), 'file'];
        case 'edit':
        case 'multiedit':
        case 'notebookedit': return ['Editing', 'Edited', file(input), 'file'];
        case 'apply_patch': return ['Editing', 'Edited', patchTarget(input), 'file'];
        case 'glob': return ['Finding files', 'Found files', str(input, 'pattern'), 'search'];
        // A terminal glyph: grep is a command over the files, not the vault
        // search (the magnifier) our own tool is.
        case 'grep': return ['Searching files for', 'Searched files for', str(input, 'pattern'), 'terminal'];
        case 'agent':
        case 'task': return ['Running an agent', 'Ran an agent', str(input, 'description') || str(input, 'prompt'), 'bot'];
        case 'todowrite': return ['Updating the to-dos', 'Updated the to-dos', '', 'file'];
        case 'view_image': return ['Viewing', 'Viewed', shortPath(str(input, 'path')), 'file'];
        case 'websearch':
        case 'web_search':
            // Codex reports a page it opened as a web_search item with `{url}`.
            if (str(input, 'url')) return ['Opening', 'Opened', str(input, 'url'), 'globe'];
            return ['Searching the web for', 'Searched the web for', str(input, 'query') || str(input, 'q'), 'globe'];
        case 'webfetch':
        case 'web_fetch': return ['Opening', 'Opened', str(input, 'url'), 'globe'];
    }
    // Another MCP server's tool (Codex names it `server.tool`) is no web search
    // however it is named — `github.search_issues` must not read as one.
    if (n.includes('.')) return ['Using', 'Used', name, 'terminal'];
    if (n.includes('search')) return ['Searching the web for', 'Searched the web for', str(input, 'query') || str(input, 'q'), 'globe'];
    if (n.includes('fetch')) return ['Opening', 'Opened', str(input, 'url'), 'globe'];
    if (n.includes('skill')) return ['Using the skill', 'Used the skill', str(input, 'skill') || str(input, 'name') || str(input, 'command'), 'terminal'];
    return ['Using', 'Used', name, 'terminal'];
}

export function describeTool(item: ToolItem): Description {
    return item.own ? describeOwn(item.name, item.input) : describeForeign(item.name, item.input);
}

/** A landed text edit or new note: drawn as a change card, not a row. */
export function isCardChange(item: ToolItem): boolean {
    const change = item.change;
    if (item.status !== 'done' || !change) return false;
    return change.kind === 'edit' || (change.kind === 'create' && !change.folder && change.diff.length > 0);
}

type CardChange = Extract<AgentChange, { kind: 'edit' | 'create' }>;

/** The change a card draws: a text edit or a new note. */
export function isCard(change: AgentChange | undefined): change is CardChange {
    return !!change && (change.kind === 'edit' || change.kind === 'create');
}
