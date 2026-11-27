import type { AgentHostDeps } from './agentHost';
import type { VaultToolHost } from '../types/vaultAgent';
import { readCanvasViewPos } from './canvasViewState';
import { createNativeAgentMutation } from '../whiteboard/host/nativeAgentMutation';

export async function applyNativeCanvasOperations(options: {
    readonly deps: AgentHostDeps;
    readonly path: string;
    readonly ops: Parameters<NonNullable<VaultToolHost['canvasApplyNative']>>[1];
    readonly guard: Parameters<NonNullable<VaultToolHost['canvasApplyNative']>>[2];
}): ReturnType<NonNullable<VaultToolHost['canvasApplyNative']>> {
    const { deps, path, guard } = options, ops = structuredClone(options.ops);
    const signal = guard.signal ?? new AbortController().signal;
    const check = () => {
        signal.throwIfAborted();
        if (!guard.isCurrent()) throw new DOMException('Canvas tool source changed', 'AbortError');
    };
    check();
    const tab = deps.tabs.find(tab => tab.file.path === path);
    const loaded = tab?.representation.loadedKind;
    if (!tab || (loaded !== 'drawing' && loaded !== 'notebook' && loaded !== 'pdf')) {
        throw new DOMException('Canvas representation changed', 'AbortError');
    }
    if (!deps.ensureNativeAgentRuntime) throw new Error('Native canvas source acquisition is unavailable');
    const source = await deps.ensureNativeAgentRuntime(path, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
    check();
    if (!source.isCurrent()) throw new DOMException('Canvas session changed', 'AbortError');
    const runtime = source.runtime, sheet = runtime.selection.getSnapshot().sheet;
    const position = readCanvasViewPos(path), host = runtime.session.doc.host;
    const page = host.kind === 'notebook' && position?.kind === 'notebook'
        ? Math.max(0, Math.min(host.paper.pageCount - 1, position.page)) : 0;
    const mutation = createNativeAgentMutation({ runtime, source: {
        isCurrent: () => guard.isCurrent() && !signal.aborted && source.isCurrent(),
        writeBlock: () => source.writeBlockReason() ?? (source.canWrite() ? null : 'The native canvas source is not currently writable.'),
        sheet: () => sheet, page: () => page,
    } });
    try {
        source.activateEditing();
        check();
        if (!source.isCurrent() || !source.canWrite()) throw new DOMException('Canvas edit authority changed', 'AbortError');
        return await mutation.apply(ops, { signal, deadlineMs: 30_000 });
    }
    finally {
        await mutation.retire();
    }
}
