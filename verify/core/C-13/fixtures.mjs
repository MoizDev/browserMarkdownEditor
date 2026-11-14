// Fixture expectations, not a parser: every case is opened through the real app.
const prefixes = {
    plain: ['', '', ''],
    indent: ['   ', '   ', '   '],
    list: ['- ', '  ', '  '],
    listTab: ['-\t', '\t', '\t'],
    quote: ['> ', '> ', '> '],
};

function note(name, { marker = '`', length = 3, closeLength = length, closeMarker = marker,
    suffix = '', lang = 'js', body = [`const value_${name} = 1;`], container = 'plain',
    closed = true, omitClose = false, control = false } = {}) {
    const [openPrefix, bodyPrefix, closePrefix] = prefixes[container];
    const opening = openPrefix + marker.repeat(length) + lang;
    const bodyRows = body.map(line => bodyPrefix + line);
    const closing = omitClose ? null : closePrefix + closeMarker.repeat(closeLength) + suffix;
    const rows = [opening, ...bodyRows, ...(closing === null ? [] : [closing])];
    const code = [...bodyRows, ...(!closed && closing !== null ? [closing] : [])].join('\n');
    const heading = `Fixture ${name}`;
    const complete = `Complete ${name}`;
    const source = `# ${heading}\n\n${rows.join('\n')}${closed ? `\n\n# ${complete}` : ''}`;
    return { name, source, heading, complete, opening, closing, closed, code, control,
        diagram: closed && lang.toLowerCase() === 'mermaid' && !!code.trim() && container === 'plain',
        endQuery: closed ? complete : rows.at(-1),
        caretQuery: body.find(line => line.trim()) || marker.repeat(length) + lang,
        lastBodyLine: code.split('\n').at(-1) || '',
    };
}

export const fixtures = [
    note('BT3', { control: true }), note('TL3', { marker: '~' }),
    note('BT4', { length: 4, control: true }), note('TL4', { marker: '~', length: 4 }),
    note('BT5', { length: 5, control: true }), note('TL5', { marker: '~', length: 5 }),
    note('BTLongClose', { closeLength: 5, control: true }), note('TLLongClose', { marker: '~', closeLength: 5 }),
    note('BTShortClose', { length: 5, closeLength: 3, closed: false }),
    note('TLShortClose', { marker: '~', length: 5, closeLength: 3, closed: false }),
    note('BTMismatch', { closeMarker: '~', closed: false }),
    note('TLMismatch', { marker: '~', closeMarker: '`', closed: false }),
    note('BTTrailing', { suffix: ' trailing', closed: false }),
    note('TLTrailing', { marker: '~', suffix: ' trailing', closed: false }),
    note('BTOpen', { omitClose: true, closed: false }),
    note('TLOpen', { marker: '~', omitClose: true, closed: false }),
    note('BTEmpty', { body: [] }), note('TLEmpty', { marker: '~', body: [] }),
    note('BTOnlyOpen', { body: [], omitClose: true, closed: false }),
    note('TLOnlyOpen', { marker: '~', body: [], omitClose: true, closed: false }),
    note('BTBlankRows', { body: ['', 'const blankRows = 1;', ''] }),
    note('TLBlankRows', { marker: '~', body: ['', 'const blankRows = 1;', ''] }),
    note('BTIndent', { container: 'indent' }), note('TLIndent', { marker: '~', container: 'indent' }),
    note('BTList', { container: 'list' }), note('TLList', { marker: '~', container: 'list' }),
    note('BTListTab', { container: 'listTab' }), note('TLListTab', { marker: '~', container: 'listTab' }),
    note('BTQuote', { container: 'quote' }), note('TLQuote', { marker: '~', container: 'quote' }),
    note('BTDiagram', { lang: 'mermaid', body: ['flowchart LR', ' A --> B'], control: true }),
    note('TLDiagram', { marker: '~', lang: 'mermaid', body: ['flowchart LR', ' A --> B'] }),
    note('BTUpperDiagram', { lang: 'MeRmAiD', body: ['flowchart LR', ' A --> B'] }),
    note('TLUpperDiagram', { marker: '~', lang: 'MeRmAiD', body: ['flowchart LR', ' A --> B'] }),
    note('BTEmptyDiagram', { lang: 'mermaid', body: [] }),
    note('TLEmptyDiagram', { marker: '~', lang: 'mermaid', body: [] }),
    note('BTOpenDiagram', { lang: 'mermaid', body: ['flowchart LR', ' A --> B'], omitClose: true, closed: false }),
    note('TLOpenDiagram', { marker: '~', lang: 'mermaid', body: ['flowchart LR', ' A --> B'], omitClose: true, closed: false }),
    note('BTMismatchDiagram', { lang: 'mermaid', body: ['flowchart LR', ' A --> B'], closeMarker: '~', closed: false }),
    note('TLMismatchDiagram', { marker: '~', lang: 'mermaid', body: ['flowchart LR', ' A --> B'], closeMarker: '`', closed: false }),
];

/** Separate heavy companion: initial coverage is observed via C9, never inferred from elapsed time. */
export function partialFixture() {
    const item = note('PartialTilde', { marker: '~' });
    const intro = Array.from({ length: 50000 }, (_, i) => `Paragraph ${i} has **bold** words and ordinary text.`).join('\n\n');
    return { ...item, source: `# ${item.heading}\n\n${intro}\n\n${item.source.split('\n').slice(2).join('\n')}` };
}
