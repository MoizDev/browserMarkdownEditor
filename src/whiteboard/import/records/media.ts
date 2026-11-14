import { parseJson } from '../../format/jsonRead';
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

export interface DecodedLegacyAsset { readonly bytes: Uint8Array; readonly blob: Blob; readonly name: string; readonly mimeHint: string }
/** Pure extraction only: successful decoding does not authorize dimensions, type or identity. */
export function decodeInlineAsset(asset: LegacyObject): DecodedLegacyAsset {
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
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0)), mimeHint = match[1].toLowerCase();
    return { bytes, blob: new Blob([bytes], { type: mimeHint }), name: typeof props.name === 'string' ? props.name : '', mimeHint };
}

/** A source descriptor is not permission to fetch it; only App's scoped disk port resolves it. */
export function relativeLegacyAssetSource(asset: LegacyObject): string | null {
    const props = object(asset.props), src = props?.src;
    if (asset.typeName !== 'asset' || (asset.type !== 'image' && asset.type !== 'video') || typeof src !== 'string'
        || !src.length || src.length > 16_384 || src.includes('\u0000') || src.includes('\\') || src.startsWith('/')
        || /^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
    return src;
}

export async function readInlineAsset(asset: LegacyObject, admit: AdmitLegacyMedia, signal?: AbortSignal,
    resolved?: Blob): Promise<ImportedMedia> {
    const props = object(asset.props);
    if (!props) throw new Error('Invalid media asset properties');
    if (resolved && (!relativeLegacyAssetSource(asset) || !(resolved instanceof Blob) || resolved.size > MAX_MEDIA_BYTES))
        throw new Error('Invalid resolved legacy asset');
    signal?.throwIfAborted();
    const decoded = resolved ? { bytes: new Uint8Array(await resolved.arrayBuffer()), blob: resolved,
        name: typeof props.name === 'string' ? props.name : '', mimeHint: typeof props.mimeType === 'string' ? props.mimeType : '' } : decodeInlineAsset(asset);
    signal?.throwIfAborted();
    const { bytes, blob } = decoded;
    const result = await admit(blob, { signal });
    if (!/^sha256:[0-9a-f]{64}$/.test(result.id)) throw new Error('Media admission returned an invalid identity');
    const metadata = object(asset.meta) ? preserveMetadata(object(asset.meta)!) : null;
    const fields = new Map(metadata?.fields ?? []);
    if (resolved) fields.set('legacyAssetSource', parseJson(JSON.stringify(props.src)).raw());
    const extraProps: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(props)) if (key !== 'src') extraProps[key] = value;
    if (Object.keys(extraProps).length) fields.set('legacyAssetProps', parseJson(JSON.stringify(extraProps)).raw());
    const extraRecord: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(asset)) {
        if (!['id', 'typeName', 'type', 'props', 'meta'].includes(key)) extraRecord[key] = value;
    }
    if (Object.keys(extraRecord).length) fields.set('legacyAssetFields', parseJson(JSON.stringify(extraRecord)).raw());
    return { bytes, entry: { id: result.id, mime: result.mime, bytes: bytes.length, w: result.width, h: result.height,
        duration: result.duration, animated: result.animated, name: decoded.name,
        file: null, ext: fields.size ? { fields, raw: metadata?.raw ?? new Map() } : null } };
}
