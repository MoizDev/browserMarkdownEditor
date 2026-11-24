/** Format a PDF selection for the tiled viewer's Copy as quote action. */
export function pdfSelectionQuote(text: string, filename: string, path: string, firstPage: number, lastPage: number): string {
    const quote = text.replace(/\r\n?/g, '\n').split('\n').map(line => line ? `> ${line}` : '>').join('\n');
    // A vault-relative path is a URL, not a filesystem string in Markdown.
    // Keep separators while encoding delimiters that could end the link.
    const target = path.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
    const label = filename.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
    const start = Math.max(1, Math.floor(firstPage) + 1), end = Math.max(start, Math.floor(lastPage) + 1);
    return `${quote}\n> — [${label}](${target}), p. ${start}${end === start ? '' : `–${end}`}\n`;
}

/** One-line query shared by the vault-search and in-document menu actions. */
export function pdfSelectionQuery(text: string): string {
    const line = text.replace(/\s+/gu, ' ').trim();
    let end = Math.min(256, line.length);
    if (end < line.length && /[\uD800-\uDBFF]/u.test(line[end - 1]) && /[\uDC00-\uDFFF]/u.test(line[end])) end--;
    return line.slice(0, end);
}
