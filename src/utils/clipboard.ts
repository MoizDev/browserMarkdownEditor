// The system clipboard, as the two operations a menu item needs.
//
// A keystroke (⌘C / ⌘X / ⌘V) is handled by the browser itself and needs no
// permission — it IS the user gesture. A MENU ITEM is not: by the time the row
// is clicked the original gesture is spent, so Chromium permission-gates
// `readText()` and can refuse it outright. That refusal is the normal case, not
// an error case, which is why both functions here resolve rather than throw and
// why the caller is expected to SAY SO. A dead menu row is indistinguishable
// from a broken one — the rule VaultMenu.messageFor states.
//
// `document.execCommand('paste')` is not usable in Chromium web content and is
// deliberately not attempted as a fallback.

export type ClipboardRead = { ok: true; text: string } | { ok: false };

/** Put `text` on the system clipboard. Resolves `false` when the browser
 *  refused — never throws, so a caller can decide what to do next. */
export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (error) {
        // Degraded but fine: ⌘C still works. console.warn, not console.error.
        console.warn('Clipboard write refused', error);
        return false;
    }
}

/** Read the system clipboard. `{ ok: false }` when the browser refused, which
 *  Chromium does routinely for a read that is not driven by a live gesture. */
export async function readClipboardText(): Promise<ClipboardRead> {
    try {
        const text = await navigator.clipboard.readText();
        return { ok: true, text };
    } catch (error) {
        console.warn('Clipboard read refused', error);
        return { ok: false };
    }
}

/** Both messages name the keystroke that always works, because that is the
 *  thing the user can actually do about it. */
export const CLIPBOARD_READ_BLOCKED =
    'Your browser would not let the page read the clipboard. Press ⌘V (Ctrl+V) to paste instead.';
export const CLIPBOARD_WRITE_BLOCKED =
    'Your browser would not let the page write to the clipboard. Press ⌘C (Ctrl+C) to copy instead.';
