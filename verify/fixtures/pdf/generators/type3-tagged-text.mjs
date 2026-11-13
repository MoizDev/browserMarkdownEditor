// Entirely authored Type3 programs/text/structure. No fonts, app modules or
// existing PDF bytes are copied. Proposed licence CC0-1.0 awaits the owner.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdfBuilder, parseArgs, fixtureWriter, jsonBytes, literal, unicodeString, toUnicode, glyphPath, rectangle } from './rtl-cjk-unicode.mjs';

export async function generateType3(out, seed) {
    const doc = pdfBuilder({ id: 'GEN-11', version: 1, seed });
    const glyphs = [
        { unicode: 'A', width: 700, contours: [[[70, 0], [350, 750], [630, 0], [520, 0], [350, 500], [180, 0]]] },
        { unicode: 'B', width: 700, contours: [rectangle(100, 0, 100, 750), rectangle(200, 650, 350, 100), rectangle(200, 325, 300, 100), rectangle(200, 0, 350, 100), rectangle(500, 400, 100, 250), rectangle(500, 100, 100, 225)] },
        { unicode: 'C', width: 700, contours: [rectangle(100, 0, 100, 750), rectangle(200, 650, 400, 100), rectangle(200, 0, 400, 100)] },
    ];
    const names = ['OpaqueOne', 'OpaqueTwo', 'OpaqueThree'];
    const procs = glyphs.map(glyph => doc.stream(`${glyph.width} 0 0 0 700 800 d1\n${glyphPath(glyph)}`));
    const cmap = doc.stream(toUnicode(glyphs, false, 129));
    const font = mapped => doc.add(`<< /Type /Font /Subtype /Type3 /Name /AuthoredTypeThree /FontBBox [0 0 700 800] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << ${names.map((name, i) => `/${name} ${procs[i]} 0 R`).join(' ')} >> /Encoding << /Type /Encoding /Differences [129 ${names.map(name => `/${name}`).join(' ')}] >> /FirstChar 129 /LastChar 131 /Widths [700 700 700] /Resources << >> ${mapped ? `/ToUnicode ${cmap} 0 R` : ''} >>`);
    const unmapped = font(false), mapped = font(true);
    const type3Line = (text, y, mappedControl) => ({ text, x: 100, y, size: 48, custom: true, operator: `BT /${mappedControl ? 'F2' : 'F1'} 48 Tf 1 0 0 1 100 ${792 - y} Tm <818283> Tj ET`, semantic: mappedControl ? 'mapped ABC' : 'unmapped; replacement/partial expected' });
    const title = 'Authored Type3 and tagged text';
    const firstLines = [
        { text: title, x: 42, y: 56, size: 16 },
        { text: 'Mappings and structure have separate witnesses.', x: 42, y: 104, size: 11 },
        { text: 'Missing Unicode is not silently guessed.', x: 42, y: 124, size: 11 },
        { text: 'No ToUnicode / nonsemantic encoding names:', x: 42, y: 180, size: 11 },
        type3Line('\ufffd\ufffd\ufffd', 250, false),
        { text: 'Mapped control, exactly the same CharProcs:', x: 42, y: 300, size: 11 },
        type3Line('ABC', 370, true),
        { text: 'Type3 boundary ends with cedar.', x: 42, y: 752, size: 10 },
    ];
    doc.page({ lines: firstLines, resources: `/F1 ${unmapped} 0 R /F2 ${mapped} 0 R` });

    // Two real Form XObject levels; only the inner form owns the text font.
    const inner = doc.stream(`BT /F0 12 Tf 1 0 0 1 14 20 Tm ${literal('NESTED-FORM-TEXT')} Tj ET`, `/Type /XObject /Subtype /Form /BBox [0 0 300 60] /Resources << /Font << /F0 ${doc.courier} 0 R >> >>`);
    const outer = doc.stream('q 1 0 0 1 10 10 cm /Inner Do Q', `/Type /XObject /Subtype /Form /BBox [0 0 320 80] /Resources << /XObject << /Inner ${inner} 0 R >> >>`);
    doc.page({ lines: [
        { text: 'Type3 boundary begins with maple.', x: 42, y: 56, size: 16 },
        { text: 'This page has no structural tagging.', x: 42, y: 104, size: 11 },
        { text: 'NESTED-FORM-TEXT', x: 114, y: 262, size: 12, custom: true, operator: 'q 1 0 0 1 90 500 cm /Outer Do Q' },
    ], otherResources: `/XObject << /Outer ${outer} 0 R >>` });

    const visibility = [
        { text: 'Hidden text is not visible-ink capability', x: 42, y: 56, size: 16 },
        { text: 'VISIBLE-CONTROL', x: 42, y: 150, size: 18 },
        { text: 'OFFPAGE-GLYPHS', x: 650, y: 200, size: 18 },
        { text: 'CLIPPED-GLYPHS', x: 42, y: 250, size: 18, prefix: 'q 42 530 40 24 re W n', suffix: 'Q' },
        { text: 'INVISIBLE-GLYPHS', x: 42, y: 320, size: 18, custom: true, operator: `q BT /F0 18 Tf 3 Tr 1 0 0 1 42 472 Tm ${literal('INVISIBLE-GLYPHS')} Tj ET Q` },
        { text: 'COVERED-GLYPHS', x: 42, y: 390, size: 18 },
    ];
    doc.page({ lines: visibility, operations: ['q 1 1 1 rg 38 392 320 48 re f Q'] });

    const structureRoot = doc.reserve();
    const parentTree = doc.reserve();
    const structure = Array.from({ length: 6 }, () => doc.reserve());
    const malformed = doc.reserve(), cycleA = doc.reserve(), cycleB = doc.reserve();
    const tag = (name, mcid, text, y, extra = '') => ({ text, x: 42, y, size: 16, prefix: `/${name} << /MCID ${mcid} ${extra} >> BDC`, suffix: 'EMC' });
    const taggedPage = doc.page({ lines: [
        { text: 'Tagged structure and explicit ActualText gap', x: 42, y: 56, size: 16 },
        tag('H1', 0, 'First structural heading', 150),
        tag('FixtureHeading', 1, 'Second structural heading', 190),
        tag('H3', 2, 'Third structural heading', 230),
        { text: '', x: 42, y: 330, size: 0, custom: true, operator: '/Figure << /MCID 3 >> BDC q 0.1 0.4 0.8 rg 42 462 80 60 re f Q EMC', semantic: 'Figure alt is structure metadata, not canonical page text.' },
        tag('Code', 4, 'let witness = 1;', 400),
        tag('Span', 5, 'DRAWN-TOKEN', 460, `/ActualText ${unicodeString('REPLACEMENT-TOKEN')}`),
    ], extra: '/StructParents 0' });
    const roles = ['H1', 'FixtureHeading', 'H3', 'Figure', 'Code', 'Span'];
    structure.forEach((id, i) => doc.set(id, `<< /Type /StructElem /S /${roles[i]} /P ${structureRoot} 0 R /Pg ${taggedPage} 0 R /K ${i} ${i === 3 ? `/Alt ${unicodeString('An authored blue square.')}` : ''} >>`));

    // Syntactically valid PDF objects with deliberately bad structural metadata.
    // Their displayed/canonical text is still independently known. Never call
    // the malformed/cyclic trees a successful accessibility representation.
    const malformedPage = doc.page({ lines: [
        { text: 'Malformed structure control', x: 42, y: 56, size: 16 },
        { text: 'MALFORMED-STRUCTURE-TEXT', x: 42, y: 180, size: 16, prefix: '/P << /MCID 9 >> BDC', suffix: 'EMC' },
    ], extra: '/StructParents 1' });
    doc.set(malformed, `<< /Type /StructElem /S /P /P ${structureRoot} 0 R /Pg ${malformedPage} 0 R /K (not-an-MCID-or-MCR) >>`);
    const cyclicPage = doc.page({ lines: [
        { text: 'Cyclic structure control', x: 42, y: 56, size: 16 },
        { text: 'CYCLIC-STRUCTURE-TEXT', x: 42, y: 180, size: 16, prefix: '/P << /MCID 0 >> BDC', suffix: 'EMC' },
    ], extra: '/StructParents 2' });
    doc.set(cycleA, `<< /Type /StructElem /S /P /P ${structureRoot} 0 R /Pg ${cyclicPage} 0 R /K ${cycleB} 0 R >>`);
    doc.set(cycleB, `<< /Type /StructElem /S /Span /P ${cycleA} 0 R /Pg ${cyclicPage} 0 R /K ${cycleA} 0 R >>`);
    doc.set(parentTree, `<< /Nums [0 [${structure.map(id => `${id} 0 R`).join(' ')}] 1 [${malformed} 0 R] 2 [${cycleA} 0 R]] >>`);
    doc.set(structureRoot, `<< /Type /StructTreeRoot /K [${structure.map(id => `${id} 0 R`).join(' ')} ${malformed} 0 R ${cycleA} 0 R] /ParentTree ${parentTree} 0 R /ParentTreeNextKey 3 /RoleMap << /FixtureHeading /H2 >> >>`);
    const result = doc.finish(`/StructTreeRoot ${structureRoot} 0 R /MarkInfo << /Marked true >> /Lang (en-US)`);
    const output = fixtureWriter(out);
    const record = await output('type3-tagged-text.pdf', result.bytes);
    await output('type3-tagged-text.expected.json', jsonBytes({ ...record, id: 'GEN-11', pages: 6, seed, generatorVersion: 1, writerVersion: 'BME raw PDF serializer v2; authored Type3 programs v1', licence: 'NOASSERTION', proposedLicence: 'CC0-1.0',
        expected: { pageModels: result.pageModels, correctSelectAllText: result.pageModels.map(page => page.lines.map(line => line.text).filter(Boolean).join('\n')).join('\n\n'), correctSelectAll: { scope: 'Physical-page/content-order logical strings; unmapped Type3 is U+FFFD/partial, not guessed letters; ActualText not substituted', source: 'Independently authored pageModels.lines[].text' },
            gestures: { title: { page: 1, from: [42, 49], to: [42 + title.length * 9.6, 49], correct: title }, twoLine: { page: 1, from: [42, 100], to: [42 + 'Missing Unicode is not silently guessed.'.length * 6.6, 120], correct: 'Mappings and structure have separate witnesses.\nMissing Unicode is not silently guessed.' }, crossPage: { from: { page: 1, point: [42, 748] }, to: { page: 2, point: [42 + 'Type3 boundary begins with maple.'.length * 9.6, 49] }, correct: 'Type3 boundary ends with cedar.\nType3 boundary begins with maple.' } },
            queries: [{ query: 'NESTED-FORM-TEXT', pages: [2], count: 1 }, { query: 'DRAWN-TOKEN', pages: [4], count: 1 }, { query: 'REPLACEMENT-TOKEN', pages: [], count: 0 }],
            perPage: [
                { page: 1, role: 'unmapped-and-mapped-type3', glyphBytes: '818283', glyphNames: names, sameCharProcs: true, unmapped: { toUnicode: false, logical: '\ufffd\ufffd\ufffd', partial: true, forbiddenGuess: 'ABC', rect: [100, 211.6, 200.8, 250] }, mapped: { toUnicode: true, logical: 'ABC', partial: false, rect: [100, 331.6, 200.8, 370] } },
                { page: 2, role: 'untagged-nested-form', structuralTagging: false, formDepth: 2, logicalString: 'NESTED-FORM-TEXT', textRect: [114, 250, 229.2, 262] },
                { page: 3, role: 'visibility-controls', textRuns: [{ text: 'VISIBLE-CONTROL', visible: true }, { text: 'OFFPAGE-GLYPHS', visible: false, rect: [650, 182, 790.4, 200] }, { text: 'CLIPPED-GLYPHS', visible: 'partial', clipRect: [42, 238, 82, 262] }, { text: 'INVISIBLE-GLYPHS', visible: false, renderingMode: 3 }, { text: 'COVERED-GLYPHS', visible: false, coverRect: [38, 352, 358, 400] }], emphasis: 'Only truly visible painted glyph regions may supply capability; extraction alone is not proof.' },
                { page: 4, role: 'tagged-headings-figure-code-actualtext', structure: [{ mcid: 0, role: 'H1' }, { mcid: 1, role: 'FixtureHeading', mappedRole: 'H2' }, { mcid: 2, role: 'H3' }, { mcid: 3, role: 'Figure', alt: 'An authored blue square.', rect: [42, 270, 122, 330] }, { mcid: 4, role: 'Code', logical: 'let witness = 1;' }, { mcid: 5, role: 'Span', drawn: 'DRAWN-TOKEN', actualText: 'REPLACEMENT-TOKEN', canonical: 'DRAWN-TOKEN', gap: 'TXT-50: ActualText is not substituted in this release; do not claim complete tagged-PDF accessibility.' }] },
                { page: 5, role: 'malformed-structure-negative', validity: 'invalid-structure', mcid: 9, parentTreeHasOnlySlot: 0, invalidK: 'not-an-MCID-or-MCR', logicalString: 'MALFORMED-STRUCTURE-TEXT', expected: 'Text/render survives or truthful bounded structure refusal; no successful-structure claim.' },
                { page: 6, role: 'cyclic-structure-negative', validity: 'invalid-structure', cycle: ['elementA.K -> elementB', 'elementB.K -> elementA'], logicalString: 'CYCLIC-STRUCTURE-TEXT', expected: 'Bounded structure traversal/refusal, no hang, healthy page remains readable.' },
            ], limitations: ['Unmapped Type3 has no recoverable Unicode; replacement/partial is the intended result, not invented ABC.', 'The PDF object graph is readable; pages 5/6 deliberately contain invalid structure metadata and are negative controls.', 'ActualText and figure alt are recorded as metadata, not silently inserted into canonical page text.'] } }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { out, seed } = parseArgs(process.argv.slice(2));
    await generateType3(out, seed);
}
