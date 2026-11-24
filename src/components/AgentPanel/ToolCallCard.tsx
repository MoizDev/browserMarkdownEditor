// One tool the agent used. Our own vault_/canvas_ tools read as a sentence
// ("Edited Notes/Ideas.md") with the change card under it — a diff for text,
// a line for a move/trash/canvas edit — and the call's input and output one
// click away. The agent's own tools (its shell, file reads and edits, web,
// skills, sub-agents) are chips: their effects never pass through the app, so
// there is no change card to show — only the sentence and the raw call.

import { useState } from 'react';
import type { ChatItem } from './chatStore';
import type { AgentChange } from '../../types/vaultAgent';
import type { AgentHost } from '../../types/vaultAgent';
import { AlertCircle, Check, ChevronRight } from '../icons';
import { Orb } from './aicss/Orb';
import { CodeBlock } from './aicss/CodeBlock';
import { FileDiff } from './aicss/FileDiff';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

function str(input: unknown, key: string): string {
    if (input && typeof input === 'object' && key in input) {
        const v = (input as Record<string, unknown>)[key];
        if (typeof v === 'string') return v;
        if (typeof v === 'number') return String(v);
    }
    return '';
}

/** [while running, once done, what it acted on]. */
function describeOwn(rawName: string, input: unknown): [string, string, string] {
    const name = rawName.replace(/^mcp__vault__/, '');
    const path = str(input, 'path');
    const page = str(input, 'page');
    switch (name) {
        case 'vault_list': return ['Listing', 'Listed', path || 'the vault'];
        case 'vault_read': return ['Reading', 'Read', path];
        case 'vault_view': return ['Looking at', 'Looked at', path + (page ? ` (page ${page})` : '')];
        case 'vault_search': return ['Searching for', 'Searched for', `“${str(input, 'query')}”`];
        case 'vault_edit': return ['Editing', 'Edited', path];
        case 'vault_write': return ['Rewriting', 'Rewrote', path];
        case 'vault_create': return ['Creating', 'Created', path];
        case 'vault_mkdir': return ['Creating folder', 'Created folder', path];
        case 'vault_move': return ['Moving', 'Moved', `${str(input, 'from')} → ${str(input, 'to')}`];
        case 'vault_trash': return ['Moving to trash', 'Moved to trash', path];
        case 'canvas_shapes': return ['Reading shapes in', 'Read shapes in', path];
        case 'canvas_apply': return ['Drawing on', 'Drew on', path];
        default: return ['Running', 'Ran', name];
    }
}

/** A CLI's own tools name files by absolute path, and the row ellipsizes at its
 *  END — "Read /Users/me/Developer/…" would hide the very file it read. Keep the
 *  name and, when it is short, its folder: Codex works in a folder named by a
 *  36-character session id, which alone filled the row and hid "+2 more"
 *  (measured: 1532px of text in a 273px box). The full path is in the call's
 *  input, one click away. */
function shortPath(path: string): string {
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
function patchTarget(input: unknown): string {
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
function describeForeign(name: string, input: unknown): [string, string, string] {
    const n = name.toLowerCase();
    switch (n) {
        case 'bash':
        case 'shell': return ['Running', 'Ran', str(input, 'command')];
        case 'read': return ['Reading', 'Read', file(input)];
        case 'write': return ['Writing', 'Wrote', file(input)];
        case 'edit':
        case 'multiedit':
        case 'notebookedit': return ['Editing', 'Edited', file(input)];
        case 'apply_patch': return ['Editing', 'Edited', patchTarget(input)];
        case 'glob': return ['Finding files', 'Found files', str(input, 'pattern')];
        case 'grep': {
            const pattern = str(input, 'pattern');
            return ['Searching files for', 'Searched files for', pattern && `“${pattern}”`];
        }
        case 'agent':
        case 'task': return ['Running agent', 'Ran agent', str(input, 'description') || str(input, 'prompt')];
        case 'todowrite': return ['Updating to-dos', 'Updated to-dos', ''];
        case 'view_image': return ['Viewing', 'Viewed', shortPath(str(input, 'path'))];
        case 'websearch':
        case 'web_search':
            // Codex reports a page it opened as a web_search item with `{url}`.
            if (str(input, 'url')) return ['Opening', 'Opened', str(input, 'url')];
            return ['Searching the web for', 'Searched the web for', str(input, 'query') || str(input, 'q')];
        case 'webfetch':
        case 'web_fetch': return ['Opening', 'Opened', str(input, 'url')];
    }
    // Another MCP server's tool (Codex names it `server.tool`) is no web search
    // however it is named — `github.search_issues` must not read as one.
    if (n.includes('.')) return ['Using', 'Used', name];
    if (n.includes('search')) return ['Searching the web for', 'Searched the web for', str(input, 'query') || str(input, 'q')];
    if (n.includes('fetch')) return ['Opening', 'Opened', str(input, 'url')];
    if (n.includes('skill')) return ['Using skill', 'Used skill', str(input, 'skill') || str(input, 'name') || str(input, 'command')];
    return ['Using', 'Used', name];
}

function json(value: unknown): string {
    if (value === undefined) return '';
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function changePath(change: AgentChange): string {
    return change.kind === 'move' ? change.to : change.path;
}

function ChangeCard({ change, host }: { change: AgentChange; host: AgentHost }) {
    const openButton = change.kind === 'trash' || (change.kind === 'create' && change.folder) ? null : (
        <button type="button" className="agent-link agent-open" onClick={() => host.openFile(changePath(change))}>Open</button>
    );
    switch (change.kind) {
        case 'edit':
            return <FileDiff file={change.path} lines={change.diff} added={change.added} removed={change.removed} action={openButton} maxHeight={320} />;
        case 'create':
            if (change.folder || !change.diff.length) {
                return <div className="agent-change-line">{change.folder ? 'New folder' : 'New file'} <code>{change.path}</code>{openButton}</div>;
            }
            return (
                <FileDiff
                    file={change.path}
                    lines={change.diff}
                    added={change.diff.filter(l => l.type === 'add').length}
                    removed={0}
                    action={openButton}
                    maxHeight={320}
                />
            );
        case 'move':
            return <div className="agent-change-line"><code>{change.from}</code> → <code>{change.to}</code>{openButton}</div>;
        case 'trash':
            return <div className="agent-change-line">Moved <code>{change.path}</code> to the trash (restorable).</div>;
        case 'canvas':
            return (
                <div className="agent-change-line">
                    <span>
                        {/* The summary already names what was added/changed/removed. */}
                        {change.summary || [
                            change.created ? `${change.created} added` : '',
                            change.updated ? `${change.updated} changed` : '',
                            change.deleted ? `${change.deleted} removed` : '',
                        ].filter(Boolean).join(', ') || 'No shapes changed'}
                    </span>
                    {openButton}
                </div>
            );
    }
}

export function ToolCallCard({ item, host }: { item: ToolItem; host: AgentHost }) {
    const [open, setOpen] = useState(false);
    const [running, done, target] = item.own ? describeOwn(item.name, item.input) : describeForeign(item.name, item.input);
    const input = json(item.input);
    const hasDetail = !!input || !!item.output;
    return (
        <div className={'agent-tool' + (item.own ? '' : ' foreign') + ' ' + item.status}>
            <button
                type="button"
                className="agent-tool-row"
                aria-expanded={hasDetail ? open : undefined}
                onClick={hasDetail ? () => setOpen(o => !o) : undefined}
            >
                <span className="agent-tool-status" aria-hidden="true">
                    {item.status === 'running'
                        ? <Orb variant="S3" size={14} label="Running" />
                        : item.status === 'error' ? <AlertCircle size={13} /> : <Check size={13} />}
                </span>
                {/* "Creating X failed", never "Created X failed". */}
                <span className="agent-tool-verb">{item.status === 'done' ? done : running}</span>
                {target && <span className="agent-tool-target">{target}</span>}
                {item.status === 'error' && <span className="agent-tool-failed">failed</span>}
                {hasDetail && <ChevronRight size={12} className="agent-tool-chevron" aria-hidden="true" />}
            </button>
            {open && (
                <div className="agent-tool-detail">
                    {input && <CodeBlock lang="input" code={input} maxHeight={200} lineNumbers={false} />}
                    {item.output && <CodeBlock lang={item.status === 'error' ? 'error' : 'output'} code={item.output} maxHeight={240} lineNumbers={false} />}
                </div>
            )}
            {item.change && <div className="agent-tool-change"><ChangeCard change={item.change} host={host} /></div>}
        </div>
    );
}
