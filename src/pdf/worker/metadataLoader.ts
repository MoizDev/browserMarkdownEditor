import { Sha256 } from '../../utils/sha256';
import type { WorkerContext } from '../../platform/workers/serve';
import type { createPdfWriterRuntime } from '../writing/nativeHandlers';
import type { PdfInkInspector } from '../writing/inkInspection';
import type { inspectPdfNotebook } from '../writing/notebookInspection';
import type { inspectLegacyPdfInk } from '../writing/legacyInkInspection';

interface MetadataModule {
    createPdfWriterRuntime: typeof createPdfWriterRuntime;
    PdfInkInspector: typeof PdfInkInspector;
    inspectPdfNotebook: typeof inspectPdfNotebook;
    inspectLegacyPdfInk: typeof inspectLegacyPdfInk;
}
const unavailable = () => new DOMException('PDF metadata module is unavailable', 'AbortError');

export function createPdfMetadataLoader() {
    let closed = false, requested = false, supplying = false, ready: MetadataModule | undefined;
    let resolve!: (value: MetadataModule) => void, reject!: (error: unknown) => void;
    const pending = new Promise<MetadataModule>((yes, no) => { resolve = yes; reject = no; });
    void pending.catch(() => {});
    return {
        async get(context: WorkerContext): Promise<MetadataModule> {
            if (closed || context.cancelled) throw unavailable();
            if (ready) return ready;
            if (!requested) { requested = true; context.emit('code.needed', { id: 'metadata' }); }
            return new Promise<MetadataModule>((yes, no) => {
                const abort = () => { context.signal.removeEventListener('abort', abort); no(context.signal.reason ?? unavailable()); };
                context.signal.addEventListener('abort', abort, { once: true });
                if (context.signal.aborted) { abort(); return; }
                void pending.then(value => { context.signal.removeEventListener('abort', abort); if (!context.signal.aborted) yes(value); },
                    error => { context.signal.removeEventListener('abort', abort); if (!context.signal.aborted) no(error); });
            });
        },
        async provide(value: unknown): Promise<Record<string, never>> {
            try {
                if (closed || !requested || supplying || ready || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid PDF metadata delivery');
                const data = value as Record<string, unknown>;
                if (Object.keys(data).some(key => !['id', 'source', 'sha256'].includes(key)) || data.id !== 'metadata' ||
                    typeof data.source !== 'string' || !data.source.length || data.source.length > 8 * 1024 * 1024 ||
                    typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new Error('Invalid PDF metadata delivery');
                supplying = true;
                const bytes = new TextEncoder().encode(data.source);
                if (new Sha256().update(bytes).digest() !== data.sha256) throw new Error('PDF metadata integrity failed');
                const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
                try {
                    const module: unknown = await import(/* @vite-ignore */ url);
                    if (closed || !module || typeof module !== 'object' ||
                        typeof (module as MetadataModule).createPdfWriterRuntime !== 'function' ||
                        typeof (module as MetadataModule).PdfInkInspector !== 'function' ||
                        typeof (module as MetadataModule).inspectPdfNotebook !== 'function' ||
                        typeof (module as MetadataModule).inspectLegacyPdfInk !== 'function') throw new Error('Invalid PDF metadata module');
                    ready = module as MetadataModule; resolve(ready);
                } finally { URL.revokeObjectURL(url); }
                return {};
            } catch (error) { reject(error); throw error; }
        },
        dispose() { if (!closed) { closed = true; reject(unavailable()); ready = undefined; } },
    };
}
