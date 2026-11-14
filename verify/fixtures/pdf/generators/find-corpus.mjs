import { createHash } from 'node:crypto';
import { parseArgs } from '../../lib/cli.mjs';
import { fixtureWriter, jsonBytes } from '../../lib/output.mjs';

// The PDF is authored here, including its Unicode map: neither expected text nor
// offsets come from the app's extraction. Bytes are independent of clock/locale.
const options = parseArgs(process.argv.slice(2), ['fault', 'variant']);
if ((options.fault !== undefined && options.fault !== 'content-xref') || (options.variant !== undefined && options.variant !== 'cap') || (options.fault && options.variant)) throw new Error('Choose --fault content-xref OR --variant cap, not both');
const seed = options.seed, corrupt = options.fault === 'content-xref', cap = options.variant === 'cap';
const name = cap ? 'find-cap' : corrupt ? 'find-corpus-corrupt' : 'find-corpus';
const id = cap ? 'GEN-P07a-find-cap' : corrupt ? 'GEN-P07a-find-corrupt' : 'GEN-P07a-find-corpus';
const pageCount = cap ? 1 : 60, emit = fixtureWriter(options.out);
const objects = [];
const add = value => { objects.push(value); return objects.length; };
const catalog = add('');
const pages = add('');
const font = add('');
const cmap = add('');
const chars = [...new Set([...('Find corpus page 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz -\u2010\u2011\u00adRésuméﬁnalﬂowerשלום')])];
let extraCode = 128;
const codes = new Map(chars.map(c => [c, c.codePointAt(0) < 128 ? c.codePointAt(0) : extraCode++]));
const hex = c => c.codePointAt(0).toString(16).padStart(4, '0');
const mapping = chars.map(c => `<${codes.get(c).toString(16).padStart(2, '0')}> <${hex(c)}>`).join('\n');
const cmapText = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Fixture) /Ordering (Unicode) /Supplement 0 >> def\n/CMapName /FindCorpus def\n/CMapType 2 def\n1 begincodespacerange\n<00> <ff>\nendcodespacerange\n${chars.length} beginbfchar\n${mapping}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
function stream(text, dict = '') { return `<< /Length ${Buffer.byteLength(text)} ${dict} >>\nstream\n${text}\nendstream`; }
objects[cmap - 1] = stream(cmapText);
objects[font - 1] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 255 /Widths [${Array.from({ length: 224 }, () => 600).join(' ')}] /ToUnicode ${cmap} 0 R >>`;
function encoded(text) { return `<${[...text].map(c => { if (!codes.has(c)) throw new Error(`Unmapped character ${c}`); return codes.get(c).toString(16).padStart(2, '0'); }).join('')}> Tj`; }
const probes = [
    { query: 'line start', page: 2, lines: ['line', 'start'], canonical: 'line\nstart' },
    { query: 'transformation', page: 3, lines: ['transfor-', 'mation'], canonical: 'transfor-\nmation' },
    { query: 'Hello World', page: 4, tokens: ['Hello', 'World'], canonical: 'HelloWorld' },
    { query: 'later sentinel', page: 6, lines: ['later sentinel'], canonical: 'later sentinel' },
    { query: 'resume', page: 7, lines: ['Résumé'], canonical: 'Résumé' },
    { query: 'final', page: 8, lines: ['ﬁnal'], canonical: 'ﬁnal' },
    { query: 'flower', page: 9, lines: ['ﬂower'], canonical: 'ﬂower' },
    { query: 'state-of-the-art', page: 10, lines: ['state-of-', 'the-art'], canonical: 'state-of-\nthe-art' },
    { query: 'transformation', page: 11, lines: ['transfor\u2010', 'mation'], canonical: 'transfor\u2010\nmation' },
    { query: 'transfor mation', page: 12, lines: ['transfor\u00ad', 'mation'], canonical: 'transfor\nmation', knownLoss: 'pdf.js removes U+00AD before canonical text; transformation cannot join this line end in schema 1.' },
    { query: 'HelloWorld', page: 4, tokens: ['Hello', 'World'], canonical: 'HelloWorld' },
    { query: 'שלום', page: 13, lines: ['םולש'], canonical: 'שלום' },
    { query: 'partial sentinel', page: 15, lines: ['partial sentinel'], canonical: 'partial sentinel' },
    { query: 'transformation', page: 17, lines: ['transfor\u2011', 'mation'], canonical: 'transfor\u2011\nmation' },
    { query: 'remote sentinel', page: 60, lines: ['remote sentinel'], canonical: 'remote sentinel' },
];
const kids = [];
let brokenContent = 0;
for (let page = 1; page <= pageCount; page++) {
    const probe = probes.find(p => p.page === page);
    const lines = probe?.lines ?? [`Find corpus page ${page}`];
    let content = 'BT /F1 18 Tf 24 TL 64 700 Td\n';
    if (probe?.tokens) content += probe.tokens.map(token => `/Span BMC\n${encoded(token)}\nEMC`).join('\n');
    else content += lines.map((line, i) => `${i ? 'T*\n' : ''}${encoded(line)}`).join('\n');
    content += '\nET';
    if (page === 15) content += `\nBT /F1 0.001 Tf 64 660 Td /Span BMC ${encoded('a'.repeat(600_000))} EMC ET`;
    if (cap) content = `BT /F1 0.001 Tf 64 700 Td ${encoded('a'.repeat(10_005))} ET`;
    // Invalid Flate bytes exercise the real worker's corrupt-stream handling.
    const contents = page === 5 ? add(stream('not a deflate stream', '/Filter /FlateDecode')) : add(stream(content));
    if (page === 14 && corrupt) brokenContent = contents;
    kids.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contents} 0 R >>`));
}
const info = add('<< /CreationDate (D:20000101000000Z) /ModDate (D:20000101000000Z) /Producer (Find corpus raw PDF writer v1) /Creator (Authored find fixture v1) >>');
objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
objects[pages - 1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map(n => `${n} 0 R`).join(' ')}] >>`;
let pdf = '%PDF-1.7\n', offsets = [0];
objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1 === brokenContent ? 9999 : index + 1} 0 obj\n${object}\nendobj\n`; });
const documentId = createHash('sha256').update(`${id}:1:${seed}`).digest('hex').slice(0, 32);
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R /ID [<${documentId}><${documentId}>] >>\nstartxref\n${xref}\n%%EOF\n`;
const bytes = Buffer.from(pdf);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const manifest = { id, file: `${name}.pdf`, sha256, bytes: bytes.length, seed, version: 1, writer: 'find-corpus-raw-v1', pages: pageCount,
    corruptPage: cap ? null : 5, failedPage: corrupt ? 14 : null, partialPage: cap ? null : 15,
    knownLosses: cap ? [] : probes.filter(probe => probe.knownLoss).map(probe => ({ page: probe.page, loss: probe.knownLoss })),
    probes: cap ? [{ query: 'a', page: 1, count: 10_005, capped: true, reportedCount: 10_000 }] : probes.map(({ query, page, canonical }) => ({ query, page, canonical, from: 0, to: canonical.length, count: 1 })) };
await emit(manifest.file, bytes);
await emit(`${name}.json`, jsonBytes(manifest));
