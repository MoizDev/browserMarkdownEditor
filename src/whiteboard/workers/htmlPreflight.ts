import type { WorkerContext } from '../../platform/workers';
import { SECURITY_LIMITS } from '../security/limits';

// Provenance: SEC-W1/W3 lexical HTML limits before contained DOM parsing;
// independent bounded tokenizer, no upstream engine source.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
const P_BREAK = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
const autoClose: Readonly<Record<string, readonly string[]>> = Object.freeze({
    li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], option: ['option'], optgroup: ['option', 'optgroup'],
    tr: ['tr'], td: ['td', 'th'], th: ['td', 'th'], thead: ['thead', 'tbody', 'tfoot'],
    tbody: ['thead', 'tbody', 'tfoot'], tfoot: ['thead', 'tbody', 'tfoot'],
});
const alpha = (code: number) => code >= 65 && code <= 90 || code >= 97 && code <= 122;
const nameChar = (code: number) => Number.isFinite(code) && code !== 9 && code !== 10 && code !== 12
    && code !== 13 && code !== 32 && code !== 47 && code !== 62;

export async function htmlPreflight(blob: Blob, context: WorkerContext): Promise<true> {
    if (!(blob instanceof Blob) || (typeof File !== 'undefined' && blob instanceof File) || blob.size > SECURITY_LIMITS.clipboardHtmlBytes) {
        throw new TypeError('HTML preflight requires bounded copied bytes');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
    context.signal.throwIfAborted();
    const stack: string[] = []; let elements = 0, i = 0, work = 0;
    const tick = async () => { context.signal.throwIfAborted(); await context.slice(); context.signal.throwIfAborted(); work = 0; };
    const close = (names: readonly string[], barriers: readonly string[] = []) => {
        for (let index = stack.length - 1; index >= 0; index--) {
            if (names.includes(stack[index])) { stack.length = index; return; }
            if (barriers.includes(stack[index])) return;
        }
    };
    while (i < text.length) {
        if (++work >= 4096) await tick();
        const raw = stack.at(-1);
        if (raw && RAW.has(raw)) {
            if (raw === 'plaintext') break;
            if (text[i] !== '<' || text[i + 1] !== '/' || text.slice(i + 2, i + 2 + raw.length).toLowerCase() !== raw
                || nameChar(text.charCodeAt(i + 2 + raw.length))) { i++; continue; }
        }
        if (text[i] !== '<') { i++; continue; }
        if (text.startsWith('<!--', i)) {
            if (text[i + 4] === '>') { i += 5; continue; }
            if (text[i + 4] === '-' && text[i + 5] === '>') { i += 6; continue; }
            i += 4;
            while (i < text.length && !text.startsWith('-->', i) && !text.startsWith('--!>', i)) {
                i++; if (++work >= 4096) await tick();
            }
            if (i < text.length) i += text.startsWith('--!>', i) ? 4 : 3;
            continue;
        }
        if (text[i + 1] === '!' || text[i + 1] === '?') {
            i += 2;
            while (i < text.length && text[i] !== '>') { i++; if (++work >= 4096) await tick(); }
            if (i < text.length) i++;
            continue;
        }
        let position = i + 1, closing = false;
        if (text[position] === '/') { closing = true; position++; }
        if (!alpha(text.charCodeAt(position))) { i++; continue; }
        const start = position++;
        while (position < text.length && nameChar(text.charCodeAt(position))) {
            position++; if (++work >= 4096) await tick();
        }
        const name = text.slice(start, position).toLowerCase();
        let quote = '', expectValue = false, unquoted = false, selfClosing = false;
        while (position < text.length) {
            const character = text[position++], space = character === ' ' || character === '\t' || character === '\n' || character === '\r' || character === '\f';
            if (quote) { if (character === quote) quote = ''; }
            else if (character === '>') break;
            else if (unquoted) { if (space) unquoted = false; selfClosing = false; }
            else if (expectValue) {
                if (!space) { expectValue = false; if (character === '"' || character === "'") quote = character; else unquoted = true; }
                selfClosing = false;
            } else if (character === '=') { expectValue = true; selfClosing = false; }
            else if (!space) selfClosing = character === '/';
            if (++work >= 4096) await tick();
        }
        if (position > text.length || text[position - 1] !== '>') break;
        i = position;
        if (closing) { close([name]); continue; }
        if (++elements > SECURITY_LIMITS.htmlElements) throw new RangeError('Clipboard HTML has too many elements');
        if (P_BREAK.has(name)) close(['p'], ['button', 'html', 'table', 'template']);
        const implicit = autoClose[name];
        if (implicit) close(implicit, name === 'li' ? ['ul', 'ol'] : name === 'dt' || name === 'dd' ? ['dl']
            : name === 'option' || name === 'optgroup' ? ['select', 'datalist'] : ['table']);
        const foreign = name === 'svg' || name === 'math' || stack.some(tag => tag === 'svg' || tag === 'math');
        if (foreign ? selfClosing : VOID.has(name)) continue;
        stack.push(name);
        if (stack.length > SECURITY_LIMITS.htmlDepth) throw new RangeError('Clipboard HTML nesting is too deep');
    }
    context.signal.throwIfAborted(); return true;
}
