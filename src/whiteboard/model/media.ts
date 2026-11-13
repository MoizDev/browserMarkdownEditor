import type { ExtBag } from './json';

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
