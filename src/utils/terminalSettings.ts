// The two terminal settings, as an import-free external store: SettingsPanel
// (main chunk) writes them and the lazy terminal chunk reads them, so neither
// may import the other. localStorage only — nothing about a terminal belongs in
// the vault's `.appearance.json`.
//
// Both are clamped/cleaned on READ: localStorage is user-editable, and a NaN
// font size reaches xterm's cell measurement while a stray `;` or `{` in the
// family would end up inside a CSS font shorthand.

const FAMILY_KEY = 'terminalFontFamily';
const SIZE_KEY = 'terminalFontSize';

export const TERMINAL_FONT_SIZE_MIN = 10;
export const TERMINAL_FONT_SIZE_MAX = 24;

export interface TerminalSettings {
    /** A CSS family list; '' = automatic (detected from the user's terminal
     *  app, else the editor's monospace). */
    fontFamily: string;
    /** Pixels; null = automatic (the detected terminal app's size, else 13). */
    fontSize: number | null;
    /** What automatic resolved to, once a terminal has been opened and the font
     *  detection ran: shown by Settings as the field's placeholder and the
     *  slider's starting point. Not persisted — written by the terminal chunk. */
    detectedFamily: string | null;
    detectedSize: number | null;
}

function cleanFamily(raw: string | null): string {
    if (!raw) return '';
    return raw.replace(/[;{}<>\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function cleanSize(raw: string | null): number | null {
    if (raw === null || raw.trim() === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(n)));
}

let detectedFamily: string | null = null;
let detectedSize: number | null = null;

function read(): TerminalSettings {
    try {
        return {
            fontFamily: cleanFamily(localStorage.getItem(FAMILY_KEY)),
            fontSize: cleanSize(localStorage.getItem(SIZE_KEY)),
            detectedFamily,
            detectedSize,
        };
    } catch {
        return { fontFamily: '', fontSize: null, detectedFamily, detectedSize };
    }
}

// One object until something changes: useSyncExternalStore compares snapshots by
// identity, and a fresh object per call would re-render forever.
let snapshot: TerminalSettings | null = null;
const listeners = new Set<() => void>();

function emit(): void {
    snapshot = read();
    for (const listener of listeners) listener();
}

export function getTerminalSettings(): TerminalSettings {
    return (snapshot ??= read());
}

export function subscribeTerminalSettings(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function write(key: string, value: string | null): void {
    try {
        if (value === null || value === '') localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch { /* storage blocked — the setting simply does not persist */ }
    emit();
}

export function setTerminalFontFamily(family: string): void {
    write(FAMILY_KEY, cleanFamily(family));
}

export function setTerminalFontSize(size: number | null): void {
    write(SIZE_KEY, size === null ? null : String(cleanSize(String(size))));
}

/** Settings → Reset to Defaults. */
export function resetTerminalSettings(): void {
    try {
        localStorage.removeItem(FAMILY_KEY);
        localStorage.removeItem(SIZE_KEY);
    } catch { /* see write() */ }
    emit();
}

/** The terminal chunk reports what the font detection settled on. */
export function setDetectedTerminalFont(family: string | null, size: number | null): void {
    const clean = size === null ? null : cleanSize(String(size));
    if (family === detectedFamily && clean === detectedSize) return;
    detectedFamily = family;
    detectedSize = clean;
    emit();
}
