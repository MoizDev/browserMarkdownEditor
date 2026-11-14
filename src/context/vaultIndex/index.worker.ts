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
const primes = new Map<string, { rev: number; mtime: number; size: number; text: string }>();

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
        primes.clear();
        let lastStatus = -Infinity;
        engine = new IndexEngine(session, reader, graph => context.emit('graph', graph, [graph.edges.buffer, graph.degrees.buffer]),
            (phase, done, total) => {
                const now = performance.now();
                if (phase !== 'idle' && done !== 0 && now - lastStatus < 100) return;
                lastStatus = now;
                context.emit('status', { session, phase, done, total });
            });
        return null;
    },
    close(value) {
        const { session } = value as SessionArgs;
        if (current(session)) { engine?.close(); engine = undefined; reader = undefined; pending = undefined; primes.clear(); }
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
        }
        return null;
    },
    async graph(value, context) {
        const { session, stale } = value as SessionArgs & { stale?: boolean };
        await current(session)?.publishGraph(context, stale);
        return null;
    },
    primeReserve(value) {
        const { session, path, mtime, size, text } = value as SessionArgs & { path: string; mtime: number; size: number; text: string };
        const rev = current(session)?.store.reservePrime(path);
        if (rev !== undefined) primes.set(path, { rev, mtime, size, text });
        return rev ?? null;
    },
    async primeCommit(value, context) {
        const { session, path, rev } = value as SessionArgs & { path: string; rev: number };
        const active = current(session);
        const prime = primes.get(path);
        if (active && prime?.rev === rev) {
            primes.delete(path);
            await active.prime(path, rev, prime.mtime, prime.size, prime.text, context);
        }
        return null;
    },
    fgio(value) {
        const { session, active } = value as SessionArgs & { active: number };
        current(session)?.foregroundIO(active);
        return null;
    },
    async sweepBatch(value, context) {
        const { session, start, treeGen } = value as SessionArgs & { start: number; treeGen: number };
        try { return await current(session)?.sweepBatch(start, treeGen, context) ?? null; }
        catch (error) { problem(context, session, error); return null; }
    },
    async invalidate(value, context) {
        const { session, paths } = value as SessionArgs & { paths: string[] };
        try { await current(session)?.invalidate(paths, context); } catch (error) { problem(context, session, error); }
        return null;
    },
} });
