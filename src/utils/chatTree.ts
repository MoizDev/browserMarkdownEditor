// A chat that forks: the conversation as a TREE, not a list.
//
// WHY A TREE AT ALL. Editing a message you already sent is editing the
// conversation's past, and the turns below it answered the words you just
// changed — so they cannot stay. Throwing them away is the easy version and the
// wrong one: the whole value of an edit is being able to compare, go back, and
// take the other road. So an edit adds a SIBLING of the message it changes, the
// thread under the old one is kept intact, and `‹ 2/3 ›` walks between them.
//
// WHY THE APP HAS TO OWN IT. Until now a conversation lived in the agent CLI's
// own store and was read back through the helper (`session.history`). A CLI
// session is a LINE — Claude Code, Codex and OpenCode all record one turn after
// another — and no amount of reading it back produces a fork. So the transcript
// moves here, into `.VaultAgent/chats/<chatId>.json`, and the CLI's own history
// becomes what it should always have been: a fallback for chats that predate
// this, and a way to recover one whose tree was lost.
//
// THE SHAPE, and the two things it keeps honest:
//
//   · A NODE IS ONE TURN. `user` nodes hold what was typed; `assistant` nodes
//     hold the reply, the reasoning, the tool calls it made, and the CLI session
//     that produced it. Children are in creation order, which is what makes
//     "version 2 of 3" stable and meaningful.
//   · THE ACTIVE PATH IS A LEAF, not a list of choices. Everything the panel
//     draws is `pathTo(leaf)`, and switching branches is choosing a different
//     leaf. One pointer cannot disagree with itself; a per-depth list of
//     selected children (the obvious alternative) can, and does, the moment a
//     branch is deeper than the one it replaced.
//
// Pure: no React, no storage, no bridge. The store applies these; agentHost
// reads and writes the file.

export type ChatRole = 'user' | 'assistant';

/** A tool call as the transcript remembers it — enough to redraw its card. */
export interface StoredTool {
    callId: string;
    name: string;
    input?: unknown;
    output?: string;
    status: 'done' | 'error';
    /** Ours (`vault_*`/`canvas_*`), as opposed to the agent's own tools. */
    own: boolean;
    /** The change card's summary, kept so a reloaded chat still shows what the
     *  agent did rather than a bare tool name. */
    change?: unknown;
}

/**
 * One piece of an assistant turn, in the order it streamed.
 *
 * WHY THIS EXISTS. A turn is not "some thinking, some tools, then the answer":
 * the agent says what it is about to do, does it, and says what it did, and a
 * change card belongs right under the sentence that introduced it. The flat
 * fields (`text`, `reasoning`, `tools`) cannot hold that order, and drawing a
 * turn from them regrouped every tool above the reply the moment the next
 * message was sent (measured: thesis turn, 8 rows → 7, the edit card moved
 * above the text that announced it, "Thought for 1s" became "Thought").
 *
 * `id` IS THE LIVE ITEM'S ID, kept so the turn redrawn from the tree is the
 * same React element it was while streaming: nothing remounts, a reply's view
 * keeps its height, and the list does not jump.
 *
 * A tool segment points into `tools` by index rather than copying it: a tool's
 * input and output are the bulk of a turn, and the flat `tools` array is what
 * a build without segments still reads.
 */
export type StoredSegment =
    | { kind: 'text'; id: string; text: string }
    | { kind: 'reasoning'; id: string; text: string; startedAt?: number; endedAt?: number }
    | { kind: 'tool'; id: string; tool: number }
    | { kind: 'notice'; id: string; tone: 'info' | 'warning' | 'error'; message: string };

export interface ChatNode {
    id: string;
    /** null for the first message of the chat. */
    parent: string | null;
    role: ChatRole;
    text: string;
    createdAt: number;
    /** user: how many images rode along (the thumbnails themselves are object
     *  URLs, which die with the page). */
    images?: number;
    /** assistant: the CLI session that produced this turn. A branch gets its
     *  own, which is how a fork stays a fork on the agent's side too. */
    sessionId?: string | null;
    /** assistant: what it thought and what it did. */
    reasoning?: string;
    tools?: StoredTool[];
    /** assistant: the run ended badly, and the text is the reason. */
    error?: boolean;
    /**
     * assistant: the turn as it streamed (see StoredSegment). OPTIONAL, and
     * the flat fields above are still written beside it, which is the whole
     * compatibility story — no version bump:
     *   · a file from before segments has none, and is drawn from the flat
     *     fields in their old fixed order;
     *   · a build from before segments reads the flat fields and drops this
     *     key, so it shows the old order but loses nothing else.
     * `text`/`reasoning` duplicate the text segments' words; tools are not
     * duplicated (segments index into `tools`).
     */
    segments?: StoredSegment[];
    /** assistant: the model id the run asked for (the CLI default's own id
     *  when the chat had none chosen), when it was known. */
    model?: string;
}

export interface ChatTree {
    version: 1;
    /** Every node, by id. */
    nodes: Record<string, ChatNode>;
    /** Child ids in creation order. `ROOT` holds the first message's versions. */
    children: Record<string, string[]>;
    /** The end of the branch being shown; null for an empty chat. */
    activeLeaf: string | null;
    /** Unknown keys a newer build wrote, carried through untouched. */
    [key: string]: unknown;
}

/** The key `children` uses for "no parent" — a tree can have several first
 *  messages, because the first message is editable too. */
export const ROOT = '';

export function emptyTree(): ChatTree {
    return { version: 1, nodes: {}, children: { [ROOT]: [] }, activeLeaf: null };
}

/* ───────────────────────── reading ───────────────────────── */

/** Root → `leaf`, in order. An id that is not in the tree gives []. */
export function pathTo(tree: ChatTree, leaf: string | null): ChatNode[] {
    const out: ChatNode[] = [];
    const seen = new Set<string>();
    let id = leaf;
    while (id) {
        const node = tree.nodes[id];
        // A cycle cannot happen through the writers below, but a hand-edited
        // file is the user's to break; refusing to hang is worth four lines.
        if (!node || seen.has(id)) break;
        seen.add(id);
        out.push(node);
        id = node.parent;
    }
    return out.reverse();
}

/** The branch on screen. */
export function activePath(tree: ChatTree): ChatNode[] {
    return pathTo(tree, tree.activeLeaf);
}

export function siblingsOf(tree: ChatTree, id: string): string[] {
    const node = tree.nodes[id];
    if (!node) return [];
    return tree.children[node.parent ?? ROOT] ?? [];
}

/** Where this message sits among its versions: `{ index: 1, count: 3 }` is
 *  "2 of 3" to a reader. A node with no siblings answers `count: 1`. */
export function versionOf(tree: ChatTree, id: string): { index: number; count: number } {
    const siblings = siblingsOf(tree, id);
    const index = siblings.indexOf(id);
    return { index: index < 0 ? 0 : index, count: siblings.length || 1 };
}

/**
 * The deepest node reachable from `id` by always taking the LAST child.
 *
 * Last, not first: the newest branch is the one just made, and landing on it is
 * what a reader expects after an edit. (Switching to an older sibling then
 * follows that sibling's own newest line — `lastLeafFrom` is used for both.)
 */
export function lastLeafFrom(tree: ChatTree, id: string): string {
    let current = id;
    const seen = new Set<string>();
    for (;;) {
        if (seen.has(current)) return current;
        seen.add(current);
        const kids = tree.children[current] ?? [];
        if (!kids.length) return current;
        current = kids[kids.length - 1];
    }
}

/** Every leaf, oldest first — what "all the versions of this chat" means. */
export function leaves(tree: ChatTree): string[] {
    return Object.keys(tree.nodes).filter(id => !(tree.children[id] ?? []).length);
}

export function isEmpty(tree: ChatTree): boolean {
    return Object.keys(tree.nodes).length === 0;
}

/** The last assistant turn on the active branch — whose CLI session the next
 *  message continues in. Null when this branch has not run yet, which is
 *  exactly when a new session has to be started. */
export function activeSessionId(tree: ChatTree): string | null {
    const path = activePath(tree);
    for (let i = path.length - 1; i >= 0; i--) {
        const node = path[i];
        if (node.role === 'assistant' && node.sessionId) return node.sessionId;
    }
    return null;
}

/* ───────────────────────── writing ─────────────────────────
   Every writer returns a NEW tree: the store holds it in React state, and a
   mutation in place would not re-render. */

function withNode(tree: ChatTree, node: ChatNode): ChatTree {
    const parentKey = node.parent ?? ROOT;
    const siblings = tree.children[parentKey] ?? [];
    return {
        ...tree,
        nodes: { ...tree.nodes, [node.id]: node },
        children: { ...tree.children, [parentKey]: [...siblings, node.id] },
    };
}

/** Add a turn at the end of the active branch, and show it. */
export function append(tree: ChatTree, node: Omit<ChatNode, 'parent'>): ChatTree {
    const full: ChatNode = { ...node, parent: tree.activeLeaf };
    return { ...withNode(tree, full), activeLeaf: full.id };
}

/**
 * A new version of `id`: same parent, new text, and the thread under the old
 * one left exactly where it is.
 *
 * Returns the tree with the new node as the active leaf — it has no children
 * yet, so the panel shows the branch ending at the edited message while its
 * answer is generated.
 */
export function branchFrom(
    tree: ChatTree,
    id: string,
    node: Omit<ChatNode, 'parent' | 'role'>,
): ChatTree {
    const original = tree.nodes[id];
    if (!original) return tree;
    const full: ChatNode = { ...node, parent: original.parent, role: original.role };
    return { ...withNode(tree, full), activeLeaf: full.id };
}

/** Switch to another version of a message: show `id`'s own newest line. */
export function selectVersion(tree: ChatTree, id: string): ChatTree {
    if (!tree.nodes[id]) return tree;
    return { ...tree, activeLeaf: lastLeafFrom(tree, id) };
}

/* ───────────────────────── storage ───────────────────────── */

function finite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * A node's segments, or undefined to draw it from its flat fields instead.
 *
 * All or nothing: one segment this build cannot read (a hand edit, a tool
 * index past the end of `tools`, a kind from a newer build) and the node falls
 * back to the flat fields, which hold everything — only the order is lost.
 * Half a turn in the right order would be worse than all of it in the old one.
 */
function parseSegments(raw: unknown, toolCount: number): StoredSegment[] | undefined {
    if (!Array.isArray(raw) || !raw.length) return undefined;
    const out: StoredSegment[] = [];
    const ids = new Set<string>();
    for (const value of raw) {
        if (!value || typeof value !== 'object') return undefined;
        const s = value as Record<string, unknown>;
        // Ids become React keys; a repeat would make two rows one.
        if (typeof s.id !== 'string' || !s.id || ids.has(s.id)) return undefined;
        ids.add(s.id);
        if (s.kind === 'text' && typeof s.text === 'string') {
            out.push({ kind: 'text', id: s.id, text: s.text });
        } else if (s.kind === 'reasoning' && typeof s.text === 'string') {
            out.push({
                kind: 'reasoning', id: s.id, text: s.text,
                ...(finite(s.startedAt) ? { startedAt: s.startedAt } : {}),
                ...(finite(s.endedAt) ? { endedAt: s.endedAt } : {}),
            });
        } else if (s.kind === 'tool' && Number.isInteger(s.tool) && (s.tool as number) >= 0 && (s.tool as number) < toolCount) {
            out.push({ kind: 'tool', id: s.id, tool: s.tool as number });
        } else if (s.kind === 'notice' && typeof s.message === 'string'
            && (s.tone === 'info' || s.tone === 'warning' || s.tone === 'error')) {
            out.push({ kind: 'notice', id: s.id, tone: s.tone, message: s.message });
        } else {
            return undefined;
        }
    }
    return out;
}

/**
 * Parse a tree file.
 *
 * Defensive on every field: this file is in the user's vault, where they can
 * edit it, a sync service can half-write it, and a future build may add keys.
 * Anything unrecognisable degrades to an empty chat rather than a broken panel —
 * and the CLI's own history is still there to fall back on.
 */
export function parseTree(text: string | null): ChatTree {
    if (!text) return emptyTree();
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return emptyTree();
    }
    if (!raw || typeof raw !== 'object') return emptyTree();
    const record = raw as Record<string, unknown>;
    const rawNodes = record.nodes;
    if (!rawNodes || typeof rawNodes !== 'object') return emptyTree();

    const nodes: Record<string, ChatNode> = {};
    for (const [id, value] of Object.entries(rawNodes as Record<string, unknown>)) {
        const n = value as Partial<ChatNode> | null;
        if (!n || typeof n !== 'object') continue;
        if (n.role !== 'user' && n.role !== 'assistant') continue;
        if (typeof n.text !== 'string') continue;
        const tools = Array.isArray(n.tools) ? n.tools as StoredTool[] : undefined;
        const segments = parseSegments((n as Record<string, unknown>).segments, tools?.length ?? 0);
        // Spread first: keys a newer build put on a node survive this one
        // rewriting the file (the index does the same, vaultAgentStore.ts).
        const { segments: _rawSegments, model: _rawModel, ...rest } = n as Record<string, unknown>;
        nodes[id] = {
            ...rest,
            id,
            parent: typeof n.parent === 'string' && n.parent ? n.parent : null,
            role: n.role,
            text: n.text,
            createdAt: typeof n.createdAt === 'number' ? n.createdAt : Date.now(),
            ...(typeof n.images === 'number' ? { images: n.images } : {}),
            ...(typeof n.sessionId === 'string' ? { sessionId: n.sessionId } : {}),
            ...(typeof n.reasoning === 'string' ? { reasoning: n.reasoning } : {}),
            ...(tools ? { tools } : {}),
            ...(n.error === true ? { error: true } : {}),
            ...(segments ? { segments } : {}),
            ...(typeof n.model === 'string' && n.model ? { model: n.model } : {}),
        } as ChatNode;
    }
    // A parent that did not survive the loop above would orphan its children;
    // rebuilding `children` from the nodes themselves cannot disagree with them.
    const children: Record<string, string[]> = { [ROOT]: [] };
    const storedOrder = (record.children ?? {}) as Record<string, unknown>;
    const ordered = (parent: string): string[] => {
        const stored = storedOrder[parent];
        const valid = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string' && !!nodes[id]) : [];
        const rest = Object.keys(nodes)
            .filter(id => (nodes[id].parent ?? ROOT) === parent && !valid.includes(id))
            .sort((a, b) => nodes[a].createdAt - nodes[b].createdAt);
        return [...valid.filter(id => (nodes[id].parent ?? ROOT) === parent), ...rest];
    };
    for (const parent of new Set([ROOT, ...Object.keys(nodes)])) {
        const kids = ordered(parent);
        if (kids.length || parent === ROOT) children[parent] = kids;
    }

    const activeLeaf = typeof record.activeLeaf === 'string' && nodes[record.activeLeaf] ? record.activeLeaf : null;
    const tree: ChatTree = { ...record, version: 1, nodes, children, activeLeaf };
    // A file whose activeLeaf was lost still has to show something.
    if (!tree.activeLeaf) tree.activeLeaf = leaves(tree).pop() ?? null;
    return tree;
}

export function serializeTree(tree: ChatTree): string {
    return JSON.stringify(tree, null, 2) + '\n';
}
