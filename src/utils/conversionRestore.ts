import type { FileTreeNode } from '../types';
import { sniffCanvas } from './canvasFormat';

/** The menu stays independent of App's lifetime and memoized tree props. */
let restore: ((node: FileTreeNode) => void) | undefined;
export function registerConversionRestore(handler: (node: FileTreeNode) => void): () => void {
    restore = handler;
    return () => { if (restore === handler) restore = undefined; };
}
export function requestConversionRestore(node: FileTreeNode): void { restore?.(node); }

/** A marker is only a hint: the chosen Trash bytes must still hash to it. */
export function conversionDigestFromText(text: string, name: string): string | null {
    if (sniffCanvas(text, name).format !== 'native') return null;
    try {
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const digest = (value as Record<string, unknown>).legacyOriginalSha256;
        return typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest) ? digest : null;
    } catch { return null; }
}
