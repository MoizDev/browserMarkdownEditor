import type { NativeEditingCapabilityContext, NativeEditingCapabilities } from './nativeEditingCapabilities';
import type { NativeCommandOperation } from './nativeCommandSource';
import { isLocked } from '../../whiteboard/change/commands';
import { insertClipboardText } from '../../whiteboard/clipboard/insertText';
import { flattenNativeSelection } from '../../whiteboard/host/nativeFlatten';
import { convertMediaCard } from '../../whiteboard/media/cards';
import { resolveEmbedCandidate } from '../../whiteboard/media/embed';
import { isCancellation } from '../../platform/workers/envelope';

/** One view borrows the document's actual media pipeline; no new job queue or asset store. */
export function createNativeEditingCapabilities(context: NativeEditingCapabilityContext): NativeEditingCapabilities {
    const { runtime, host, identity, clipboard } = context;
    const lifetime = new AbortController(), signal = AbortSignal.any([context.signal, lifetime.signal]);
    const current = () => !signal.aborted && context.current() && host.isCurrent(identity);
    const writable = () => current() && context.canWrite() && host.canWrite(identity) && !runtime.session.isReadOnly;
    const environment = { appOrigin: location.origin };
    const manifest = host.embeds.manifest;
    const fail = (error: unknown) => {
        if (!isCancellation(error)) context.notice(error instanceof Error ? error.message : String(error));
    };
    const operation = (eligible: () => boolean, run: () => void | Promise<void>): NativeCommandOperation => ({
        state: () => writable() && eligible() ? { enabled: true } : { enabled: false, reason: 'This action is unavailable for the current selection or source.' },
        async run() {
            if (!writable() || !eligible()) throw new Error('The canvas source or selection is no longer editable');
            await run();
        },
    });
    const card = (kind: 'linkcard' | 'embed') => {
        const selected = runtime.selection.getSnapshot().selected;
        const node = selected.length === 1 ? runtime.session.doc.nodes.get(selected[0]) : undefined;
        return node?.kind === kind && !isLocked(runtime.session.doc, node) ? node : undefined;
    };
    return {
        flatten: operation(() => runtime.selection.getSnapshot().selected.some(id => {
            const node = runtime.session.doc.nodes.get(id);
            return !!node && !isLocked(runtime.session.doc, node);
        }), async () => {
            await flattenNativeSelection({ runtime, memory: clipboard.memory, signal, current: writable,
                boardName: host.identity(identity.documentId)?.name ?? identity.name, theme: clipboard.theme(),
                readMedia: clipboard.readMedia, storeMedia: clipboard.storeMedia,
                notice: context.notice, onError: fail });
        }),
        insertEmbed: operation(() => !!context.lease.editing?.getBinding(), async () => {
            const binding = context.lease.editing?.getBinding();
            if (!binding) throw new Error('Canvas input is not attached');
            const captured = binding.controller.captureInsertionTarget();
            const value = await context.requestText({ title: 'Insert embed',
                body: 'Enter a link from a supported embed provider. The embed stays unloaded until you choose Load.', confirmLabel: 'Insert',
                input: { label: 'URL', initialValue: '', placeholder: 'https://…',
                    validate: input => resolveEmbedCandidate(input, environment, manifest) ? null : 'Enter a link from a supported embed provider.' } });
            if (value === null) return;
            if (!writable() || !captured.current()) throw new DOMException('Embed insertion target changed', 'AbortError');
            await runtime.jobs.run(async job => {
                job.assertCurrent();
                if (!writable() || !captured.current()) throw new DOMException('Embed insertion target changed', 'AbortError');
                await insertClipboardText({ runtime, target: captured.target, current: () => writable() && captured.current(),
                    receivingBoardId: identity.documentId, cameraZoom: captured.zoom, intent: 'paste',
                    content: { kind: 'url', url: value }, embedEnvironment: environment, embedManifest: manifest,
                    signal: job.signal });
            }, { signal, deadlineMs: 30_000 });
        }),
        convertToBookmark: operation(() => !!card('embed'), () => {
            const node = card('embed');
            if (!node) throw new Error('Select one unlocked embed');
            convertMediaCard({ runtime, id: node.id, current: writable, environment, manifest });
        }),
        convertToEmbed: operation(() => {
            const node = card('linkcard');
            return !!node && !!resolveEmbedCandidate(node.url, environment, manifest);
        }, () => {
            const node = card('linkcard');
            if (!node) throw new Error('Select one unlocked link card');
            convertMediaCard({ runtime, id: node.id, current: writable, environment, manifest });
        }),
        dispose() { lifetime.abort(); },
    };
}
