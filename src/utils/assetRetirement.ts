import { referencesAsset } from './assets';

export type MediaRefs = { ok: true; names: string[] } | { ok: false; reason: 'unreadable' | 'unknown-format' };
export type MediaSource = Uint8Array | ReadableStream<Uint8Array>;
export type MediaReader = (source: MediaSource, assetNames: ReadonlySet<string>) => Promise<MediaRefs>;

/** The board host can substitute its session's media names for serialized bytes. */
export type BoardMedia = { names: readonly string[] } | { source: MediaSource };

export async function resolveBoardMedia(media: BoardMedia, names: ReadonlySet<string>, read: MediaReader): Promise<MediaRefs> {
    if ('names' in media) return { ok: true, names: [...media.names] };
    try { return await read(media.source, names); }
    catch { return { ok: false, reason: 'unreadable' }; }
}

export async function boardMediaDiff(before: BoardMedia, after: BoardMedia, names: ReadonlySet<string>, read: MediaReader): Promise<
    { ok: true; before: Set<string>; after: Set<string> } | { ok: false }
> {
    const oldRefs = await resolveBoardMedia(before, names, read);
    const newRefs = await resolveBoardMedia(after, names, read);
    if (!oldRefs.ok || !newRefs.ok) return { ok: false };
    return { ok: true, before: new Set(oldRefs.names), after: new Set(newRefs.names) };
}

interface BoardBaseline { text: string }

/** Shared records survive a tab closing while its already-queued write finishes. */
export class BoardSaveBaselines {
    private readonly paths = new Map<string, BoardBaseline>();
    seed(path: string, text: string): void { this.paths.set(path, { text }); }
    capture(path: string): BoardBaseline | undefined { return this.paths.get(path); }
    committed(baseline: BoardBaseline, text: string): { before: string; after: string } {
        const before = baseline.text;
        baseline.text = text;
        return { before, after: text };
    }
    remove(path: string): void { this.paths.delete(path); }
    move(from: string, to: string): void {
        const baseline = this.paths.get(from);
        if (baseline) { this.paths.delete(from); this.paths.set(to, baseline); }
    }
    clear(): void { this.paths.clear(); }
}

/** One event-driven retry per folder, without discarding distinct blocked saves. */
export class RetirementBacklog<Job> {
    private readonly folders = new Map<string, Set<Job>>();
    private readonly scheduled = new Set<string>();
    block(folder: string, job: Job): void {
        let jobs = this.folders.get(folder);
        if (!jobs) { jobs = new Set(); this.folders.set(folder, jobs); }
        jobs.add(job);
    }
    schedule(folder: string): boolean {
        if (!this.folders.has(folder) || this.scheduled.has(folder)) return false;
        this.scheduled.add(folder);
        return true;
    }
    take(folder: string): Job[] {
        this.scheduled.delete(folder);
        const jobs = [...(this.folders.get(folder) ?? [])];
        this.folders.delete(folder);
        return jobs;
    }
    affected(path: string): string[] {
        return [...this.folders.keys()].filter(folder => !folder || !path || path === folder || path.startsWith(`${folder}/`) || folder.startsWith(`${path}/`));
    }
    all(): string[] { return [...this.folders.keys()]; }
    reset(): void { this.folders.clear(); this.scheduled.clear(); }
}

export function mediaChanges(before: ReadonlySet<string>, after: ReadonlySet<string>): {
    added: Set<string>; removed: Set<string>;
} {
    return {
        added: new Set([...after].filter(name => !before.has(name))),
        removed: new Set([...before].filter(name => !after.has(name))),
    };
}

export interface RetirementCandidates {
    /** A note dropped an embed. These retain the pre-existing note-side semantics. */
    note: ReadonlySet<string>;
    /** A board dropped a media reference. Hash names additionally require byte verification. */
    board: ReadonlySet<string>;
}

export interface RetirementProof {
    candidates: RetirementCandidates;
    notes: Iterable<() => Promise<string | ReadableStream<Uint8Array> | null>>;
    boards: Iterable<() => Promise<MediaRefs>>;
    current(): boolean;
    /** null means the candidate could not be read or hashed. */
    hash(name: string): Promise<string | null>;
}

export interface RetirementDecision {
    retire: Set<string>;
    /** Referenced or unknown candidates retry after a relevant change. */
    blocked: RetirementCandidates;
}

/** Board JSON can be enormous and is also subject to the legacy wiki-link keep rule. */
async function linkedNames(source: string | ReadableStream<Uint8Array>, candidates: ReadonlySet<string>): Promise<Set<string> | null> {
    const found = new Set<string>();
    if (typeof source === 'string') {
        for (const name of candidates) if (referencesAsset(source, name)) found.add(name);
        return found;
    }
    const reader = source.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '', complete = false;
    const consume = (text: string): boolean => {
        buffer += text;
        for (;;) {
            const start = buffer.indexOf('[[');
            if (start < 0) { buffer = buffer.endsWith('[') ? '[' : ''; return true; }
            const end = buffer.indexOf(']', start + 2), newline = buffer.indexOf('\n', start + 2);
            if (newline >= 0 && (end < 0 || newline < end)) { buffer = buffer.slice(newline + 1); continue; }
            if (end < 0 || end + 1 === buffer.length) {
                buffer = buffer.slice(start);
                return buffer.length <= 65536;
            }
            if (buffer[end + 1] === ']') {
                const token = buffer.slice(start, end + 2);
                for (const name of candidates) if (referencesAsset(token, name)) found.add(name);
                buffer = buffer.slice(end + 2);
            } else buffer = buffer.slice(end + 1);
        }
    };
    const feed = (text: string): boolean => {
        for (let at = 0; at < text.length; at += 8192) if (!consume(text.slice(at, at + 8192))) return false;
        return true;
    };
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) { complete = true; break; }
            if (!feed(decoder.decode(chunk.value, { stream: true }))) return null;
        }
        return feed(decoder.decode()) ? found : null;
    } catch { return null; }
    finally {
        if (!complete) { try { await reader.cancel(); } catch { /* The source already failed. */ } }
        reader.releaseLock();
    }
}

/** A failed or invalidated proof never guesses that an asset is unreferenced. */
export async function decideAssetRetirement(proof: RetirementProof): Promise<RetirementDecision> {
    const note = new Set(proof.candidates.note), board = new Set(proof.candidates.board);
    const candidates = new Set([...note, ...board]);
    const retainedNote = new Set<string>(), retainedBoard = new Set<string>();
    const blocked = (): RetirementDecision => ({ retire: new Set(), blocked: {
        note: new Set([...note, ...retainedNote]), board: new Set([...board, ...retainedBoard]),
    } });
    const keep = (name: string) => {
        candidates.delete(name);
        if (note.delete(name)) retainedNote.add(name);
        if (board.delete(name)) retainedBoard.add(name);
    };
    try {
        for (const read of proof.notes) {
            if (!proof.current()) return blocked();
            const text = await read();
            if (!proof.current() || text === null) return blocked();
            const linked = await linkedNames(text, candidates);
            if (!proof.current() || linked === null) return blocked();
            for (const name of linked) keep(name);
            if (!candidates.size) return { retire: candidates, blocked: { note: retainedNote, board: retainedBoard } };
        }
        for (const read of proof.boards) {
            if (!proof.current()) return blocked();
            const refs = await read();
            if (!proof.current() || !refs.ok) return blocked();
            for (const name of refs.names) keep(name);
            if (!candidates.size) return { retire: candidates, blocked: { note: retainedNote, board: retainedBoard } };
        }
        for (const name of [...board]) {
            if (note.has(name)) continue;
            const match = /^([0-9a-f]{64})\.[^/\\]+$/u.exec(name);
            if (!match) continue;
            if (!proof.current()) return blocked();
            const hash = await proof.hash(name);
            if (!proof.current() || hash === null) return blocked();
            if (hash !== match[1]) keep(name);
        }
        return { retire: candidates, blocked: { note: retainedNote, board: retainedBoard } };
    } catch { return blocked(); }
}
