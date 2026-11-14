import { checkContentUrl } from '../security/urlPolicy';
import { SECURITY_LIMITS } from '../security/limits';
import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from '../model/textLimits';
import type { Block, Marks, RichFragment, Run } from '../text/richText';
import { matchingIdentity, validBoardIdentity } from '../workers/protocol';

// Provenance: clipboard/security contracts and native rich-text representation;
// independent isolated HTML extraction, no third-party source.
const CHUNK = 192 * 1024, LIMIT = SECURITY_LIMITS.clipboardHtmlBytes, MAX_DEPTH = 128, MAX_NODES = 2_000_000;
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const ignored = new Set(['script', 'style', 'form', 'object', 'iframe', 'embed', 'svg', 'math', 'template', 'noscript', 'head',
    'input', 'textarea', 'button', 'select', 'option', 'video', 'audio', 'canvas']);
interface Context { readonly marks: Marks; readonly dir: Block['dir']; readonly lists: readonly { kind: 'ul' | 'ol'; next: number }[]; readonly pre: boolean }
function safeLink(value: string | null): string | undefined {
    if (!value) return undefined;
    const result = checkContentUrl(value, 'click', { appOrigin: '' });
    return result.ok && result.url.length <= SECURITY_LIMITS.urlCharacters ? result.url : undefined;
}
async function parse(blob: Blob, mode: 'markers' | 'rich'): Promise<unknown> {
    const input = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
    // eslint-disable-next-line bme/html-sinks -- fixed opaque-origin sandbox, network-denied CSP; parsed nodes never enter its live DOM.
    const doc = new DOMParser().parseFromString(input, 'text/html');
    let visited = 0, sliceStart = performance.now();
    const tick = async (depth: number) => {
        if (depth > MAX_DEPTH || ++visited > MAX_NODES) throw new RangeError('Clipboard HTML is too complex');
        if ((visited & 255) === 0 || performance.now() - sliceStart > 4) { await pause(); sliceStart = performance.now(); }
    };
    if (mode === 'markers') {
        let hasPrivate = false, payload: string | null = null, legacy: string | null = null;
        const walk = async (node: Node, depth: number): Promise<void> => {
            await tick(depth);
            if (node.nodeType === 1) {
                const element = node as Element;
                if (element.hasAttribute('data-wb-board') || element.hasAttribute('data-wb-board-payload')) hasPrivate = true;
                if (payload === null && element.hasAttribute('data-wb-board-payload')) payload = element.getAttribute('data-wb-board-payload');
                if (legacy === null && element.hasAttribute('data-tldraw')) legacy = element.textContent ?? '';
            }
            for (let child = node.firstChild; child; child = child.nextSibling) await walk(child, depth + 1);
        };
        await walk(doc.documentElement, 0);
        return { hasPrivate, privatePayload: payload, legacyPayload: legacy };
    }
    const blocks: Block[] = [];
    let kind: Block['kind'] = 'p', level = 0, dir: Block['dir'] = 'auto', start: number | undefined;
    let runs: Run[] = [], length = 0;
    const flush = (force = false) => {
        if (!runs.length && !force) return;
        if (blocks.length >= MAX_TEXT_BLOCKS || length + blocks.length > MAX_TEXT_LENGTH) throw new RangeError('Clipboard text exceeds limits');
        blocks.push({ kind, level, dir, ...(kind === 'ol' && start !== undefined ? { start } : {}),
            runs: runs.length ? runs : [{ text: '', marks: {} }] });
        runs = []; kind = 'p'; level = 0; dir = 'auto'; start = undefined;
    };
    const add = async (value: string, marks: Marks, pre: boolean) => {
        for (let offset = 0; offset < value.length;) {
            let end = Math.min(value.length, offset + 4096);
            const last = value.charCodeAt(end - 1);
            if (end < value.length && (last >= 0xd800 && last <= 0xdbff || pre && last === 13 && value.charCodeAt(end) === 10)) end++;
            const chunk = value.slice(offset, end); offset = end;
            const parts = pre ? chunk.replace(/\r\n?/g, '\n').split('\n') : [chunk.replace(/[\t\n\r\f ]+/g, ' ')];
            for (let i = 0; i < parts.length; i++) {
                if (i) flush(true);
                let part = parts[i];
                if (!pre && part.startsWith(' ') && (!runs.length || runs[runs.length - 1].text.endsWith(' '))) part = part.slice(1);
                if (!part) continue;
                length += part.length;
                if (length + blocks.length > MAX_TEXT_LENGTH) throw new RangeError('Clipboard text exceeds limits');
                runs.push({ text: part, marks });
            }
            if (offset < value.length) await pause();
        }
    };
    const walk = async (node: Node, ctx: Context, depth: number): Promise<void> => {
        await tick(depth);
        if (node.nodeType === 3) { await add(node.nodeValue ?? '', ctx.marks, ctx.pre); return; }
        if (node.nodeType !== 1) return;
        const el = node as Element, tag = el.localName.toLowerCase();
        if (ignored.has(tag) || el.hasAttribute('data-wb-board-payload')) return;
        if (tag === 'br') { flush(true); return; }
        const ownDir = el.getAttribute('dir'), nextDir = ownDir === 'ltr' || ownDir === 'rtl' || ownDir === 'auto' ? ownDir : ctx.dir;
        let marks: Marks = ctx.marks;
        if (tag === 'b' || tag === 'strong') marks = { ...marks, b: true };
        else if (tag === 'i' || tag === 'em') marks = { ...marks, i: true };
        else if (tag === 'u') marks = { ...marks, u: true };
        else if (tag === 's' || tag === 'strike' || tag === 'del') marks = { ...marks, s: true };
        else if (tag === 'code' || tag === 'pre') marks = { ...marks, code: true };
        else if (tag === 'mark') marks = { ...marks, hl: true };
        else if (tag === 'a') { const link = safeLink(el.getAttribute('href')); if (link) marks = { ...marks, link }; }
        let lists = ctx.lists;
        if (tag === 'ul' || tag === 'ol') {
            const parsed = Number(el.getAttribute('start') ?? 1);
            lists = [...lists, { kind: tag, next: Number.isFinite(parsed) ? parsed : 1 }];
        }
        const heading = /^h[1-6]$/.test(tag), paragraph = tag === 'p' || tag === 'li' || heading || tag === 'div' || tag === 'pre';
        if (paragraph) {
            flush();
            const list = tag === 'li' ? lists[lists.length - 1] : undefined;
            kind = list?.kind ?? (heading ? tag as Block['kind'] : 'p');
            level = list ? Math.min(7, lists.length - 1) : 0; dir = nextDir;
            if (list?.kind === 'ol') start = list.next++;
        }
        const before = blocks.length;
        const context = { marks, dir: nextDir, lists, pre: ctx.pre || tag === 'pre' };
        for (let child = node.firstChild; child; child = child.nextSibling) await walk(child, context, depth + 1);
        if (paragraph) flush(blocks.length === before);
    };
    await walk(doc.body, { marks: {}, dir: 'auto', lists: [], pre: false }, 0);
    flush();
    const fragment: RichFragment = { blocks: blocks.length ? blocks : [{ kind: 'p', level: 0, dir: 'auto', runs: [{ text: '', marks: {} }] }] };
    return fragment;
}
const initialize = (event: MessageEvent) => {
    if (event.source !== parent || event.ports.length !== 1) return;
    const init = event.data as { v?: unknown; token?: unknown; identity?: unknown } | null;
    if (!init || init.v !== 1 || typeof init.token !== 'string' || !/^[0-9a-f]{32}$/.test(init.token) || !validBoardIdentity(init.identity)) return;
    removeEventListener('message', initialize);
    const token = init.token, identity = init.identity, port = event.ports[0];
    let expected = 0, total = 0, done = false;
    const parts: ArrayBuffer[] = [];
    const send = (data: Record<string, unknown>) => port.postMessage({ v: 1, token, identity, ...data });
    port.addEventListener('message', (message: MessageEvent<unknown>) => {
        if (done || !message.data || typeof message.data !== 'object') return;
        const data = message.data as { v?: unknown; token?: unknown; identity?: unknown; type?: unknown; seq?: unknown; bytes?: unknown; mode?: unknown };
        if (data.v !== 1 || data.token !== token || !validBoardIdentity(data.identity) || !matchingIdentity(data.identity, identity)) return;
        if (data.type === 'chunk') {
            if (data.seq !== expected || !(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength > CHUNK || data.bytes.byteLength > LIMIT - total) {
                done = true; send({ type: 'error' }); return;
            }
            parts.push(data.bytes); total += data.bytes.byteLength; send({ type: 'ack', seq: expected++ });
        } else if (data.type === 'finish' && data.seq === expected && (data.mode === 'markers' || data.mode === 'rich')) {
            done = true;
            void parse(new Blob(parts, { type: 'text/html' }), data.mode).then(result => send({ type: 'result', result }), () => send({ type: 'error' }));
        }
    });
    port.start(); send({ type: 'ready' });
};
addEventListener('message', initialize);
