import { serve } from '../../platform/workers/serve';
import type { WorkerContext } from '../../platform/workers/serve';
import type { IndexFile, IndexSession } from '../../utils/vaultIndex/types';
import { IndexEngine } from './engine';
import { HandleReader } from './reader';
import { SearchResidency } from './searchResidency';
import { searchSidebar, type SearchOverlay } from './workerSearch';
import { matchAgentSearch } from '../../utils/agentMatcher/client';
import { isTextFile } from '../../utils/vaultSearch';
import { isCanvasFile } from '../../utils/fileTypes';

type HandleFile = IndexFile & { handle: FileSystemFileHandle };
type SessionArgs = { session: IndexSession };
type TreeArgs = SessionArgs & { treeGen: number };
let engine: IndexEngine | undefined;
let reader: HandleReader | undefined;
let searchText: SearchResidency | undefined;
const overlays = new Map<string, SearchOverlay>();
const overlayRevisions = new Map<string, number>();
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
    ready() { return null; },
    open(value, context) {
        const { session } = value as SessionArgs;
        engine?.close();
        searchText?.dispose();
        reader = new HandleReader();
        pending = undefined;
        primes.clear(); overlays.clear(); overlayRevisions.clear();
        let lastStatus = -Infinity;
        engine = new IndexEngine(session, reader, graph => context.emit('graph', graph, [graph.edges.buffer, graph.degrees.buffer]),
            (phase, done, total) => {
                const now = performance.now();
                if (phase !== 'idle' && done !== 0 && now - lastStatus < 100) return;
                lastStatus = now;
                context.emit('status', { session, phase, done, total });
            }, (changes, sweepComplete) => {
                context.emit('fileTimes', { session, changes, sweepComplete });
                if (sweepComplete) context.emit('searchChanged', { session });
            });
        const owner = engine;
        searchText = new SearchResidency((file, work) => owner.searchStat(file, work), () => current(session) === owner, (path, mtime, size) => {
            const persistent = owner as IndexEngine & { readPersistedText?: (path: string, mtime: number, size: number) => Promise<string | undefined> };
            return persistent.readPersistedText?.(path, mtime, size) ?? Promise.resolve(undefined);
        });
        return null;
    },
    close(value) {
        const { session } = value as SessionArgs;
        if (current(session)) { engine?.close(); searchText?.dispose(); searchText = undefined; engine = undefined; reader = undefined; pending = undefined; primes.clear(); overlays.clear(); overlayRevisions.clear(); }
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
            searchText?.setTree(treeGen, active.store.files);
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
            searchText?.invalidate([...removed, ...added.map(file => file.path), ...renamed.flatMap(file => [file.from, file.to])]);
            searchText?.setTree(treeGen, active.store.files);
            for (const path of removed) overlays.delete(path);
            for (const item of renamed) { overlays.delete(item.from); overlays.delete(item.to); }
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
        if (rev !== undefined) { primes.set(path, { rev, mtime, size, text }); searchText?.prime(path, mtime, size, text); }
        return rev ?? null;
    },
    primeText(value) {
        const { session, path, mtime, size, text } = value as SessionArgs & { path: string; mtime: number; size: number; text: string };
        if (current(session)) searchText?.prime(path, mtime, size, text);
        return null;
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
    overlay(value) {
        const { session, path, rev, text } = value as SessionArgs & { path: string; rev: number; text: string | null };
        if (!current(session)) return null;
        if ((overlayRevisions.get(path) ?? -1) > rev) return null;
        overlayRevisions.set(path, rev);
        if (text === null) overlays.delete(path); else overlays.set(path, { rev, text });
        return null;
    },
    async search(value, context) {
        const args = value as SessionArgs & { queryId: number; kind: 'sidebar' | 'agent'; query: string; regex?: boolean; caseSensitive?: boolean; scope?: string; maxResults?: number };
        const active = current(args.session), resident = searchText;
        if (!active || !resident) throw new DOMException('Index session changed', 'AbortError');
        const treeGen = active.store.treeGen;
        const files = [...active.store.files];
        const liveOverlays = new Map(overlays);
        if (args.kind === 'sidebar') {
            await searchSidebar(args.session, args.queryId, args.query, files, resident, liveOverlays, context,
                () => current(args.session) === active && active.store.treeGen === treeGen);
            return null;
        }
        const inScope = (path: string) => !args.scope || path === args.scope || path.startsWith(`${args.scope}/`);
        const scoped = files.filter(file => inScope(file.path));
        const eligible = scoped.filter(file => isTextFile(file.path) && !isCanvasFile(file.path));
        await resident.ensure(eligible.filter(file => !liveOverlays.has(file.path)).map(file => file.path), context);
        if (context.cancelled || current(args.session) !== active || active.store.treeGen !== treeGen) throw new DOMException('Index changed', 'AbortError');
        return matchAgentSearch({ query: args.query, regex: !!args.regex, caseSensitive: !!args.caseSensitive, maxResults: args.maxResults ?? 100 }, async () => scoped.map(file => ({
            path: file.path, name: file.path.slice(file.path.lastIndexOf('/') + 1),
            text: isTextFile(file.path) && !isCanvasFile(file.path) ? liveOverlays.get(file.path)?.text ?? resident.snapshot().get(file.path)?.text : undefined,
        })), { signal: context.signal, vaultToken: active, isCurrent: () => current(args.session) === active && active.store.treeGen === treeGen });
    },
    fgio(value) {
        const { session, active } = value as SessionArgs & { active: number };
        current(session)?.foregroundIO(active);
        return null;
    },
    async sweepBatch(value, context) {
        const { session, start, treeGen, reason } = value as SessionArgs & { start: number; treeGen: number; reason: string };
        if (current(session) && start === 0 && reason !== 'open') searchText?.revalidate();
        try { return await current(session)?.sweepBatch(start, treeGen, context) ?? null; }
        catch (error) { problem(context, session, error); return null; }
    },
    async invalidate(value, context) {
        const { session, paths } = value as SessionArgs & { paths: string[] };
        const active = current(session);
        if (active) searchText?.invalidate(paths);
        try { await active?.invalidate(paths, context); } catch (error) { problem(context, session, error); }
        if (active && current(session) === active) context.emit('searchChanged', { session });
        return null;
    },
} });
