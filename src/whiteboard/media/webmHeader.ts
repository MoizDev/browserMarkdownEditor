import type { RasterHeader } from './headers';

interface Element { readonly id: number; readonly start: number; readonly end: number }

export function webmHeader(bytes: Uint8Array): RasterHeader {
    let count = 0;
    const vint = (offset: number, id: boolean): { value: number; length: number; unknown: boolean } => {
        if (offset >= bytes.length || bytes[offset] === 0) throw new Error('Invalid EBML integer');
        let mask = 0x80, length = 1;
        while (!(bytes[offset] & mask)) { mask >>>= 1; length++; }
        if (length > (id ? 4 : 8) || offset + length > bytes.length) throw new Error('Invalid EBML integer');
        let value = id ? bytes[offset] : bytes[offset] & (mask - 1);
        let unknown = !id && value === mask - 1;
        for (let i = 1; i < length; i++) {
            value = value * 256 + bytes[offset + i];
            unknown &&= bytes[offset + i] === 255;
        }
        if (!Number.isSafeInteger(value) && !unknown) throw new Error('EBML integer too large');
        return { value, length, unknown };
    };
    const elements = (start: number, end: number): Element[] => {
        const result: Element[] = [];
        for (let pos = start; pos < end;) {
            if (++count > 100000) throw new Error('Too many EBML elements');
            const id = vint(pos, true); pos += id.length;
            const length = vint(pos, false); pos += length.length;
            const next = length.unknown ? end : pos + length.value;
            if (next > end || next < pos) throw new Error('Truncated EBML element');
            result.push({ id: id.value, start: pos, end: next });
            pos = next;
        }
        return result;
    };
    const integer = (e: Element): number => {
        if (e.end - e.start < 1 || e.end - e.start > 6) throw new Error('Invalid EBML field');
        let value = 0;
        for (let i = e.start; i < e.end; i++) value = value * 256 + bytes[i];
        return value;
    };
    const top = elements(0, bytes.length);
    const header = top.find(e => e.id === 0x1a45dfa3);
    const segment = top.find(e => e.id === 0x18538067);
    if (!header || !segment) throw new Error('Missing WebM header or segment');
    const docType = elements(header.start, header.end).find(e => e.id === 0x4282);
    if (!docType || new TextDecoder().decode(bytes.subarray(docType.start, docType.end)) !== 'webm') throw new Error('Not a WebM file');
    const tracks = elements(segment.start, segment.end).find(e => e.id === 0x1654ae6b);
    if (!tracks) throw new Error('Missing WebM tracks');
    let result: RasterHeader | undefined;
    for (const track of elements(tracks.start, tracks.end).filter(e => e.id === 0xae)) {
        const fields = elements(track.start, track.end);
        const type = fields.find(e => e.id === 0x83);
        if (!type || integer(type) !== 1) continue;
        const video = fields.find(e => e.id === 0xe0);
        if (!video) throw new Error('Missing WebM video dimensions');
        const settings = elements(video.start, video.end);
        const w = settings.find(e => e.id === 0xb0), h = settings.find(e => e.id === 0xba);
        if (!w || !h) throw new Error('Missing WebM video dimensions');
        const width = integer(w), height = integer(h);
        if (!width || !height || width > (2 ** 26) / height) throw new RangeError('Invalid or oversized media dimensions');
        if (!result) result = { width, height, animated: false };
    }
    if (!result) throw new Error('Missing WebM video track');
    return result;
}
