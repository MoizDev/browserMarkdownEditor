import type { MediaEntry, MediaId, MediaMime } from '../../model/media';
import type { LegacyObject } from './envelope';
import { object } from './envelope';
import { preserveMetadata } from './sheets';

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export interface ImportedMedia { readonly entry: MediaEntry; readonly bytes: Uint8Array }
// SEC-W4 owns sniffing, bounded headers, isolated decode and streamed hashing.
export type AdmitLegacyMedia = (blob: Blob, options: { readonly signal?: AbortSignal }) => Promise<{
    readonly id: MediaId; readonly mime: MediaMime; readonly width: number; readonly height: number;
    readonly duration: number | null; readonly animated: boolean;
}>;

export async function readInlineAsset(asset: LegacyObject, admit: AdmitLegacyMedia, signal?: AbortSignal): Promise<ImportedMedia> {
    const props = object(asset.props);
    if (asset.typeName !== 'asset' || !props || (asset.type !== 'image' && asset.type !== 'video')) {
        throw new Error('Unsupported media asset');
    }
    const src = props.src;
    if (typeof src !== 'string') throw new Error('Media has no inline data');
    const match = /^data:([^;,]+);base64,/i.exec(src);
    if (!match) throw new Error('Media is not an inline base64 asset');
    const encoded = src.slice(match[0].length);
    if (encoded.length > 4 * Math.ceil(MAX_MEDIA_BYTES / 3)) throw new Error('Media exceeds the size limit');
    let binary: string;
    try { binary = atob(encoded); } catch { throw new Error('Invalid inline media encoding'); }
    if (binary.length > MAX_MEDIA_BYTES) throw new Error('Media exceeds the size limit');
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const result = await admit(new Blob([bytes], { type: match[1].toLowerCase() }), { signal });
    if (!/^sha256:[0-9a-f]{64}$/.test(result.id)) throw new Error('Media admission returned an invalid identity');
    return { bytes, entry: { id: result.id, mime: result.mime, bytes: bytes.length, w: result.width, h: result.height,
        duration: result.duration, animated: result.animated, name: typeof props.name === 'string' ? props.name : '',
        file: null, ext: object(asset.meta) ? preserveMetadata(object(asset.meta)!) : null } };
}
