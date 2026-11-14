import { parseJson } from '../../whiteboard/format/jsonRead';
import type { JsonSpan } from '../../whiteboard/format/jsonRead';
import type { RawJson } from '../../whiteboard/model/json';

const HASH = /^[0-9a-f]{64}$/, WRITE_ID = /^[0-9a-f]{32}$/;
const bad = (): never => { throw new Error('Unknown PDF host metadata'); };

function* unique(span: JsonSpan, work: { count: number }): Generator<null> {
    if (++work.count % 128 === 0) yield null;
    if (span.kind === 'object') {
        const keys = new Set<string>();
        for (const [key, value] of span.fields()) {
            if (keys.has(key)) bad();
            keys.add(key);
            yield* unique(value, work);
        }
    } else if (span.kind === 'array') for (const value of span.items()) yield* unique(value, work);
}
type UnknownField = readonly [string, JsonSpan];
function object(span: JsonSpan, required: readonly string[], known: readonly string[], unknown: UnknownField[]): ReadonlyMap<string, JsonSpan> {
    const fields = span.fieldMap();
    for (const key of required) if (!fields.has(key)) bad();
    for (const [key, value] of fields) if (!known.includes(key)) {
        unknown.push([key, value]);
    }
    return fields;
}
function* list(span: JsonSpan, max: number): Generator<null, JsonSpan[]> {
    if (span.kind !== 'array') return bad();
    const values: JsonSpan[] = [];
    for (const value of span.items()) {
        if (values.length >= max) return bad();
        values.push(value);
        if (values.length % 128 === 0) yield null;
    }
    return values;
}
function positive(span: JsonSpan, max = Infinity): number {
    const value = span.number();
    if (!Number.isFinite(value) || value <= 0 || value > max) return bad();
    return value;
}

/** Only a completely recognized host can exclude PDF bookkeeping from media discovery. */
export function* pdfHostMediaRawValues(raw: RawJson): Iterable<RawJson | null> {
    let unknown: UnknownField[];
    try {
        const root = parseJson(raw);
        yield* unique(root, { count: 0 });
        unknown = [];
        const f = object(root, ['schema', 'sourceFingerprint', 'geometryEngine', 'pages', 'writeId'],
            ['schema', 'sourceFingerprint', 'geometryEngine', 'pages', 'writeId', 'migration', 'preview'], unknown);
        if (f.get('schema')!.number() !== 1 || !HASH.test(f.get('sourceFingerprint')!.string(64)) ||
            !WRITE_ID.test(f.get('writeId')!.string(32))) return yield raw;
        if (f.has('preview') && f.get('preview')!.value() !== true) return yield raw;
        const engine = object(f.get('geometryEngine')!, ['id', 'build', 'generation'], ['id', 'build', 'generation'], unknown);
        const generation = engine.get('generation')!.number();
        if (!engine.get('id')!.string(128) || !engine.get('build')!.string(256) || !Number.isSafeInteger(generation) || generation < 0) return yield raw;
        const pages = yield* list(f.get('pages')!, 65_536);
        if (!pages.length) return yield raw;
        const sizes: Array<{ width: number; height: number }> = [];
        for (let index = 0; index < pages.length; index++) {
            if (index % 128 === 0) yield null;
            const page = pages[index];
            const p = object(page, ['index', 'width', 'height', 'rotate', 'userUnit', 'toUserSpace'],
                ['index', 'width', 'height', 'rotate', 'userUnit', 'toUserSpace'], unknown);
            const width = positive(p.get('width')!, 14_400), height = positive(p.get('height')!, 14_400);
            const rotation = p.get('rotate')!.number();
            if (p.get('index')!.number() !== index || ![0, 90, 180, 270].includes(rotation)) bad();
            positive(p.get('userUnit')!);
            const matrix = (yield* list(p.get('toUserSpace')!, 6)).map(value => value.number());
            if (matrix.length !== 6 || matrix.some(value => !Number.isFinite(value)) ||
                !Number.isFinite(matrix[0] * matrix[3] - matrix[1] * matrix[2]) || matrix[0] * matrix[3] - matrix[1] * matrix[2] === 0) bad();
            sizes.push({ width, height });
        }
        if (f.has('migration')) {
            const m = object(f.get('migration')!, ['version', 'legacyOuterFingerprint', 'previousFrames'],
                ['version', 'legacyOuterFingerprint', 'previousFrames'], unknown);
            if (m.get('version')!.number() !== 1 || !HASH.test(m.get('legacyOuterFingerprint')!.string(64))) bad();
            const frames = yield* list(m.get('previousFrames')!, 65_536);
            if (frames.length !== sizes.length) bad();
            for (let index = 0; index < frames.length; index++) {
                if (index % 128 === 0) yield null;
                const fields = object(frames[index], ['width', 'height'], ['width', 'height'], unknown);
                const width = positive(fields.get('width')!), height = positive(fields.get('height')!);
                const ratio = (width / height) / (sizes[index].width / sizes[index].height);
                if (!Number.isFinite(ratio) || Math.abs(ratio - 1) > 0.005) bad();
            }
        }
    } catch { yield raw; return; }
    for (const [key, value] of unknown) {
        yield parseJson(JSON.stringify(key)).raw();
        yield value.raw();
    }
}
