import { crc32 } from 'node:zlib';

/** Original, deterministic EPUB3 fixture: one visible XHTML chapter, no remote assets.
 * Kept beside the run rather than borrowing a user's book to exercise its opaque frame.
 * @returns {Buffer}
 */
export function opaqueFrameEpub() {
    const entries = [
        ['mimetype', 'application/epub+zip'],
        ['META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
        ['OEBPS/package.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">opaque-frame-fixture</dc:identifier><dc:title>Opaque Frame Control</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2000-01-01T00:00:00Z</meta></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="chapter"/></spine></package>'],
        ['OEBPS/chapter.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title>Opaque Frame</title></head><body><h1>Opaque Frame</h1><p>Opaque frame witness is visible.</p></body></html>'],
        ['OEBPS/nav.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Opaque Frame</a></li></ol></nav></body></html>'],
    ];
    const local = [], central = [];
    let offset = 0;
    for (const [name, text] of entries) {
        const filename = Buffer.from(name), bytes = Buffer.from(text), checksum = crc32(bytes);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(0x0800, 6);
        header.writeUInt16LE(0x21, 12);
        header.writeUInt32LE(checksum, 14);
        header.writeUInt32LE(bytes.length, 18);
        header.writeUInt32LE(bytes.length, 22);
        header.writeUInt16LE(filename.length, 26);
        const directory = Buffer.alloc(46);
        directory.writeUInt32LE(0x02014b50, 0);
        directory.writeUInt16LE(20, 4);
        directory.writeUInt16LE(20, 6);
        directory.writeUInt16LE(0x0800, 8);
        directory.writeUInt16LE(0x21, 14);
        directory.writeUInt32LE(checksum, 16);
        directory.writeUInt32LE(bytes.length, 20);
        directory.writeUInt32LE(bytes.length, 24);
        directory.writeUInt16LE(filename.length, 28);
        directory.writeUInt32LE(offset, 42);
        local.push(header, filename, bytes);
        central.push(directory, filename);
        offset += header.length + filename.length + bytes.length;
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, directory, end]);
}
