export type ClipboardRead = { ok: true; text: string } | { ok: false };

export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (error) {
        console.warn('Clipboard write refused', error);
        return false;
    }
}

export async function readClipboardText(): Promise<ClipboardRead> {
    try {
        const text = await navigator.clipboard.readText();
        return { ok: true, text };
    } catch (error) {
        console.warn('Clipboard read refused', error);
        return { ok: false };
    }
}

export const CLIPBOARD_READ_BLOCKED =
    'Your browser would not let the page read the clipboard. Press ⌘V (Ctrl+V) to paste instead.';
export const CLIPBOARD_WRITE_BLOCKED =
    'Your browser would not let the page write to the clipboard. Press ⌘C (Ctrl+C) to copy instead.';
