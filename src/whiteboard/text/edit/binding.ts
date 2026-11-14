import type { Op, Transaction } from '../../change/ops';
import type { Node } from '../../model/nodes';
import { EMPTY_RICH_TEXT, type RichText } from '../richText';
import { richTextOperations as rich } from '../richOperations';
import type { TextChange } from './host';
import { richEditAdapter } from './richAdapter';
import { TextEditSession, type EditLayout, type EditSessionServices } from './session';
import type { TextEditBinding, TextEditBindingOptions } from './bindingTypes';

/** Binds one pane's input endpoint to the session and its renderer's layout authority. */
export function bindTextEditor(options: TextEditBindingOptions): TextEditBinding {
    const { session, node: id, key, view, layoutEngine } = options;
    let closed = false, overlay: TextChange | null = null, overlayRevision = 0;
    let releaseComposition: (() => void) | undefined;
    let lastPaint = '', lastOwnRevision = session.doc.rev, prepared = '';
    const editorRef: { current?: TextEditSession } = {};
    function node(): Readonly<Node> {
        const current = session.doc.nodes.get(id);
        if (!current) throw new Error('Edited text no longer exists');
        return current;
    }
    function readText(): RichText {
        const current = node();
        if (key === 'name' && current.kind === 'frame') return rich.fromPlain(current.name);
        if (key === 'text' && (current.kind === 'text' || current.kind === 'sticky')) return current.text;
        if (key === 'label' && (current.kind === 'figure' || current.kind === 'connector')) return current.label ?? EMPTY_RICH_TEXT;
        throw new Error('Node does not own this text field');
    }
    const adapter = richEditAdapter(id, key === 'label' ? 'label' : 'text', readText, rich);
    function overlayText(): RichText {
        const source = readText();
        if (!overlay) return source;
        const insert = rich.insertionFragment(source, overlay.from, overlay.text, null);
        return rich.splice(source, overlay.from, overlay.to, insert).text;
    }
    function layout(): EditLayout {
        const text = overlayText(), request = options.request(node(), text, overlayRevision);
        const variants = new Set<string>();
        for (const block of text.blocks) {
            variants.add(`${block.kind[0] === 'h' ? 1 : 0}:0:0:0`);
            for (const run of block.runs) variants.add(`${block.kind[0] === 'h' ? 1 : 0}:${run.marks.b ? 1 : 0}:${run.marks.i ? 1 : 0}:${run.marks.code ? 1 : 0}`);
        }
        const signature = JSON.stringify([request.style.font, [...variants].sort()]);
        if (signature !== prepared) {
            prepared = signature;
            void layoutEngine.prepare(request).then(() => { if (!closed) view.requestChrome(); }, view.reportError);
        }
        const paint = layoutEngine.layout(request);
        if (paint.key !== lastPaint) { lastPaint = paint.key; options.paintChanged(paint, layoutEngine.faceTable); }
        return { paint, caret: layoutEngine.caretIndex(request, paint), ...options.transforms() };
    }
    function translateFrame(transaction: Transaction): Transaction {
        if (key !== 'name') return transaction;
        let text = readText();
        const ops: Op[] = [];
        for (const op of transaction.ops) {
            if (op.t === 'splice' && op.id === id && op.key === 'text') {
                text = rich.splice(text, op.from, op.to, op.insert, op.wholeBlocks === true || op.replaceBlocks === true).text;
                ops.push({ t: 'set', id, key: 'name', value: rich.plain(text) });
            } else if (op.t === 'set' && op.id === id && op.key === 'text') {
                text = op.value;
                ops.push({ t: 'set', id, key: 'name', value: rich.plain(text) });
            } else ops.push(op);
        }
        return { ...transaction, ops };
    }
    function apply(transaction: Transaction): void {
        const preparedTx = options.prepareTransaction(translateFrame(transaction));
        const applied = session.apply(preparedTx);
        lastOwnRevision = session.doc.rev;
        applied.release();
    }
    function inList(offset: number): boolean {
        const text = readText();
        let position = 0;
        for (const block of text.blocks) {
            const length = block.runs.reduce((sum, run) => sum + run.text.length, 0);
            if (offset <= position + length) return block.kind === 'ul' || block.kind === 'ol';
            position += length + 1;
        }
        return false;
    }
    const services: EditSessionServices = {
        ...view,
        history: session.history,
        ...adapter,
        apply,
        alive: () => !closed && session.doc.nodes.has(id),
        layout,
        inList,
        isStandaloneText: () => session.doc.nodes.get(id)?.kind === 'text',
        composition(change) {
            if (change && !releaseComposition) {
                releaseComposition = session.beginGesture();
                session.setComposition(true);
            }
            overlay = change;
            overlayRevision++;
            if (!change) {
                session.setComposition(false);
                releaseComposition?.();
                releaseComposition = undefined;
            }
            try { layout(); } catch (error) { view.reportError(error); }
            view.requestChrome();
        },
        command(command, selection) {
            if (command === 'undo' || command === 'redo') {
                if (command === 'undo') session.history.undo(); else session.history.redo();
                if (!closed) editorRef.current!.externalChange();
            } else if (command === 'finish') editorRef.current!.close();
            else view.command(command, selection);
        },
        finish() {
            closed = true;
            session.setComposition(false);
            releaseComposition?.(); releaseComposition = undefined;
            unsubscribe();
            options.clearPaint();
            view.finish();
        },
    };
    const editor = new TextEditSession(options.container, options.label, id, key === 'label' ? 'label' : 'text', options.initialSelection, services, options.mac);
    editorRef.current = editor;
    const unsubscribe = session.subscribe(notice => {
        if (closed || !notice.touched.nodes.has(id) || notice.rev <= lastOwnRevision) return;
        editor.externalChange();
    });
    return {
        editor,
        refresh() { if (!closed) editor.sync(); },
        close(commitComposition = true) { if (!closed) editor.close(commitComposition); },
    };
}
