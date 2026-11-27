import type { ExtBag } from './json';

export const MEDIA_MIMES = [
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml',
    'video/mp4', 'video/webm', 'video/quicktime',
] as const;
export type MediaMime = typeof MEDIA_MIMES[number];

export type MediaId = `sha256:${string}`;
export interface MediaEntry {
    readonly id: MediaId;
    readonly mime: string;
    readonly bytes: number;
    readonly w: number;
    readonly h: number;
    readonly duration: number | null;
    readonly animated: boolean;
    readonly name: string;
    readonly file: string | null;
    readonly ext: ExtBag | null;
}
export type MediaTable = ReadonlyMap<MediaId, MediaEntry>;

export interface MediaLocations {
    currentFile(id: MediaId): string | null | undefined;
}
export function isSafeMediaFile(file: unknown): file is string | null {
    if (file === null) return true;
    if (typeof file !== 'string' || !file.length || file.length > 255 || file === '.' || file === '..') return false;
    for (let i = 0; i < file.length; i++) {
        const code = file.charCodeAt(i);
        if (code < 32 || (code >= 127 && code <= 159) || code === 47 || code === 92) return false;
        if (code >= 0xd800 && code <= 0xdbff) {
            const low = file.charCodeAt(++i);
            if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
        } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
}
