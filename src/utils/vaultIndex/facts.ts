import { parser, GFM, Subscript, Superscript, Emoji } from '@lezer/markdown';
import type { Tree } from '@lezer/common';
import { embedPattern } from '../assets';
import { codeRangesForTree, findMathRegions } from '../mathRegions';
import { overlapsRange } from '../rangeSearch';

export interface NoteFacts {
    wikilinks: string[];
    mdLinks: string[];
    embeds: string[];
}

// The editor's markdownLanguage uses these same syntax extensions. Its extra
// CodeMirror configuration supplies highlighting and indentation, not grammar.
const markdown = parser.configure([GFM, Subscript, Superscript, Emoji]);

function markdownTarget(raw: string): string | null {
    let path: string;
    try { path = decodeURIComponent(raw.trim()); } catch { return null; }
    if (!path || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
        || /[\\?#]/.test(path) || path.startsWith('//')
        || /^[a-z][a-z\d+.-]*:/i.test(path) || !/\.md$/i.test(path)) return null;
    return path;
}

export function noteFacts(text: string, tree: Tree = markdown.parse(text)): NoteFacts {
    const code = codeRangesForTree(tree);
    const math = findMathRegions(text, code);
    const excluded = (from: number, to: number) => overlapsRange(code, from, to) || overlapsRange(math, from, to);
    const wikilinks: string[] = [], mdLinks: string[] = [], embeds: string[] = [];
    const wiki = /(!?)\[\[([^\]\n]+?)\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = wiki.exec(text))) {
        if (match[1] || excluded(match.index, match.index + match[0].length)) continue;
        const target = match[2].split('|')[0].split('#')[0].trim();
        if (target) wikilinks.push(target);
    }
    const embed = embedPattern();
    while ((match = embed.exec(text))) {
        if (excluded(match.index, match.index + match[0].length)) continue;
        const name = match[1].trim();
        if (name) embeds.push(name);
    }
    tree.iterate({ enter(ref) {
        if (ref.name !== 'Link' || excluded(ref.from, ref.to)) return;
        const node = ref.node;
        const marks = node.getChildren('LinkMark');
        if (marks.length < 4) return;
        const url = marks[2].nextSibling;
        if (!url || url.name !== 'URL') return;
        let raw = text.slice(url.from, url.to);
        if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1);
        const target = markdownTarget(raw);
        if (target) mdLinks.push(target);
    } });
    return { wikilinks, mdLinks, embeds };
}

/** Yield between parser advances so governor pause/cancellation take effect. */
export async function noteFactsSliced(text: string, slice: () => Promise<void>): Promise<NoteFacts> {
    const parse = markdown.startParse(text);
    let tree: Tree | null;
    while (!(tree = parse.advance())) await slice();
    await slice();
    return noteFacts(text, tree);
}
