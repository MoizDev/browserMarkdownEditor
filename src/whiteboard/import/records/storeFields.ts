// JSON has already passed JSON.parse. This walk retains repeated store keys that an object would erase.
function white(text: string, position: number): number {
    while (position < text.length && /[\x20\t\r\n]/.test(text[position])) position++;
    return position;
}
function stringEnd(text: string, start: number): number {
    let i = start + 1;
    while (i < text.length) {
        if (text[i] === '\\') i += 2;
        else if (text[i++] === '"') return i;
    }
    throw new Error('Unterminated JSON string');
}
function valueEnd(text: string, start: number): number {
    const first = text[start];
    if (first === '"') return stringEnd(text, start);
    if (first !== '{' && first !== '[') {
        let end = start;
        while (end < text.length && !/[,\]}\x20\t\r\n]/.test(text[end])) end++;
        return end;
    }
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') i = stringEnd(text, i) - 1;
        else if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') { if (--depth === 0) return i + 1; }
    }
    throw new Error('Unterminated JSON value');
}
interface FieldSpan { readonly key: string; readonly start: number; readonly end: number }
function* fields(text: string, start: number): Iterable<FieldSpan> {
    let i = white(text, start + 1);
    while (text[i] !== '}') {
        if (text[i] !== '"') throw new Error('Expected JSON object key');
        const end = stringEnd(text, i), key = JSON.parse(text.slice(i, end)) as string;
        i = white(text, end);
        if (text[i++] !== ':') throw new Error('Expected JSON colon');
        i = white(text, i);
        const valueStart = i, valueStop = valueEnd(text, i);
        yield { key, start: valueStart, end: valueStop };
        i = white(text, valueStop);
        if (text[i] === ',') i = white(text, i + 1);
        else if (text[i] !== '}') throw new Error('Expected JSON object separator');
    }
}
function uniqueField(text: string, start: number, name: string): FieldSpan | undefined {
    let found: FieldSpan | undefined;
    for (const field of fields(text, start)) if (field.key === name) {
        if (found) throw new Error(`Repeated ${name} envelope field`);
        found = field;
    }
    return found;
}
export function readStoreFields(text: string): readonly (readonly [string, unknown])[] | null {
    const start = white(text, text.charCodeAt(0) === 0xfeff ? 1 : 0);
    const document = uniqueField(text, start, 'document');
    if (!document || text[document.start] !== '{') return null;
    const store = uniqueField(text, document.start, 'store');
    if (!store || text[store.start] !== '{') return null;
    const out: (readonly [string, unknown])[] = [];
    for (const field of fields(text, store.start)) {
        if (out.length === 200_000) throw new Error('Drawing exceeds the record limit');
        out.push([field.key, JSON.parse(text.slice(field.start, field.end))]);
    }
    return out;
}
