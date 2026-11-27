import { classifyClipboard, type ClipboardClassifierHost } from '../clipboard/classify';
import type { ClipboardHtmlFrameHost } from '../clipboard/htmlFrameHost';
import type { ClipboardInput } from '../clipboard/types';
import { fromPlainCooperative } from './richOperations';
import type { RichFragment } from './richText';
import { yieldToHost } from './cooperative';
import type { PlainTextOptions } from './plainText';

export type TextPasteContent =
    | { readonly kind: 'text'; readonly fragment: RichFragment }
    | { readonly kind: 'board' }
    | { readonly kind: 'empty' };

export interface TextPasteReader {
    readonly classifier: ClipboardClassifierHost;
    readonly html: ClipboardHtmlFrameHost;
    readonly cooperate?: () => Promise<void>;
    privateText(encoded: string, plain: string | null, signal: AbortSignal): Promise<RichFragment | null>;
}

export async function classifyTextPaste(input: ClipboardInput, plain: boolean, reader: TextPasteReader,
    signal: AbortSignal): Promise<TextPasteContent> {
    const result = await classifyClipboard(input, plain ? 'paste-plain' : 'paste', reader.classifier, signal);
    signal.throwIfAborted();
    const ingress: PlainTextOptions = { signal, cooperate: reader.cooperate ?? yieldToHost };
    switch (result.kind) {
        case 'empty': return { kind: 'empty' };
        case 'text': return { kind: 'text', fragment: await fromPlainCooperative(result.text, ingress) };
        case 'url': return { kind: 'text', fragment: await fromPlainCooperative(input.text ?? result.url, ingress) };
        case 'private': {
            const fragment = await reader.privateText(result.encoded, input.text, signal);
            signal.throwIfAborted();
            return fragment ? { kind: 'text', fragment } : { kind: 'board' };
        }
        case 'html': {
            const projection = await reader.html.projectHTML(result.html, signal);
            try {
                signal.throwIfAborted();
                return projection.dataImages.length ? { kind: 'board' } : { kind: 'text', fragment: projection.rich };
            } finally { projection.release(); }
        }
        default: return { kind: 'board' };
    }
}
