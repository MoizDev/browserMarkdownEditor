import type { Block, Marks, RichText, Run } from '../text/richText';
import { NODE_FILE_FIELDS } from './fileFields';
import type { RawJson } from './json';
import type { LoadRepairNotice } from './loadTypes';
import type { NodeRecord } from './nodes';
import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from './textLimits';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const kinds = new Set(['p', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const flags = ['b', 'i', 'u', 's', 'code', 'hl'] as const;
const safeLink = (value: unknown): value is string => {
    if (typeof value !== 'string' || value.length > 2048) return false;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 32 || (code >= 127 && code <= 159)) return false;
    }
    try { const url = new URL(value); return !url.username && !url.password && ['http:', 'https:', 'mailto:'].includes(url.protocol); }
    catch { return false; }
};
const equalMarks = (a: Marks, b: Marks) => flags.every(key => a[key] === b[key]) && a.link === b.link && a.x === b.x;

export async function repairNodeText(nodes: readonly NodeRecord[], options: { cooperate?: () => Promise<void>; signal?: AbortSignal }): Promise<{
    nodes: readonly NodeRecord[]; changedOrdinals: ReadonlySet<number>; notices: readonly LoadRepairNotice[]; readOnlyReason: string | null;
}> {
    let steps = 0;
    const tick = async () => {
        if (options.signal?.aborted) throw new DOMException('Board admission cancelled', 'AbortError');
        await options.cooperate?.();
        if (options.signal?.aborted) throw new DOMException('Board admission cancelled', 'AbortError');
    };
    const due = () => (steps++ & 1023) === 0;
    const fail = (reason: string): never => { throw new RangeError(reason); };
    // Unknown marks may contain arbitrary input; bound traversal before serialization.
    const encodeUnknown = async (value: unknown): Promise<RawJson> => {
        const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }], seen = new Set<object>();
        let size = 0;
        while (pending.length) {
            if (due()) await tick();
            const item = pending.pop()!, v = item.value;
            if (item.depth > 32 || ++size > 65536) fail('Unknown rich marks exceed preservation limits');
            if (typeof v === 'string') size += v.length * 6;
            else if (typeof v === 'number') { if (!Number.isFinite(v)) fail('Unknown rich marks are not JSON'); }
            else if (v !== null && typeof v === 'object') {
                if (seen.has(v)) fail('Unknown rich marks are cyclic');
                seen.add(v);
                for (const [key, child] of Object.entries(v)) { size += key.length * 6; pending.push({ value: child, depth: item.depth + 1 }); }
            } else if (v !== null && typeof v !== 'boolean') fail('Unknown rich marks are not JSON');
            if (size > 65536) fail('Unknown rich marks exceed preservation limits');
        }
        const json = JSON.stringify(value);
        if (json === undefined || json.length > 65536) fail('Unknown rich marks exceed preservation limits');
        return json as RawJson;
    };
    const repair = async (source: unknown): Promise<{ value: RichText; changed: boolean; replacements: number }> => {
        let changed = false, replacements = 0, length = 0;
        const blocks: Block[] = [];
        let input: unknown[];
        if (typeof source === 'string') { input = [{ kind: 'p', level: 0, dir: 'auto', runs: [{ text: source, marks: {} }] }]; changed = true; }
        else if (object(source) && Array.isArray(source.blocks) && Object.keys(source).every(key => key === 'blocks')) input = source.blocks;
        else if (object(source) && typeof source.text === 'string' && Object.keys(source).every(key => key === 'text')) {
            input = [{ kind: 'p', level: 0, dir: 'auto', runs: [{ text: source.text, marks: {} }] }]; changed = true;
        } else return fail('Rich text structure cannot be preserved');
        if (input.length > MAX_TEXT_BLOCKS) fail('Rich text exceeds 100000 blocks');
        const push = (block: Block) => {
            if (blocks.length >= MAX_TEXT_BLOCKS || length + (blocks.length ? 1 : 0) > MAX_TEXT_LENGTH) fail('Rich text exceeds limits');
            if (blocks.length) length++;
            blocks.push(block);
        };
        for (const rawBlock of input) {
            if (due()) await tick();
            let block: ObjectValue;
            if (typeof rawBlock === 'string') { block = { kind: 'p', level: 0, dir: 'auto', runs: [{ text: rawBlock, marks: {} }] }; changed = true; }
            else if (object(rawBlock) && typeof rawBlock.text === 'string' && Object.keys(rawBlock).every(key => key === 'text')) {
                block = { kind: 'p', level: 0, dir: 'auto', runs: [{ text: rawBlock.text, marks: {} }] }; changed = true;
            } else if (object(rawBlock) && Object.keys(rawBlock).every(key => ['kind', 'level', 'start', 'dir', 'runs', 'tail'].includes(key))) block = rawBlock;
            else return fail('Rich block structure cannot be preserved');
            let kind = block.kind;
            if (typeof kind !== 'string' || !kinds.has(kind)) { kind = 'p'; changed = true; }
            const level = kind === 'p' ? 0 : typeof block.level === 'number' && Number.isFinite(block.level) ? Math.max(0, Math.min(7, Math.trunc(block.level))) : 0;
            if (level !== block.level) changed = true;
            const dir = block.dir === 'ltr' || block.dir === 'rtl' ? block.dir : 'auto';
            if (dir !== block.dir) changed = true;
            if (block.tail !== undefined && (typeof block.tail !== 'string' || !/^\s*\[/.test(block.tail) || !/\]\s*$/.test(block.tail))) fail('Invalid opaque block tail');
            if (block.start !== undefined && (kind !== 'ol' || typeof block.start !== 'number' || !Number.isFinite(block.start))) return fail('Rich block start cannot be preserved');
            let runs: Run[] = [];
            let first = true;
            const flush = async () => {
                if (runs.length > 1) {
                    const kept: Run[] = [];
                    for (const run of runs) {
                        if (due()) await tick();
                        if (run.text.length > 0 || run.tail !== undefined || run.marks.x !== undefined) kept.push(run);
                    }
                    if (kept.length !== runs.length) { runs = kept.length ? kept : [runs[0]]; changed = true; }
                }
                const out: Block = { kind: kind as Block['kind'], level, dir, runs: runs.length ? runs : [{ text: '', marks: {} }],
                    ...(first && block.start !== undefined ? { start: block.start as number } : {}),
                    ...(first && block.tail !== undefined ? { tail: block.tail as RawJson } : {}) };
                push(out); runs = []; first = false;
            };
            const rawRuns = Array.isArray(block.runs) ? block.runs : typeof block.runs === 'string' ? [block.runs] : null;
            if (!rawRuns) return fail('Rich runs cannot be preserved');
            if (!rawRuns.length) changed = true;
            for (const rawRun of rawRuns) {
                if (due()) await tick();
                let run: ObjectValue;
                if (typeof rawRun === 'string') { run = { text: rawRun, marks: {} }; changed = true; }
                else if (object(rawRun) && Object.keys(rawRun).every(key => ['text', 'marks', 'tail'].includes(key))) run = rawRun;
                else return fail('Rich run structure cannot be preserved');
                if (typeof run.text !== 'string') return fail('Rich run text cannot be preserved');
                if (run.tail !== undefined && (typeof run.tail !== 'string' || !/^\s*\[/.test(run.tail) || !/\]\s*$/.test(run.tail))) fail('Invalid opaque run tail');
                if (run.marks === undefined) changed = true;
                const rawMarks = run.marks === undefined ? {} : run.marks;
                if (!object(rawMarks)) return fail('Rich marks cannot be preserved');
                const marks: { b?: true; i?: true; u?: true; s?: true; code?: true; hl?: true; link?: string; x?: RawJson } = {};
                for (const key of flags) if (rawMarks[key] === true) marks[key] = true; else if (rawMarks[key] !== undefined) changed = true;
                if (rawMarks.link !== undefined) { if (safeLink(rawMarks.link)) marks.link = rawMarks.link; else changed = true; }
                if (rawMarks.x !== undefined) { if (typeof rawMarks.x !== 'string') return fail('Opaque rich marks cannot be preserved'); marks.x = rawMarks.x as RawJson; }
                const extra: ObjectValue = Object.create(null);
                for (const key of Object.keys(rawMarks)) if (!([...flags, 'link', 'x'] as string[]).includes(key)) extra[key] = rawMarks[key];
                if (Object.keys(extra).length) {
                    const encoded = await encodeUnknown(extra);
                    if (marks.x !== undefined) {
                        if (marks.x.length + encoded.length > 65536) return fail('Opaque rich marks exceed preservation limits');
                        marks.x = `{"previous":${marks.x},"unknown":${encoded}}` as RawJson;
                    } else marks.x = encoded;
                    changed = true;
                }
                const text = run.text;
                length += text.length;
                if (length > MAX_TEXT_LENGTH) fail('Rich text exceeds 1000000 UTF-16 units');
                let segment = '', last = 0;
                const append = (part: string, tail?: RawJson) => {
                    const previous = runs[runs.length - 1];
                    if (previous && previous.tail === undefined && previous.marks.x === undefined && tail === undefined && marks.x === undefined && equalMarks(previous.marks, marks)) {
                        runs[runs.length - 1] = { text: previous.text + part, marks: previous.marks }; changed = true;
                    } else runs.push({ text: part, marks, ...(tail !== undefined ? { tail } : {}) });
                };
                for (let i = 0; i < text.length; i++) {
                    if (due()) await tick();
                    const c = text.charCodeAt(i);
                    if (c === 10) {
                        length--;
                        segment += text.slice(last, i); append(segment, run.tail as RawJson | undefined); await flush();
                        segment = ''; last = i + 1; changed = true;
                        if (run.tail !== undefined || marks.x !== undefined) return fail('Cannot split opaque rich run safely');
                    } else if ((c < 32 && c !== 9) || (c >= 0xd800 && c <= 0xdfff && !(c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff))) {
                        segment += text.slice(last, i) + '\ufffd'; last = i + 1; changed = true; replacements++;
                    } else if (c >= 0xd800 && c <= 0xdbff) i++;
                }
                segment += text.slice(last);
                append(segment, run.tail as RawJson | undefined);
            }
            await flush();
        }
        if (!blocks.length) { push({ kind: 'p', level: 0, dir: 'auto', runs: [{ text: '', marks: {} }] }); changed = true; }
        return { value: { blocks }, changed, replacements };
    };
    const output: NodeRecord[] = [], changed = new Set<number>(), notices: LoadRepairNotice[] = [];
    await tick();
    try {
        for (let i = 0; i < nodes.length; i++) {
            if (due()) await tick();
            let node = nodes[i];
            const key = node.kind === 'text' || node.kind === 'sticky' ? 'text' : node.kind === 'figure' || node.kind === 'connector' ? 'label' : null;
            if (key && Reflect.get(node, key) !== null) {
                const fixed = await repair(Reflect.get(node, key));
                if (fixed.changed) {
                    if (NODE_FILE_FIELDS[key].some(token => node.ext?.raw.has(token))) return { nodes, changedOrdinals: new Set(), notices: [], readOnlyReason: `Repair would override preserved ${key} on ${node.id}` };
                    node = { ...node, [key]: fixed.value } as NodeRecord;
                    changed.add(i); notices.push({ code: 'rich-text', count: 1, nodeIds: [node.id] });
                    if (fixed.replacements) notices.push({ code: 'rich-text-replaced-controls', count: fixed.replacements, nodeIds: [node.id] });
                }
            }
            output.push(node);
        }
        await tick();
        return { nodes: output, changedOrdinals: changed, notices, readOnlyReason: null };
    } catch (error) {
        if (!(error instanceof RangeError) || options.signal?.aborted) throw error;
        return { nodes, changedOrdinals: new Set(), notices: [], readOnlyReason: error.message };
    }
}
