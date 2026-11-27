import { removeStoredValue, writeStoredValue } from './storage';

const FAMILY_KEY = 'terminalFontFamily';
const SIZE_KEY = 'terminalFontSize';

export const TERMINAL_FONT_SIZE_MIN = 10;
export const TERMINAL_FONT_SIZE_MAX = 24;

export interface TerminalSettings {
    fontFamily: string;
    fontSize: number | null;
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
    if (value === null || value === '') removeStoredValue(key);
    else writeStoredValue(key, value);
    emit();
}

export function setTerminalFontFamily(family: string): void {
    write(FAMILY_KEY, cleanFamily(family));
}

export function setTerminalFontSize(size: number | null): void {
    write(SIZE_KEY, size === null ? null : String(cleanSize(String(size))));
}

export function resetTerminalSettings(): void {
    removeStoredValue(FAMILY_KEY);
    removeStoredValue(SIZE_KEY);
    emit();
}

export function setDetectedTerminalFont(family: string | null, size: number | null): void {
    const clean = size === null ? null : cleanSize(String(size));
    if (family === detectedFamily && clean === detectedSize) return;
    detectedFamily = family;
    detectedSize = clean;
    emit();
}
