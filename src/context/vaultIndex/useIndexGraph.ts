import { useEffect, useLayoutEffect, useRef } from 'react';
import type { FileTreeNode, GraphData } from '../../types';
import { onIdle } from '../../utils/pool';
import type { VaultIndexClient, IndexTreeFile } from './client';
import { graphForTree } from './graphView';
import { newIndexSession } from './session';
import { indexTree, indexTreeDelta } from './tree';
import { WriteEchoFilter } from './writeEcho';

export interface ActiveIndexGraph {
    client: VaultIndexClient;
    echo: WriteEchoFilter;
    root: FileSystemDirectoryHandle;
    activation: number;
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
}) {
    const { root, vaultId, activation, getActivation, tree, resolve, stat, publish } = options;
    const active = useRef<ActiveIndexGraph | null>(null);
    const latestTree = useRef(tree);
    const publishedTree = useRef<IndexTreeFile[]>([]);
    useLayoutEffect(() => { latestTree.current = tree; }, [tree]);
    useEffect(() => {
        let live = true;
        publish(null, activation, () => live && getActivation() === activation);
        if (!root) return () => { live = false; };
        const cancelIdle = onIdle(() => {
            void import('./client').then(({ VaultIndexClient }) => {
                if (!live || getActivation() !== activation) return;
                const session = newIndexSession(vaultId ?? `activation:${activation}`);
                const client: VaultIndexClient = new VaultIndexClient(session, snapshot => {
                    const treeAtReply = latestTree.current;
                    const epoch = client.publicationEpoch;
                    const current = () => live && getActivation() === activation && active.current?.client === client
                        && latestTree.current === treeAtReply && client.acceptsGraph(snapshot.graphGen, snapshot.treeGen, epoch);
                    if (!current()) return;
                    const graph = graphForTree(snapshot, treeAtReply);
                    if (graph) publish(graph, activation, current);
                }, problem => { console.error('Vault index problem:', problem); });
                const echo = new WriteEchoFilter(async path => {
                    const handle = await resolve(path);
                    const version = handle ? await stat(handle) : null;
                    return version ? { mtime: version.lastModified, size: version.size } : null;
                }, paths => { void client.invalidate(paths).catch(() => {}); });
                active.current = { client, echo, root, activation };
                const files = publishedTree.current = indexTree(latestTree.current);
                void client.setTree(files).then(() => client.sweep('open')).catch(() => {});
            }).catch(error => { if (live) console.error('Could not start the vault index:', error); });
        });
        return () => {
            live = false;
            cancelIdle();
            const owner = active.current;
            if (owner?.root === root && owner.activation === activation) {
                active.current = null;
                owner.echo.dispose();
                owner.client.dispose();
            }
        };
    }, [root, vaultId, activation, getActivation, resolve, stat, publish]);
    useLayoutEffect(() => {
        const owner = active.current;
        if (!owner || owner.root !== root || owner.activation !== activation) return;
        const next = indexTree(tree);
        const delta = indexTreeDelta(publishedTree.current, next);
        publishedTree.current = next;
        if (delta) void owner.client.treeDelta(delta).catch(() => {});
    }, [tree, root, activation]);
    return active;
}
