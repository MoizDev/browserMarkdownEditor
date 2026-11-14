import type { ClipboardInput } from '../clipboard/types';
import type { RichFragment, RichText } from './richText';
import { textClipboardRendition } from './clipboard';
import type { EditSelection } from './edit/host';

export type TextPasteContent =
    | { readonly kind: 'text'; readonly fragment: RichFragment }
    | { readonly kind: 'board' }
    | { readonly kind: 'empty' };
export interface TextClipboardPorts {
    text(): RichText;
    selection(): EditSelection;
    revision(): number;
    /** Core/h2 classify private and isolated HTML without exposing markup to the live DOM. */
    classify(input: ClipboardInput, plain: boolean, signal: AbortSignal): Promise<TextPasteContent>;
    /** Core/h2 adds its validated single-text-node envelope to the rendition. */
    envelope(fragment: RichFragment, html: string): string;
    replace(fragment: RichFragment): void;
    delete(): void;
    /** Ends this editor and forwards the original sampled transfer to the board controller. */
    pasteBoard(input: ClipboardInput, plain: boolean): void;
}
export interface TextClipboardCopy { readonly plain: string; readonly html: string }

/** Owns text-range decisions; platform clipboard permissions remain in the app controller. */
export class TextClipboardSession {
    private generation = 0;
    private disposed = false;
    private active: AbortController | null = null;
    constructor(private readonly ports: TextClipboardPorts) {}

    copy(): TextClipboardCopy | null {
        if (this.disposed) return null;
        const selection = this.ports.selection();
        const from = Math.min(selection.anchor, selection.focus), to = Math.max(selection.anchor, selection.focus);
        if (from === to) return null;
        const rendition = textClipboardRendition(this.ports.text(), from, to);
        return { plain: rendition.plain, html: this.ports.envelope(rendition.fragment, rendition.html) };
    }

    /** Call only after the synchronous copy event or async clipboard write succeeds. */
    cut(copyRevision: number, selection: EditSelection): boolean {
        if (this.disposed || this.ports.revision() !== copyRevision) return false;
        const now = this.ports.selection();
        if (selection.anchor !== now.anchor || selection.focus !== now.focus || now.anchor === now.focus) return false;
        this.cancel();
        this.ports.delete();
        return true;
    }

    async paste(input: ClipboardInput, plain: boolean, signal: AbortSignal): Promise<boolean> {
        if (this.disposed) return false;
        signal.throwIfAborted();
        this.cancel();
        const generation = this.generation, revision = this.ports.revision(), selection = this.ports.selection();
        const controller = new AbortController(); this.active = controller;
        const combined = AbortSignal.any([signal, controller.signal]);
        try {
            const content = await this.ports.classify(input, plain, combined);
            combined.throwIfAborted();
            const now = this.ports.selection();
            if (this.disposed || generation !== this.generation || revision !== this.ports.revision()
                || selection.anchor !== now.anchor || selection.focus !== now.focus) return false;
            if (content.kind === 'empty') return false;
            if (content.kind === 'board') this.ports.pasteBoard(input, plain);
            else this.ports.replace(content.fragment);
            return true;
        } finally { if (this.active === controller) this.active = null; }
    }

    cancel(): void { this.generation++; this.active?.abort(); this.active = null; }
    dispose(): void { this.disposed = true; this.cancel(); }
}
