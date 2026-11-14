import { useEffect, useLayoutEffect, useRef } from 'react';
import type { FileTreeNode, GraphData } from '../../types';
import { onIdle } from '../../utils/pool';
import type { VaultIndexClient, IndexTreeFile } from './client';
import { graphForTree } from './graphView';
import { newIndexSession } from './session';
import { indexTree, indexTreeDelta } from './tree';
import { WriteEchoFilter } from './writeEcho';

export interface IndexProgress { phase: 'sweeping' | 'idle'; done: number; total: number }

export interface ActiveIndexGraph {
    client: VaultIndexClient;
    echo: WriteEchoFilter;
    root: FileSystemDirectoryHandle;
    activation: number;
    regrant(): Promise<void>;
}

/** The owner is an activation, not a directory object or a mounted pane. */
export function useIndexGraph(options: {
    root: FileSystemDirectoryHandle | null;
    vaultId: string | null;
    activation: number;
    getActivation(): number;
    tree: FileTreeNode[];
    resolve(path: string): Promise<FileSystemFileHandle | null>;
    stat(handle: FileSystemFileHandle): Promise<{ lastModified: number; size: number } | null>;
    publish(graph: GraphData | null, activation: number, current: () => boolean): void;
    onSnapshot?(stale: boolean): void;
    onStatus?(status: IndexProgress): void;
    onProblem(problem: unknown): void;
}) {
    const { root, vaultId, activation, getActivation, tree, resolve, stat, publish, onSnapshot, onStatus, onProblem } = options;
    const active = useRef<ActiveIndexGraph | null>(null);
    const startRef = useRef<(() => Promise<ActiveIndexGraph>) | null>(null);
    const latestTree = useRef(tree);
    const publishedTree = useRef<IndexTreeFile[]>([]);
    useLayoutEffect(() => { latestTree.current = tree; }, [tree]);
    useEffect(() => {
        let live = true;
        let lastStatusAt = -Infinity;
        publish(null, activation, () => live && getActivation() === activation);
        if (!root) return () => { live = false; };
        let starting: Promise<ActiveIndexGraph> | undefined;
        const start = () => {
            if (starting) return starting;
            starting = import('./client').then(({ VaultIndexClient }) => {
                if (!live || getActivation() !== activation) throw new DOMException('Vault changed', 'AbortError');
                const session = newIndexSession(vaultId ?? `activation:${activation}`);
                const client: VaultIndexClient = new VaultIndexClient(session, snapshot => {
                    const treeAtReply = latestTree.current;
                    const epoch = client.publicationEpoch;
                    const current = () => live && getActivation() === activation && active.current?.client === client
                        && latestTree.current === treeAtReply && client.acceptsGraph(snapshot.graphGen, snapshot.treeGen, epoch);
                    if (!current()) return;
                    const graph = graphForTree(snapshot, treeAtReply);
                    if (graph) { publish(graph, activation, current); onSnapshot?.(snapshot.stale); }
                }, problem => { if (live && getActivation() === activation) onProblem(problem); }, status => {
                    if (!live || getActivation() !== activation) return;
                    const progress = status as IndexProgress;
                    const now = performance.now();
                    // A sweep reports every eight files; avoid rerendering the
                    // whole workspace over a thousand times in a 10k-note vault.
                    if (progress.phase !== 'idle' && progress.done !== 0 && now - lastStatusAt < 250) return;
                    lastStatusAt = now;
                    onStatus?.(progress);
                });
                const echo = new WriteEchoFilter(async path => {
                    const handle = await resolve(path);
                    const version = handle ? await stat(handle) : null;
                    return version ? { mtime: version.lastModified, size: version.size } : null;
                }, paths => { void client.invalidate(paths).catch(() => {}); });
                const owner: ActiveIndexGraph = { client, echo, root, activation,
                    async regrant() {
                        client.retry();
                        const files = publishedTree.current = indexTree(latestTree.current);
                        await client.setTree(files);
                        await client.sweep('user');
                    },
                };
                active.current = owner;
                const files = publishedTree.current = indexTree(latestTree.current);
                void client.setTree(files).then(() => client.sweep('open')).catch(() => {});
                return owner;
            }).catch(error => { starting = undefined; if (live) console.error('Could not start the vault index:', error); throw error; });
            return starting;
        };
        startRef.current = start;
        const cancelIdle = onIdle(() => { void start().catch(() => {}); });
        return () => {
            live = false;
            if (startRef.current === start) startRef.current = null;
            cancelIdle();
            const owner = active.current;
            if (owner?.root === root && owner.activation === activation) {
                active.current = null;
                owner.echo.dispose();
                owner.client.dispose();
            }
        };
    }, [root, vaultId, activation, getActivation, resolve, stat, publish, onSnapshot, onStatus, onProblem]);
    useLayoutEffect(() => {
        const owner = active.current;
        if (!owner || owner.root !== root || owner.activation !== activation) return;
        const next = indexTree(tree);
        const delta = indexTreeDelta(publishedTree.current, next);
        publishedTree.current = next;
        if (delta) void owner.client.treeDelta(delta).catch(() => {});
    }, [tree, root, activation]);
    return Object.assign(active, { whenReady: () => active.current ? Promise.resolve(active.current)
        : startRef.current ? startRef.current() : Promise.reject(new DOMException('Vault index unavailable', 'AbortError')) });
}
