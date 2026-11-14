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
    autoStart: boolean;
    tree: FileTreeNode[];
    resolve(path: string): Promise<FileSystemFileHandle | null>;
    stat(handle: FileSystemFileHandle): Promise<{ lastModified: number; size: number } | null>;
    publish(graph: GraphData | null, activation: number, current: () => boolean): void;
    onSnapshot?(stale: boolean): void;
    onStatus?(status: IndexProgress): void;
    onTimes?(changes: [string, number, number][], sweepComplete: boolean): void;
    mediaAssets?(tree: FileTreeNode[]): Promise<[string, string[]][]>;
    onMediaChanged?(): void;
    onProblem(problem: unknown): void;
}) {
    const { root, vaultId, activation, getActivation, autoStart, tree, resolve, stat, publish, onSnapshot, onStatus, onTimes, onProblem } = options;
    const active = useRef<ActiveIndexGraph | null>(null);
    const startRef = useRef<(() => Promise<ActiveIndexGraph>) | null>(null);
    const latestTree = useRef(tree);
    const mediaOptions = useRef({ mediaAssets: options.mediaAssets, onMediaChanged: options.onMediaChanged });
    const refreshMedia = useRef<((owner: ActiveIndexGraph, tree: FileTreeNode[]) => Promise<void>) | null>(null);
    useLayoutEffect(() => { mediaOptions.current = { mediaAssets: options.mediaAssets, onMediaChanged: options.onMediaChanged }; });
    const publishedTree = useRef<IndexTreeFile[]>([]);
    const pendingMoves = useRef(new Map<string, { to: string; expires: number }>());
    useLayoutEffect(() => { latestTree.current = tree; }, [tree]);
    useEffect(() => {
        let live = true;
        let lastStatusAt = -Infinity;
        publish(null, activation, () => live && getActivation() === activation);
        if (!root) return () => { live = false; };
        let starting: Promise<ActiveIndexGraph> | undefined;
        let unsubscribeMedia: (() => void) | undefined;
        let mediaRequest = 0;
        const refresh = async (owner: ActiveIndexGraph, treeAtCall: FileTreeNode[]) => {
            const request = ++mediaRequest;
            const acquire = mediaOptions.current.mediaAssets;
            if (!acquire) return;
            const entries = await acquire(treeAtCall);
            if (request !== mediaRequest || !live || getActivation() !== activation || active.current !== owner || owner.root !== root
                || latestTree.current !== treeAtCall) return;
            await owner.client.setMediaAssets(entries);
        };
        refreshMedia.current = refresh;
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
                }, (changes, complete) => { if (live && getActivation() === activation) onTimes?.(changes, complete); });
                const echo = new WriteEchoFilter(async path => {
                    const handle = await resolve(path);
                    const version = handle ? await stat(handle) : null;
                    return version ? { mtime: version.lastModified, size: version.size } : null;
                }, paths => { void client.invalidate(paths).catch(() => {}); });
                const owner: ActiveIndexGraph = { client, echo, root, activation,
                    async regrant() {
                        client.retry();
                        const treeAtCall = latestTree.current;
                        const files = publishedTree.current = indexTree(treeAtCall);
                        await client.setTree(files);
                        if (!live || getActivation() !== activation || active.current !== owner || latestTree.current !== treeAtCall) return;
                        await refresh(owner, treeAtCall);
                        if (!live || getActivation() !== activation || active.current !== owner || latestTree.current !== treeAtCall) return;
                        await client.sweep('user');
                    },
                };
                active.current = owner;
                unsubscribeMedia = client.subscribeMedia(() => {
                    if (live && getActivation() === activation && active.current === owner) mediaOptions.current.onMediaChanged?.();
                });
                const treeAtCall = latestTree.current;
                const files = publishedTree.current = indexTree(treeAtCall);
                void client.setTree(files).then(async () => {
                    if (!live || getActivation() !== activation || active.current !== owner || latestTree.current !== treeAtCall) return;
                    await refresh(owner, treeAtCall);
                    if (live && getActivation() === activation && active.current === owner && latestTree.current === treeAtCall) await client.sweep('open');
                }).catch(error => { if (live) console.error('Could not prepare the vault index:', error); });
                return owner;
            }).catch(error => { starting = undefined; if (live) console.error('Could not start the vault index:', error); throw error; });
            return starting;
        };
        startRef.current = start;
        return () => {
            live = false;
            pendingMoves.current.clear();
            unsubscribeMedia?.();
            if (refreshMedia.current === refresh) refreshMedia.current = null;
            if (startRef.current === start) startRef.current = null;
            const owner = active.current;
            if (owner?.root === root && owner.activation === activation) {
                active.current = null;
                owner.echo.dispose();
                owner.client.dispose();
            }
        };
    }, [root, vaultId, activation, getActivation, resolve, stat, publish, onSnapshot, onStatus, onTimes, onProblem]);
    useEffect(() => {
        if (!root || !autoStart) return;
        let second = 0;
        let cancelIdle = () => {};
        // Two frames let the restored pane paint before even fetching the worker chunk.
        const first = requestAnimationFrame(() => {
            second = requestAnimationFrame(() => {
                cancelIdle = onIdle(() => { void startRef.current?.().catch(() => {}); });
            });
        });
        return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); cancelIdle(); };
    }, [root, activation, autoStart]);
    useLayoutEffect(() => {
        const owner = active.current;
        if (!owner || owner.root !== root || owner.activation !== activation) return;
        const next = indexTree(tree);
        const now = performance.now();
        const moves: { from: string; to: string }[] = [];
        for (const [from, move] of pendingMoves.current) {
            if (move.expires > now) moves.push({ from, to: move.to });
            else pendingMoves.current.delete(from);
        }
        const delta = indexTreeDelta(publishedTree.current, next, moves);
        for (const move of delta?.renamed ?? []) pendingMoves.current.delete(move.from);
        publishedTree.current = next;
        if (!delta) owner.client.suspendMedia();
        void (delta ? owner.client.treeDelta(delta) : Promise.resolve()).then(async () => {
            if (active.current !== owner || owner.activation !== getActivation() || latestTree.current !== tree) return;
            await refreshMedia.current?.(owner, tree);
        }).catch(() => {});
    }, [tree, root, activation]);
    return Object.assign(active, {
        whenReady: () => active.current ? Promise.resolve(active.current)
            : startRef.current ? startRef.current() : Promise.reject(new DOMException('Vault index unavailable', 'AbortError')),
        noteMoves: (moves: readonly { from: string; to: string }[]) => {
            const owner = active.current;
            if (!owner || owner.activation !== getActivation()) return () => {};
            const recorded: [string, { to: string; expires: number }][] = [];
            for (const { from, to } of moves) for (const file of publishedTree.current) {
                if (file.path !== from && !file.path.startsWith(`${from}/`)) continue;
                const move = { to: to + file.path.slice(from.length), expires: performance.now() + 60_000 };
                pendingMoves.current.set(file.path, move);
                recorded.push([file.path, move]);
            }
            return () => { for (const [path, move] of recorded) if (pendingMoves.current.get(path) === move) pendingMoves.current.delete(path); };
        },
    });
}
