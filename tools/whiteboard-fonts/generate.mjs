// Build-only extraction: the pinned WOFF2 tables are read, never modified.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const fonts = resolve(root, 'src/whiteboard/text/fonts');
const output = resolve(root, 'src/whiteboard/text/fontMetrics.json');
const manifest = JSON.parse(readFileSync(resolve(here, 'manifest.json'), 'utf8'));
const expected = manifest.faces.map(face => face.file).sort();
const actual = readdirSync(fonts).filter(name => name.endsWith('.woff2')).sort();
if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Font directory does not match the pinned manifest');

// WOFF2 §4.1 known tag indices; hhea, head, OS/2 and post have null transforms.
const tags = ['cmap','head','hhea','hmtx','maxp','name','OS/2','post','cvt ','fpgm','glyf','loca','prep','CFF ','VORG','EBDT','EBLC','gasp','hdmx','kern','LTSH','PCLT','VDMX','vhea','vmtx','BASE','GDEF','GPOS','GSUB','EBSC','JSTF','MATH','CBDT','CBLC','COLR','CPAL','SVG ','sbix','acnt','avar','bdat','bloc','bsln','cvar','fdsc','feat','fmtx','fvar','gvar','hsty','just','lcar','mort','morx','opbd','prop','trak','Zapf','Silf','Glat','Gloc','Feat','Sill'];
function metrics(buf) {
    if (buf.toString('ascii', 0, 4) !== 'wOF2' || buf.toString('ascii', 4, 8) === 'ttcf') throw new Error('Expected a single WOFF2 font');
    let p = 48;
    function base128() {
        let n = 0;
        for (let i = 0; i < 5; i++) {
            const b = buf[p++];
            if (b === undefined || (i === 0 && b === 0x80) || n > 0x1ffffff) throw new Error('Invalid WOFF2 UIntBase128');
            n = n * 128 + (b & 127);
            if (!(b & 128)) return n;
        }
        throw new Error('Invalid WOFF2 UIntBase128');
    }
    const entries = [];
    for (let i = 0; i < buf.readUInt16BE(12); i++) {
        const flags = buf[p++], index = flags & 63;
        let tag = tags[index];
        if (index === 63) { tag = buf.toString('ascii', p, p + 4); p += 4; }
        const originalLength = base128();
        const transformed = tag === 'glyf' || tag === 'loca' ? flags >> 6 !== 3 : flags >> 6 !== 0;
        const length = transformed ? base128() : originalLength;
        entries.push({ tag, length, transformed });
    }
    const block = brotliDecompressSync(buf.subarray(p, p + buf.readUInt32BE(20)));
    const tables = new Map();
    let offset = 0;
    for (const entry of entries) {
        if (offset + entry.length > block.length) throw new Error('Invalid WOFF2 table length');
        if (['head','hhea','OS/2','post'].includes(entry.tag)) {
            if (entry.transformed) throw new Error(`Unexpected ${entry.tag} transform`);
            tables.set(entry.tag, block.subarray(offset, offset + entry.length));
        }
        offset += entry.length;
    }
    const head = tables.get('head'), hhea = tables.get('hhea'), os = tables.get('OS/2'), post = tables.get('post');
    if (!head || !hhea || !os || !post || os.readUInt16BE(0) < 2) throw new Error('Missing font metrics tables or x-height');
    return { unitsPerEm: head.readUInt16BE(18), ascent: hhea.readInt16BE(4), descent: -hhea.readInt16BE(6), xHeight: os.readInt16BE(86), underlinePosition: post.readInt16BE(8), underlineThickness: post.readInt16BE(10), strikePosition: os.readInt16BE(28), strikeThickness: os.readInt16BE(26) };
}
const result = {};
for (const face of manifest.faces) {
    const bytes = readFileSync(resolve(fonts, face.file));
    if (createHash('sha256').update(bytes).digest('hex') !== face.sha256) throw new Error(`Font hash mismatch: ${face.file}`);
    result[face.file] = metrics(bytes);
}
const generated = JSON.stringify(result, null, 2) + '\n';
if (process.argv.includes('--check')) {
    if (readFileSync(output, 'utf8') !== generated) throw new Error('Font metrics are out of date');
} else writeFileSync(output, generated);
