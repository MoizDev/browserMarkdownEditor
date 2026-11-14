import type { BoardRuntime } from './runtime';
import type { Op } from '../change/ops';
import { isSafeMediaFile, type MediaEntry, type MediaId } from '../model/media';
import { nodeRawValues } from '../model/rawMedia';
import type { JobContext } from '../security/admission';

// Provenance: media §4, MD-1 referenced-asset restoration and checkpoint
// ordering; independent session-job staging, no upstream engine source.
export interface RestoreReferencedMediaOptions {
    readonly runtime: BoardRuntime;
    current(): boolean;
    /** Ensures verified bytes exist at a safe location without overwriting another asset. */
    storeMedia(entry: MediaEntry, blob: Blob, signal: AbortSignal): Promise<string | null>;
    cooperate?(): Promise<void>;
}
/** Await this inside the checkpoint's owning job, before pinning its save revision. */
export async function restoreReferencedMediaInJob(options: RestoreReferencedMediaOptions, context: JobContext): Promise<void> {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const check = () => {
        runtime.jobs.assertContext(context); context.assertCurrent();
        if (!options.current() || runtime.session !== session || session.owner !== owner || session.doc !== doc || doc.rev !== revision || session.isReadOnly) {
            throw new DOMException('Media restoration became stale', 'AbortError');
        }
    };
    const cooperate = async () => { check(); await (options.cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0))); check(); };
    const ids = new Set<MediaId>(), files = new Map<MediaId, string | null>(), ops: Op[] = [], leases: { release(): void }[] = [];
    try {
        check(); let visits = 0;
        for (const [id, refs] of doc.mediaRefs) { if (refs.size) ids.add(id); if ((++visits & 255) === 0) await cooperate(); }
        for (const [id, count] of doc.preservedMediaRefs) { if (count > 0) ids.add(id); if ((++visits & 255) === 0) await cooperate(); }
        let unknownRaw: boolean | undefined;
        const hasUnknownRaw = async () => {
            if (unknownRaw !== undefined) return unknownRaw;
            unknownRaw = doc.preserved.fields.size > 0 || doc.preserved.records.length > 0 || doc.preserved.end !== null;
            if (!unknownRaw) for (const node of doc.nodes.values()) {
                for (const raw of nodeRawValues(node)) if (raw !== null) { unknownRaw = true; break; }
                if (unknownRaw) break;
                if ((++visits & 255) === 0) await cooperate();
            }
            return unknownRaw;
        };
        for (const id of ids) {
            check();
            const entry = doc.media.get(id), blob = runtime.media.get(id);
            if (!entry || !blob) continue;
            leases.push(runtime.media.retain(id, 'snapshot'));
            const location = runtime.media.currentFile(id), proposed = { ...entry, file: location === undefined ? entry.file : location };
            const file = await options.storeMedia(proposed, blob, context.signal); check();
            if (!isSafeMediaFile(file)) throw new Error(`Invalid restored media location: ${id}`);
            if (entry.file !== file && (entry.ext?.raw.size || entry.ext?.fields.size || (doc.preservedMediaRefs.get(id) ?? 0) > 0
                || entry.file !== null && await hasUnknownRaw())) {
                throw new Error(`Cannot remap preserved media metadata: ${id}`);
            }
            files.set(id, file);
            if (entry.file !== file) ops.push({ t: 'media', op: 'set-file', id, file });
            await cooperate();
        }
        check();
        await session.enqueueAfterGesture(context.signal, () => {
            check();
            if (ops.length) {
                const applied = session.apply({ origin: 'host', label: 'Restore referenced media', ops });
                try { for (const [id, file] of files) runtime.media.setFile(id, file); }
                finally { applied.release(); }
            } else for (const [id, file] of files) runtime.media.setFile(id, file);
        });
    } finally { for (const lease of leases) lease.release(); }
}
export function restoreReferencedMedia(options: RestoreReferencedMediaOptions, signal?: AbortSignal): Promise<void> {
    return options.runtime.jobs.run(context => restoreReferencedMediaInJob(options, context), { signal, deadlineMs: 180_000 });
}
