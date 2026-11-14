import type { MediaMime } from '../model/media';

const matches = (bytes: Uint8Array, offset: number, text: string): boolean => {
    if (offset + text.length > bytes.length) return false;
    for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
    return true;
};

// Names and declared MIME are untrusted. A positive sniff is only a candidate;
// header admission and the browser's decoder still have to accept the bytes.
export function sniffMedia(bytes: Uint8Array): MediaMime | null {
    if (bytes.length >= 8 && bytes[0] === 0x89 && matches(bytes, 1, 'PNG\r\n\x1a\n')) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (matches(bytes, 0, 'GIF87a') || matches(bytes, 0, 'GIF89a')) return 'image/gif';
    if (matches(bytes, 0, 'RIFF') && matches(bytes, 8, 'WEBP')) return 'image/webp';
    if (bytes.length >= 12 && matches(bytes, 4, 'ftyp')) {
        const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
        const end = Math.min(bytes.length, length);
        let avif = false, quicktime = false, mp4 = false;
        for (let i = 8; i + 4 <= end; i += 4) {
            if (i === 12) continue;
            if (matches(bytes, i, 'avif') || matches(bytes, i, 'avis')) avif = true;
            else if (matches(bytes, i, 'qt  ')) quicktime = true;
            else if (matches(bytes, i, 'isom') || matches(bytes, i, 'iso2') || matches(bytes, i, 'mp41')
                || matches(bytes, i, 'mp42') || matches(bytes, i, 'avc1') || matches(bytes, i, 'M4V ')) mp4 = true;
        }
        if (avif) return 'image/avif';
        if (quicktime) return 'video/quicktime';
        if (mp4) return 'video/mp4';
    }
    if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
    // SVG classification is confirmed by the isolated XML profile, not DOMParser here.
    const prefix = new TextDecoder('utf-8').decode(bytes.subarray(0, 64)).replace(/^\uFEFF/, '').trimStart();
    if (/^(?:<\?xml\s|<svg(?:\s|>|\/))/.test(prefix)) return 'image/svg+xml';
    return null;
}
