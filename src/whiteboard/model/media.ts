import type { ExtBag } from './json';

// SEC-4 / R-W32 is the governing list; document-model §8 predates AVIF.
// Format schemas build on this model data, never the other way around.
export const MEDIA_MIMES = [
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml',
    'video/mp4', 'video/webm', 'video/quicktime',
] as const;
export type MediaMime = typeof MEDIA_MIMES[number];

// document-model.md §8, M-9: bytes and object URLs belong to the session, not nodes.
export type MediaId = `sha256:${string}`;
export interface MediaEntry {
    readonly id: MediaId;
    readonly mime: string;
    readonly bytes: number;
    readonly w: number;
    readonly h: number;
    readonly duration: number | null; // R-W14b: video seconds, finite >= 0; pictures use null.
    readonly animated: boolean;
    readonly name: string;
    readonly file: string | null;
    readonly ext: ExtBag | null;
}
export type MediaTable = ReadonlyMap<MediaId, MediaEntry>;
