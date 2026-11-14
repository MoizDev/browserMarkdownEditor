import type { AgentHostDeps } from './agentHost';
import type { VaultToolHost } from '../types/vaultAgent';
import { isNativeDrawingFile, isNotebookFile } from './fileTypes';
import { createNativeAgentReader } from '../whiteboard/host/nativeAgentRead';
import { readClosedAgentProjection } from '../whiteboard/host/agentProjection';
import { getPdfInkSourceState } from '../whiteboard/host/preparePdfInkSession';

/** Loaded only by an actual canvas tool request; source ownership stays in App. */
export async function readNativeCanvasShapePage(options: {
    readonly deps: AgentHostDeps;
    readonly path: string;
    readonly handle?: FileSystemFileHandle;
    readonly query: Parameters<NonNullable<VaultToolHost['canvasShapePage']>>[1];
    readonly guard: Parameters<NonNullable<VaultToolHost['canvasShapePage']>>[2];
}): ReturnType<NonNullable<VaultToolHost['canvasShapePage']>> {
    const { deps, path, guard } = options;
    const signal = guard.signal ?? new AbortController().signal;
    const check = () => {
        signal.throwIfAborted();
        if (!guard.isCurrent()) throw new DOMException('Canvas tool source changed', 'AbortError');
    };
    check();
    const tab = deps.tabs.find(tab => tab.file.path === path);
    const job = { signal, deadlineMs: 30_000 };
    if (tab) {
        const kind = tab.representation.loadedKind;
        if (kind !== 'drawing' && kind !== 'notebook') return null;
        // Classic is a separate representation, not a recovery path for failed native reads.
        if (!tab.representation.nativeCanvasKind && !isNativeDrawingFile(path)) return null;
        if (!deps.ensureNativeAgentRuntime) throw new Error('Native canvas source acquisition is unavailable');
        const source = await deps.ensureNativeAgentRuntime(path, signal);
        check();
        if (!source.isCurrent()) throw new DOMException('Canvas session changed', 'AbortError');
        // A PDF page capture pins the App-owned PDF source of this exact document, the same
        // source the clipboard uses; a refusal here is explicit, never a blank backdrop.
        const pdfInk = source.identity.kind === 'pdfInk', documentId = source.identity.documentId;
        return createNativeAgentReader({ runtime: source.runtime,
            ...(pdfInk ? { retainPdfSource: () => {
                const pdf = getPdfInkSourceState(documentId);
                if (!pdf || !source.isCurrent()) throw new Error('The PDF ink source is unavailable');
                if (pdf.getSnapshot().status !== 'ready') throw new Error('The PDF source is updating');
                return pdf.retainSource();
            } } : {}),
            isCurrent: () => guard.isCurrent() && source.isCurrent(), notice: deps.notify,
            onError: error => console.error('Native canvas tool capture failed:', error),
        }).shapes({ ...options.query }, job);
    }
    if (!options.handle || !deps.acquireClosedCanvasSource) return null;
    const lease = await deps.acquireClosedCanvasSource(path, options.handle,
        isNotebookFile(path) ? 'notebook' : 'drawing', { signal, isCurrent: guard.isCurrent });
    try {
        check();
        const result = await readClosedAgentProjection({ bytes: lease.bytes,
            kind: isNotebookFile(path) ? 'notebook' : 'whiteboard', token: lease.token,
            diskRevision: lease.diskRevision, authority: lease.authority, query: { ...options.query },
            job: { ...job, signal: lease.signal },
            isCurrent: () => guard.isCurrent() && lease.isCurrent(),
            assertBaseline: lease.assertBaseline,
        });
        check();
        // Only the producer's complete OTHER result authorizes the existing Classic reader.
        // Native refusals throw without reparsing, changing kind or constructing blank content.
        return result.kind === 'other' ? null : result.page;
    } finally { await lease.release(); }
}
