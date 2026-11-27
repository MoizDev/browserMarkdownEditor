import { parseJson, type JsonSpan } from '../../whiteboard/format/jsonRead';
import { NODE_PROPERTY_ORDER } from '../../whiteboard/format/schema';
import { turnAngle, turnBox, turnPoint } from './quarterTurn';

export class BoardTurnRefused extends Error {
    constructor(readonly reason: 'unknown-content' | 'invalid') { super(reason === 'unknown-content'
        ? 'The board holds marks this version cannot move' : 'The board could not be read for turning'); this.name = 'BoardTurnRefused'; }
}
const invalid = (): never => { throw new BoardTurnRefused('invalid'); };

interface Line { text: string; comma: boolean }
interface NodeFacts { parent: string; page: number }

const KNOWN_KINDS = new Set(Object.keys(NODE_PROPERTY_ORDER).filter(kind => kind !== 'opaque'));
const number = (value: number) => JSON.stringify(value);

function lines(text: string): { header: string; records: Line[]; footer: string } {
    const all = text.split('\n');
    if (all.at(-1) === '') all.pop();
    if (all.length < 2 || !all[0].endsWith('[') || all.at(-1)!.trim() !== ']}') invalid();
    const records = all.slice(1, -1).map(line => {
        const comma = line.endsWith(',');
        return { text: comma ? line.slice(0, -1) : line, comma };
    });
    return { header: all[0], records, footer: all.at(-1)! };
}

function splice(text: string, edits: Array<{ start: number; end: number; text: string }>): string {
    let out = '', at = 0;
    for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
        if (edit.start < at) invalid();
        out += text.slice(at, edit.start) + edit.text;
        at = edit.end;
    }
    return out + text.slice(at);
}

function box(span: JsonSpan | undefined): [number, number, number, number] | undefined {
    if (!span || span.kind !== 'array') return undefined;
    const items = [...span.items()];
    if (items.length !== 4 || items.some(item => item.kind !== 'number')) return undefined;
    const value = items.map(item => item.number()) as [number, number, number, number];
    return value.every(Number.isFinite) && value[2] >= 0 && value[3] >= 0 ? value : undefined;
}

export interface BoardTurnInput {
    readonly quarters: readonly (0 | 1 | 2 | 3)[];
    host(record: ReadonlyMap<string, JsonSpan>, line: string): string;
}

export async function turnBoardText(text: string, input: BoardTurnInput, cooperate: () => Promise<void>): Promise<string> {
    const { header, records, footer } = lines(text);
    const header0 = JSON.parse(header + ']}') as { kind?: unknown };
    if (header0.kind !== 'pdf-ink') invalid();
    const parsed: Array<{ fields: ReadonlyMap<string, JsonSpan>; type: string }> = [];
    const sheets = new Set<string>(), nodes = new Map<string, NodeFacts>();
    let sizes: Array<[number, number]> | undefined;
    for (let i = 0; i < records.length; i++) {
        if (i % 512 === 511) await cooperate();
        const span = parseJson(records[i].text);
        if (span.kind !== 'object') invalid();
        const fields = span.fieldMap(), type = fields.get('type')?.string(64) ?? invalid();
        parsed.push({ fields, type });
        if (type === 'sheet') sheets.add(fields.get('id')?.string(256) ?? invalid());
        else if (type === 'node') {
            const id = fields.get('id')?.string(256) ?? invalid();
            nodes.set(id, { parent: fields.get('parent')?.string(256) ?? invalid(), page: fields.get('page')?.number() ?? -1 });
        } else if (type === 'host') {
            if (sizes) invalid();
            const pages = fields.get('pages');
            if (pages?.kind !== 'array') invalid();
            sizes = [...pages!.items()].map(entry => {
                const pair = [...entry.items()].map(item => item.number());
                if (pair.length !== 2 || !pair.every(value => Number.isFinite(value) && value > 0)) invalid();
                return pair as [number, number];
            });
        }
    }
    if (!sizes || sizes.length !== input.quarters.length) invalid();
    const pageSizes = sizes!;
    const rootPage = (id: string): number => {
        let current = nodes.get(id);
        for (let depth = 0; current && depth < 64; depth++) {
            if (sheets.has(current.parent)) {
                if (!Number.isSafeInteger(current.page) || current.page < 0) invalid();
                return Math.min(current.page, pageSizes.length - 1);
            }
            current = nodes.get(current.parent);
        }
        return invalid();
    };
    const out: string[] = [header];
    for (let i = 0; i < records.length; i++) {
        if (i % 512 === 511) await cooperate();
        const { fields, type } = parsed[i], line = records[i];
        let next = line.text;
        if (type === 'host') next = input.host(fields, line.text);
        else if (type === 'node') {
            const id = fields.get('id')!.string(256), page = rootPage(id), q = input.quarters[page];
            if (q) {
                if (!KNOWN_KINDS.has(fields.get('kind')?.string(256) ?? '')) throw new BoardTurnRefused('unknown-content');
                const [w, h] = pageSizes[page], edits: Array<{ start: number; end: number; text: string }> = [];
                const at = (name: string) => fields.get(name);
                if (sheets.has(nodes.get(id)!.parent)) {
                    const x = at('x'), y = at('y'), rot = at('rot');
                    if (x?.kind !== 'number' || y?.kind !== 'number' || (rot && rot.kind !== 'number')) invalid();
                    const [nx, ny] = turnPoint(q, x!.number(), y!.number(), w, h);
                    const angle = turnAngle(q, rot ? rot.number() : 0);
                    edits.push({ start: x!.start, end: x!.end, text: number(nx) }, { start: y!.start, end: y!.end, text: number(ny) });
                    if (rot) edits.push({ start: rot.start, end: rot.end, text: number(angle) });
                    else if (angle !== 0) edits.push({ start: y!.end, end: y!.end, text: `,"rot":${number(angle)}` });
                }
                const bounds = box(at('b'));
                if (bounds) edits.push({ start: at('b')!.start, end: at('b')!.end, text: `[${turnBox(q, bounds, w, h).map(number).join(',')}]` });
                next = splice(line.text, edits);
                if (parseJson(next).fieldMap().get('id')?.string(256) !== id) invalid();
            }
        }
        out.push(next + (line.comma ? ',' : ''));
    }
    out.push(footer);
    return out.join('\n') + (text.endsWith('\n') ? '\n' : '');
}
