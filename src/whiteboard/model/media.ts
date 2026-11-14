// document-model.md §8, M-9: bytes and object URLs belong to the session, not nodes.
export type MediaId = `sha256:${string}`;
export interface MediaEntry {
    readonly id: MediaId;
    readonly mime: string;
    readonly bytes: number;
    readonly w: number;
    readonly h: number;
    readonly animated: boolean;
    readonly name: string;
    readonly file: string | null;
}
export type MediaTable = ReadonlyMap<MediaId, MediaEntry>;
