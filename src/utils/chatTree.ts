export type ChatRole = 'user' | 'assistant';

export interface StoredTool {
    callId: string;
    name: string;
    input?: unknown;
    output?: string;
    status: 'done' | 'error';
    own: boolean;
    change?: unknown;
}

export interface ChatNode {
    id: string;
    parent: string | null;
    role: ChatRole;
    text: string;
    createdAt: number;
    images?: number;
    sessionId?: string | null;
    reasoning?: string;
    tools?: StoredTool[];
    error?: boolean;
}

export interface ChatTree {
    version: 1;
    nodes: Record<string, ChatNode>;
    children: Record<string, string[]>;
    activeLeaf: string | null;
    [key: string]: unknown;
}

export const ROOT = '';

export function emptyTree(): ChatTree {
    return { version: 1, nodes: {}, children: { [ROOT]: [] }, activeLeaf: null };
}

export function pathTo(tree: ChatTree, leaf: string | null): ChatNode[] {
    const out: ChatNode[] = [];
    const seen = new Set<string>();
    let id = leaf;
    while (id) {
        const node = tree.nodes[id];
        if (!node || seen.has(id)) break;
        seen.add(id);
        out.push(node);
        id = node.parent;
    }
    return out.reverse();
}

export function activePath(tree: ChatTree): ChatNode[] {
    return pathTo(tree, tree.activeLeaf);
}

export function siblingsOf(tree: ChatTree, id: string): string[] {
    const node = tree.nodes[id];
    if (!node) return [];
    return tree.children[node.parent ?? ROOT] ?? [];
}

export function versionOf(tree: ChatTree, id: string): { index: number; count: number } {
    const siblings = siblingsOf(tree, id);
    const index = siblings.indexOf(id);
    return { index: index < 0 ? 0 : index, count: siblings.length || 1 };
}

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

export function leaves(tree: ChatTree): string[] {
    return Object.keys(tree.nodes).filter(id => !(tree.children[id] ?? []).length);
}

export function isEmpty(tree: ChatTree): boolean {
    return Object.keys(tree.nodes).length === 0;
}

export function activeSessionId(tree: ChatTree): string | null {
    const path = activePath(tree);
    let candidate: string | null = null;
    for (let i = path.length - 1; i >= 0 && !candidate; i--) candidate = path[i].sessionId ?? null;
    if (!candidate) return null;
    const onPath = new Set(path.map(node => node.id));
    for (const node of Object.values(tree.nodes)) {
        if (node.sessionId === candidate && !onPath.has(node.id)) return null;
    }
    return candidate;
}

function withNode(tree: ChatTree, node: ChatNode): ChatTree {
    const parentKey = node.parent ?? ROOT;
    const siblings = tree.children[parentKey] ?? [];
    return {
        ...tree,
        nodes: { ...tree.nodes, [node.id]: node },
        children: { ...tree.children, [parentKey]: [...siblings, node.id] },
    };
}

export function append(tree: ChatTree, node: Omit<ChatNode, 'parent'>): ChatTree {
    const full: ChatNode = { ...node, parent: tree.activeLeaf };
    return { ...withNode(tree, full), activeLeaf: full.id };
}

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

export function tagSession(tree: ChatTree, id: string, sessionId: string): ChatTree {
    const node = tree.nodes[id];
    if (!node || node.sessionId) return tree;
    return { ...tree, nodes: { ...tree.nodes, [id]: { ...node, sessionId } } };
}

export function selectVersion(tree: ChatTree, id: string): ChatTree {
    if (!tree.nodes[id]) return tree;
    return { ...tree, activeLeaf: lastLeafFrom(tree, id) };
}

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
        nodes[id] = {
            id,
            parent: typeof n.parent === 'string' && n.parent ? n.parent : null,
            role: n.role,
            text: n.text,
            createdAt: typeof n.createdAt === 'number' ? n.createdAt : Date.now(),
            ...(typeof n.images === 'number' ? { images: n.images } : {}),
            ...(typeof n.sessionId === 'string' ? { sessionId: n.sessionId } : {}),
            ...(typeof n.reasoning === 'string' ? { reasoning: n.reasoning } : {}),
            ...(Array.isArray(n.tools) ? { tools: n.tools as StoredTool[] } : {}),
            ...(n.error === true ? { error: true } : {}),
        };
    }
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
    if (!tree.activeLeaf) tree.activeLeaf = leaves(tree).pop() ?? null;
    return tree;
}

export function serializeTree(tree: ChatTree): string {
    return JSON.stringify(tree, null, 2) + '\n';
}
