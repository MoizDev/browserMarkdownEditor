import { deflateSync } from 'node:zlib';
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const tag = Buffer.from(type, 'ascii');
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
    return Buffer.concat([size, tag, data, crc]);
}
export function checkerPng() {
    const size = 32;
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 2;
    const rows = Buffer.alloc(size * (1 + size * 3));
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const offset = y * (1 + size * 3) + 1 + x * 3;
            const dark = ((x >> 3) + (y >> 3)) % 2;
            rows.set(dark ? [28, 70, 145] : [245, 204, 67], offset);
        }
    }
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
        chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
    ]);
}
