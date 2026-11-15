import { isLocked } from '../../whiteboard/change/commands';
import type { BoardRuntime } from '../../whiteboard/host/runtime';
import { openMediaLink } from '../../whiteboard/media/openLink';
import { checkContentUrl } from '../../whiteboard/security/urlPolicy';
import type { NativeCommandOperation } from './nativeCommandSource';
import type { NativeViewLease } from './nativeViewLease';
import type { BoardTextQuestion } from './useNativeBoardDialogs';

/** The dialog captures a real node/text revision; its answer cannot edit a replacement selection. */
export function createNativeLinkOperations(options: {
    readonly runtime: BoardRuntime;
    readonly lease: NativeViewLease;
    readonly current: () => boolean;
    readonly canWrite: () => boolean;
    readonly requestText: (question: BoardTextQuestion) => Promise<string | null>;
    readonly notice: (message: string) => void;
}) {
    const { runtime, lease } = options, session = runtime.session, doc = session.doc;
    if (lease.runtime !== runtime) throw new Error('Link actions need the attached board session');
    const environment = { appOrigin: location.origin };
    const selected = () => {
        const selection = runtime.selection.getSnapshot();
        const node = selection.selected.length === 1 ? doc.nodes.get(selection.selected[0]) : undefined;
        return node && (node.kind === 'linkcard' || node.kind === 'embed') ? node : null;
    };
    const editor = () => lease.editing?.getTools()?.actualsubcontrollers.text;
    const state: NativeCommandOperation['state'] = () => {
        if (!options.current() || !options.canWrite() || session.isReadOnly || session.isGestureActive) return { enabled: false, reason: session.readOnlyReason ?? 'The board is unavailable' };
        const text = editor()?.linkContext(), node = selected();
        if (text && (text.href || text.selection.anchor !== text.selection.focus)) return { enabled: true };
        if (node && !isLocked(doc, node)) return { enabled: true };
        return { enabled: false, reason: 'Select text or an unlocked link card' };
    };
    const ask = (initial: string, allowEmpty: boolean) => options.requestText({ title: 'Edit link', body: allowEmpty
        ? 'Enter an absolute link address, or leave it empty to remove the link.' : 'Enter an absolute link address.',
        confirmLabel: 'Apply', input: { label: 'URL', initialValue: initial, placeholder: 'https://…', validate(value) {
            if (allowEmpty && !value.trim()) return null;
            const result = checkContentUrl(value.trim(), 'click', environment);
            return result.ok ? null : result.reason;
        } } });
    const editText = async () => {
        const text = editor(), context = text?.linkContext();
        if (!text || !context || (!context.href && context.selection.anchor === context.selection.focus)) return;
        const value = await ask(context.href ?? '', !!context.href);
        if (value === null || !options.current() || !options.canWrite() || session.isReadOnly) return;
        const trimmed = value.trim(), decision = trimmed ? checkContentUrl(trimmed, 'click', environment) : null;
        if (decision && !decision.ok) throw new Error(decision.reason);
        if (!text.applyTextLink(context, decision?.ok ? decision.url : null)) options.notice('The text selection changed; edit the link again.');
    };
    const editCard = async () => {
        const node = selected(), selection = runtime.selection.getSnapshot(), revision = doc.rev;
        if (!node || isLocked(doc, node)) return;
        const value = await ask(node.url, false);
        if (value === null) return;
        if (!options.current() || !options.canWrite() || session.isReadOnly || session.isGestureActive || doc.rev !== revision ||
            runtime.selection.getSnapshot() !== selection || doc.nodes.get(node.id) !== node || isLocked(doc, node)) {
            throw new DOMException('Link source changed', 'AbortError');
        }
        const result = checkContentUrl(value.trim(), 'click', environment);
        if (!result.ok) throw new Error(result.reason);
        session.history.open('Edit link');
        try { const applied = session.apply({ origin: 'host', label: 'Edit link', ops: [{ t: 'set', id: node.id, key: 'url', value: result.url }] }); applied.release(); }
        finally { session.history.close(); }
    };
    return {
        editLink: { state, run: () => editor()?.manager.current ? editText() : editCard() } satisfies NativeCommandOperation,
        editText,
        openLink(url: string) { if (!options.current()) throw new DOMException('Board view ended', 'AbortError'); openMediaLink(url, environment); },
    };
}
