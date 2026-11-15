import { isLocked } from '../../whiteboard/change/commands';
import type { Op } from '../../whiteboard/change/ops';
import type { Node } from '../../whiteboard/model/nodes';
import type { BoardRuntime } from '../../whiteboard/host/runtime';
import { openMediaLink } from '../../whiteboard/media/openLink';
import { checkContentUrl } from '../../whiteboard/security/urlPolicy';
import type { NativeCommandOperation } from './nativeCommandSource';
import type { NativeViewLease } from './nativeViewLease';
import type { BoardTextQuestion } from './useNativeBoardDialogs';

type LinkableNode = Extract<Node, { readonly kind: 'figure' | 'sticky' | 'picture' | 'linkcard' | 'embed' }>;
const LINKABLE: ReadonlySet<string> = new Set(['figure', 'sticky', 'picture', 'linkcard', 'embed']);

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
    // Every kind the model gives a URL can carry a link; a link card and an embed are the two that must keep one.
    const selected = () => {
        const selection = runtime.selection.getSnapshot();
        const node = selection.selected.length === 1 ? doc.nodes.get(selection.selected[0]) : undefined;
        return node && LINKABLE.has(node.kind) ? node as LinkableNode : null;
    };
    const editor = () => lease.editing?.getTools()?.actualsubcontrollers.text;
    const state: NativeCommandOperation['state'] = () => {
        if (!options.current() || !options.canWrite() || session.isReadOnly || session.isGestureActive) return { enabled: false, reason: session.readOnlyReason ?? 'The board is unavailable' };
        const text = editor()?.linkContext(), node = selected();
        if (text && (text.href || text.selection.anchor !== text.selection.focus)) return { enabled: true };
        if (node && !isLocked(doc, node)) return { enabled: true };
        return { enabled: false, reason: 'Select text or one unlocked picture, figure, note or card' };
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
        // A card needs its address; any other item loses its link when the field is left empty.
        const card = node.kind === 'linkcard' || node.kind === 'embed';
        const value = await ask(node.url ?? '', !card);
        if (value === null) return;
        if (!options.current() || !options.canWrite() || session.isReadOnly || session.isGestureActive || doc.rev !== revision ||
            runtime.selection.getSnapshot() !== selection || doc.nodes.get(node.id) !== node || isLocked(doc, node)) {
            throw new DOMException('Link source changed', 'AbortError');
        }
        const trimmed = value.trim(), result = trimmed ? checkContentUrl(trimmed, 'click', environment) : null;
        if (result && !result.ok) throw new Error(result.reason);
        const url = result && result.ok ? result.url : null;
        if (card && url === null) return;
        session.history.open('Edit link');
        try { const applied = session.apply({ origin: 'host', label: 'Edit link', ops: [{ t: 'set', id: node.id, key: 'url', value: url } as Op] }); applied.release(); }
        finally { session.history.close(); }
    };
    return {
        editLink: { state, run: () => editor()?.manager.current ? editText() : editCard() } satisfies NativeCommandOperation,
        editText,
        openLink(url: string) { if (!options.current()) throw new DOMException('Board view ended', 'AbortError'); openMediaLink(url, environment); },
    };
}
