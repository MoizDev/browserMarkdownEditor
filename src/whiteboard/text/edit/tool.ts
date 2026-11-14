import type { GestureOwner, Modifiers, RealSample, Tool } from '../../input/tool';

export interface TextToolContext {
    // The tool supplies geometry; the view creates through the shared apply path
    // and then enters editing on the created node.
    createText(x: number, y: number, width: number | null): void;
    worldToScreen(x: number, y: number): { readonly x: number; readonly y: number };
    previewTextColumn(x: number, y: number, width: number | null): void;
    clearTextColumnPreview(): void;
}

export const textTool: Tool<TextToolContext> = {
    id: 'text',
    begin(first: RealSample, _modifiers: Modifiers, context: TextToolContext): GestureOwner | null {
        if (first.source === 'keyboard') return null;
        const origin = context.worldToScreen(first.x, first.y);
        let last = first;
        let width: number | null = null;
        const update = (sample: RealSample) => {
            last = sample;
            const screen = context.worldToScreen(sample.x, sample.y);
            const threshold = first.source === 'touch' ? 36 : 24;
            width = sample.time - first.time >= 150 && Math.abs(screen.x - origin.x) > threshold
                ? Math.max(16, Math.abs(sample.x - first.x)) : null;
            context.previewTextColumn(Math.min(first.x, sample.x), first.y, width);
        };
        const hold = setTimeout(() => update({ ...last, time: Math.max(last.time, first.time + 150) }), 150);
        return {
            kind: 'node-edit', pointerIds: new Set([first.pointerId]),
            update(samples) { for (const sample of samples) if (sample.pointerId === first.pointerId) update(sample); },
            finish(reason) {
                clearTimeout(hold);
                context.clearTextColumnPreview();
                if (reason === 'escape' || reason === 'undo') return;
                context.createText(width === null ? first.x : Math.min(first.x, last.x), first.y, width);
            },
            cancel() { clearTimeout(hold); context.clearTextColumnPreview(); },
        };
    },
};
