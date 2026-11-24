import type { RasterHeader } from './headers';

interface Box { readonly type: string; readonly start: number; readonly data: number; readonly end: number }
const PIXELS = 2 ** 26;

function checkedSize(width: number, height: number): RasterHeader {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > PIXELS / height) {
        throw new RangeError('Invalid or oversized media dimensions');
    }
    return { width, height, animated: false };
}

export function isoHeader(bytes: Uint8Array, kind: 'avif' | 'video'): RasterHeader {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = (at: number, n: number): string => String.fromCharCode(...bytes.subarray(at, at + n));
    let count = 0;
    const boxes = (start: number, end: number): Box[] => {
        const result: Box[] = [];
        for (let p = start; p < end;) {
            if (++count > 100000 || p + 8 > end) throw new Error('Invalid ISO box structure');
            let length = view.getUint32(p), header = 8;
            if (length === 1) {
                if (p + 16 > end) throw new Error('Truncated ISO box');
                const high = view.getUint32(p + 8), low = view.getUint32(p + 12);
                length = high * 0x100000000 + low;
                header = 16;
            } else if (length === 0) length = end - p;
            if (!Number.isSafeInteger(length) || length < header || length > end - p) throw new Error('Invalid ISO box length');
            result.push({ type: text(p + 4, 4), start: p, data: p + header, end: p + length });
            p += length;
        }
        return result;
    };
    const top = boxes(0, bytes.length);
    if (kind === 'avif') {
        const meta = top.find(box => box.type === 'meta');
        if (!meta || meta.data + 4 > meta.end) throw new Error('Missing AVIF metadata');
        const children = boxes(meta.data + 4, meta.end);
        const pitm = children.find(box => box.type === 'pitm');
        const iprp = children.find(box => box.type === 'iprp');
        if (!pitm || !iprp || pitm.data + 6 > pitm.end) throw new Error('Missing AVIF primary image');
        const version = bytes[pitm.data];
        if (version > 1 || (version === 1 && pitm.data + 8 > pitm.end)) throw new Error('Invalid AVIF primary image');
        const primary = version === 0 ? view.getUint16(pitm.data + 4) : view.getUint32(pitm.data + 4);
        const props = boxes(iprp.data, iprp.end);
        const ipco = props.find(box => box.type === 'ipco');
        if (!ipco) throw new Error('Missing AVIF properties');
        const properties = boxes(ipco.data, ipco.end);
        let declaredPixels = 0;
        for (const property of properties) {
            if (property.type !== 'ispe') continue;
            if (property.data + 12 > property.end) throw new Error('Invalid AVIF dimensions');
            const item = checkedSize(view.getUint32(property.data + 4), view.getUint32(property.data + 8));
            declaredPixels += item.width * item.height;
            if (declaredPixels > PIXELS) throw new RangeError('AVIF image properties exceed the pixel limit');
        }
        const associated: number[] = [];
        for (const ipma of props.filter(box => box.type === 'ipma')) {
            if (ipma.data + 8 > ipma.end) throw new Error('Invalid AVIF associations');
            const v = bytes[ipma.data], wide = (bytes[ipma.data + 3] & 1) !== 0;
            if (v > 1) throw new Error('Unsupported AVIF associations');
            const entries = view.getUint32(ipma.data + 4);
            if (entries > 100000) throw new Error('Too many AVIF associations');
            let p = ipma.data + 8;
            for (let i = 0; i < entries; i++) {
                const idBytes = v ? 4 : 2;
                if (p + idBytes + 1 > ipma.end) throw new Error('Truncated AVIF associations');
                const id = v ? view.getUint32(p) : view.getUint16(p);
                p += idBytes;
                const n = bytes[p++];
                if (p + n * (wide ? 2 : 1) > ipma.end) throw new Error('Truncated AVIF associations');
                for (let j = 0; j < n; j++) {
                    const index = wide ? view.getUint16(p) & 0x7fff : bytes[p] & 0x7f;
                    p += wide ? 2 : 1;
                    if (id === primary && index) associated.push(index);
                }
            }
        }
        let result: RasterHeader | undefined, rotation = 0;
        for (const index of associated) {
            const prop = properties[index - 1];
            if (!prop) throw new Error('Invalid AVIF property index');
            if (prop.type === 'irot') {
                if (prop.data + 1 > prop.end) throw new Error('Invalid AVIF rotation');
                rotation = bytes[prop.data] & 3;
            }
            if (prop.type !== 'ispe') continue;
            if (prop.data + 12 > prop.end) throw new Error('Invalid AVIF dimensions');
            const next = checkedSize(view.getUint32(prop.data + 4), view.getUint32(prop.data + 8));
            if (result && (result.width !== next.width || result.height !== next.height)) throw new Error('Ambiguous AVIF dimensions');
            result = next;
        }
        if (!result) throw new Error('Missing AVIF dimensions');
        const oriented = rotation % 2 ? checkedSize(result.height, result.width) : result;
        return { ...oriented, decodePixels: declaredPixels };
    }
    const moov = top.find(box => box.type === 'moov');
    if (!moov) throw new Error('Missing video metadata');
    let result: RasterHeader | undefined;
    for (const trak of boxes(moov.data, moov.end).filter(box => box.type === 'trak')) {
        const mdia = boxes(trak.data, trak.end).find(box => box.type === 'mdia');
        if (!mdia) continue;
        const media = boxes(mdia.data, mdia.end);
        const handler = media.find(box => box.type === 'hdlr');
        if (!handler || handler.data + 12 > handler.end || text(handler.data + 8, 4) !== 'vide') continue;
        const minf = media.find(box => box.type === 'minf');
        const stbl = minf && boxes(minf.data, minf.end).find(box => box.type === 'stbl');
        const stsd = stbl && boxes(stbl.data, stbl.end).find(box => box.type === 'stsd');
        if (!stsd || stsd.data + 8 > stsd.end) throw new Error('Missing video sample descriptions');
        const declared = view.getUint32(stsd.data + 4);
        const descriptions = boxes(stsd.data + 8, stsd.end);
        if (!declared || descriptions.length !== declared) throw new Error('Invalid video sample descriptions');
        for (const sample of descriptions) {
            if (sample.data + 28 > sample.end) throw new Error('Invalid video dimensions');
            const next = checkedSize(view.getUint16(sample.data + 24), view.getUint16(sample.data + 26));
            if (!result) result = next;
        }
    }
    if (!result) throw new Error('Missing video track');
    return result;
}
