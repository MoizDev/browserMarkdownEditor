import { serve } from '../../platform/workers/serve';
import type { WorkerContext } from '../../platform/workers/serve';
import type { IndexFile, IndexSession } from '../../utils/vaultIndex/types';
import { IndexEngine } from './engine';
import { HandleReader } from './reader';

type HandleFile = IndexFile & { handle: FileSystemFileHandle };
type SessionArgs = { session: IndexSession };
type TreeArgs = SessionArgs & { treeGen: number };
let engine: IndexEngine | undefined;
let reader: HandleReader | undefined;
let pending: { treeGen: number; files: HandleFile[] } | undefined;

function current(session: IndexSession): IndexEngine | undefined {
    return engine?.session.sessionNo === session.sessionNo && engine.session.vaultId === session.vaultId ? engine : undefined;
}
function problem(context: WorkerContext, session: IndexSession, error: unknown): void {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
        context.emit('problem', { session, kind: 'permission', detail: error.message });
    } else throw error;
}
serve({ protocol: 1, buildId: 'vault-index-1', handlers: {
    open(value, context) {
        const { session } = value as SessionArgs;
        engine?.close();
        reader = new HandleReader();
        pending = undefined;
        engine = new IndexEngine(session, reader, graph => context.emit('graph', graph, [graph.edges.buffer]),
            (phase, done, total) => context.emit('status', { session, phase, done, total }));
        return null;
    },
    close(value) {
        const { session } = value as SessionArgs;
        if (current(session)) { engine?.close(); engine = undefined; reader = undefined; pending = undefined; }
        return null;
    },
    treeBegin(value) {
        const { session, treeGen } = value as TreeArgs;
        if (current(session) && (!pending || treeGen > pending.treeGen)) pending = { treeGen, files: [] };
        return null;
    },
    treeChunk(value) {
        const { session, treeGen, files } = value as TreeArgs & { files: HandleFile[] };
        if (current(session) && pending?.treeGen === treeGen) pending.files.push(...files);
        return null;
    },
    treeCommit(value) {
        const { session, treeGen } = value as TreeArgs;
        const active = current(session);
        if (!active || !reader || !pending || pending.treeGen !== treeGen) return null;
        const files = pending.files;
        pending = undefined;
        if (active.store.setTree(treeGen, files.map(({ path, kind }) => ({ path, kind })))) {
            reader.handles.clear();
            for (const file of files) reader.handles.set(file.path, file.handle);
            active.publishGraph(true);
        }
        return null;
    },
    treeDelta(value) {
        const { session, treeGen, added, removed, renamed, order } = value as TreeArgs & {
            added: HandleFile[]; removed: string[]; renamed: { from: string; to: string; kind: string; handle: FileSystemFileHandle }[]; order?: string[];
        };
        const active = current(session);
        if (active && reader && active.store.treeDelta(treeGen, added, removed, renamed, order)) {
            for (const path of removed) reader.handles.delete(path);
            for (const item of renamed) { reader.handles.delete(item.from); reader.handles.set(item.to, item.handle); }
            for (const file of added) reader.handles.set(file.path, file.handle);
            active.publishGraph(true);
        }
        return null;
    },
    async prime(value, context) {
        const { session, path, mtime, size, text } = value as SessionArgs & { path: string; mtime: number; size: number; text: string };
        await current(session)?.prime(path, mtime, size, text, context);
        return null;
    },
    fgio(value) {
        const { session, active } = value as SessionArgs & { active: number };
        current(session)?.foregroundIO(active);
        return null;
    },
    async sweep(value, context) {
        const { session } = value as SessionArgs;
        try { await current(session)?.sweep(context); } catch (error) { problem(context, session, error); }
        return null;
    },
    async invalidate(value, context) {
        const { session, paths } = value as SessionArgs & { paths: string[] };
        try { await current(session)?.invalidate(paths, context); } catch (error) { problem(context, session, error); }
        return null;
    },
} });
