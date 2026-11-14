import { normalizePaper } from '../../utils/paper';
import type { HostBlock, PreservedBlock, Sheet, ViewFlags } from '../model/doc';
import { UI_DEFAULTS, VIEW_DEFAULTS } from '../model/defaults';
import type { NodeId } from '../model/ids';
import type { ExtBag, RawJson } from '../model/json';
import type { MediaEntry, MediaId } from '../model/media';
import type { NodeRecord } from '../model/nodes';
import { scanRawMedia, visitExtRaw, visitHostRaw, visitNodeRaw, visitPreservedRaw } from '../model/rawMedia';
import type { UiBlock } from '../model/styles';
import type { SavedView } from './encode';
import { hasNativeMarker, hasNativeMarkerIncremental, JsonReadError, parseJson, parseJsonIncremental } from './jsonRead';
import type { JsonSpan } from './jsonRead';
import { readHeader, readRecord } from './readModel';
import type { MappedRecord } from './readModel';
import type { ByteSource, NativeReadResult, ReadDraft, ReadIssue, ReadOptions, ReadPosition, ReadSourceRecord, UnmappedRecord } from './readTypes';
import { FORMAT_LIMITS, NATIVE_VERSION } from './schema';
import type { Bounds } from './schema';

const DIAGNOSTICS = 128;
const CHUNK_BYTES = 64 * 1024;
const EMPTY_RAW = parseJson('{}').raw();
const white = (text: string): string => text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, '');
class ReadFailure extends Error {
    constructor(readonly code: 'limit' | 'io', message: string) { super(message); }
}
class AdmissionFailure extends Error { }
interface StreamState {
    bytesRead: number;
    whitespaceOnly: boolean;
    fallback: Uint8Array[] | null;
    fallbackBytes: number;
    probe: Uint8Array;
    probeBytes: number;
}
interface Line {
    readonly text: string | null;
    readonly line: number;
    readonly byteOffset: number;
    readonly byteLength: number;
    readonly error?: string;
}
async function* chunks(source: ByteSource): AsyncIterable<Uint8Array> {
    try {
        if (source instanceof Uint8Array) yield source;
        else yield* source;
    } catch { throw new ReadFailure('io', 'Byte source failed while opening the board'); }
}
function decode(parts: readonly Uint8Array[]): string {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const text: string[] = [];
    for (const part of parts) text.push(decoder.decode(part, { stream: true }));
    text.push(decoder.decode());
    return text.join('');
}
async function* lines(source: ByteSource, state: StreamState, options: ReadOptions): AsyncIterable<Line> {
    let parts: Uint8Array[] = [], length = 0, offset = 0, line = 1, oversized = false;
    function add(part: Uint8Array): void {
        length += part.byteLength;
        if (length > FORMAT_LIMITS.recordBytes) { oversized = true; parts = []; }
        // Borrowed async input buffers may be reused as soon as iteration resumes.
        else if (!oversized && part.length) parts.push(part.slice());
    }
    function take(): Line {
        let text: string | null = null, error: string | undefined;
        if (oversized) error = 'Physical line exceeds 64 MiB';
        else {
            try { text = decode(parts); }
            catch (cause) {
                if (!(cause instanceof TypeError)) throw cause;
                error = 'Invalid UTF-8 in native input';
            }
        }
        parts = []; // Release byte copies before the caller validates/admits a large stroke.
        const value = { text, line, byteOffset: offset, byteLength: length, error };
        offset += length + 1;
        line++;
        length = 0;
        oversized = false;
        return value;
    }
    for await (const input of chunks(source)) {
        if (options.signal?.aborted) throw new ReadFailure('io', 'Opening the board was cancelled');
        if (!(input instanceof Uint8Array)) throw new ReadFailure('io', 'Byte source yielded a non-byte chunk');
        if (input.byteLength > FORMAT_LIMITS.fileBytes - state.bytesRead) throw new ReadFailure('limit', 'Native file exceeds 1 GiB');
        state.bytesRead += input.byteLength;
        for (let at = 0; at < input.length; at += CHUNK_BYTES) {
            const part = input.subarray(at, Math.min(input.length, at + CHUNK_BYTES));
            const probeLength = Math.min(state.probe.length - state.probeBytes, part.length);
            if (probeLength) { state.probe.set(part.subarray(0, probeLength), state.probeBytes); state.probeBytes += probeLength; }
            if (state.fallback !== null) {
                state.fallbackBytes += part.length;
                if (state.fallbackBytes > FORMAT_LIMITS.recordBytes) state.fallback = null;
                else state.fallback.push(part.slice());
            }
            let start = 0;
            for (let i = 0; i < part.length; i++) {
                const byte = part[i];
                if (byte !== 32 && byte !== 9 && byte !== 10 && byte !== 13) state.whitespaceOnly = false;
                if (byte !== 10) continue;
                add(part.subarray(start, i));
                yield take();
                start = i + 1;
            }
            add(part.subarray(start));
            if (options.cooperate) await options.cooperate();
        }
    }
    if (length) yield take();
}
function byteUnits(text: string, start: number, end: number): number {
    let bytes = 0;
    for (let i = start; i < end; i++) {
        const code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) { i++; bytes += 4; }
        else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    }
    return bytes;
}
function retainedMedia(draft: Pick<ReadDraft, 'input'>): ReadonlyMap<MediaId, number> {
    const counts = new Map<MediaId, number>();
    const count = (id: MediaId) => { counts.set(id, (counts.get(id) ?? 0) + 1); };
    const scan = (raw: RawJson) => scanRawMedia(raw, count);
    const input = draft.input;
    for (const node of input.nodes ?? []) visitNodeRaw(node, scan);
    visitExtRaw(input.ui.ext, scan);
    visitExtRaw(input.view.ext, scan);
    for (const sheet of input.sheets) visitExtRaw(sheet.ext, scan);
    for (const entry of input.media ?? []) {
        // R-W40: its own metadata cannot keep a now-unreferenced media entry alive.
        visitExtRaw(entry.ext, raw => scanRawMedia(raw, id => { if (id !== entry.id) count(id); }));
    }
    visitHostRaw(input.host, scan);
    visitPreservedRaw(input.preserved, scan);
    return counts;
}

class Records {
    header: ReturnType<typeof readHeader> | null = null;
    readonly issues: ReadIssue[] = [];
    issueCount = 0;
    readOnly = false;
    recordsSeen = 0;
    recordsRecovered = 0;
    endSeen = false;
    countValid = false;
    readonly sources: ReadSourceRecord[] = [];
    readonly unmapped: UnmappedRecord[] = [];
    private readonly sheets: Sheet[] = [];
    private readonly nodes: NodeRecord[] = [];
    private readonly media: MediaEntry[] = [];
    private readonly preserved: PreservedBlock['records'][number][] = [];
    private readonly coldBounds = new Map<NodeId, Bounds>();
    private readonly singletons = new Set<string>();
    private ui: UiBlock = UI_DEFAULTS;
    private view: ViewFlags = VIEW_DEFAULTS;
    private savedView?: SavedView;
    private host: HostBlock | null = null;
    private end: ExtBag | null = null;
    constructor(readonly options: ReadOptions) { }
    issue = (issue: ReadIssue): void => {
        this.issueCount++;
        this.readOnly ||= issue.readOnly;
        if (this.issues.length < DIAGNOSTICS) this.issues.push(issue);
    };
    problem(code: ReadIssue['code'], reason: string, position?: ReadPosition): void {
        this.issue({ code, reason, readOnly: true, ...(position ? { position } : {}) });
    }
    open(root: JsonSpan): void {
        try {
            this.header = readHeader(root);
            if (!this.header.fenceValid) this.problem('fence', 'The compatibility guard is missing or contains data; retain the original file read-only');
            if (this.header.version[0] !== NATIVE_VERSION[0]) this.problem('version', 'This native major version is not editable by this build');
            if (this.options.expectedKind && this.header.kind !== this.options.expectedKind) this.problem('kind', 'Native content kind disagrees with its host; it is not legacy content');
        } catch (error) {
            if (!(error instanceof JsonReadError)) throw error;
            this.problem(error.code === 'limit' ? 'limit' : 'header', error.message);
        }
    }
    async record(root: JsonSpan, position: ReadPosition, reformatted: boolean): Promise<void> {
        if (this.recordsSeen >= FORMAT_LIMITS.records) throw new ReadFailure('limit', 'Native input exceeds five million records');
        this.recordsSeen++;
        if (this.endSeen) this.problem('syntax', 'The end record is not last', position);
        if (!this.header) {
            this.unmapped.push({ raw: root.raw(), position, reason: 'The header could not be admitted' });
            return;
        }
        try {
            const mapped = await readRecord(root, this.header.kind, { options: this.options, issue: this.issue, position });
            this.keep(mapped, position, reformatted);
        } catch (error) {
            if (!(error instanceof JsonReadError)) throw error;
            this.problem(error.code, error.message, position);
            this.unmapped.push({ raw: root.raw(), position, reason: error.message });
        }
    }
    private keep(record: MappedRecord, position: ReadPosition, reformatted: boolean): void {
        const category = record.category;
        if (['pen', 'view', 'paper', 'host', 'end'].includes(category)) {
            if (this.singletons.has(category)) throw new JsonReadError('syntax', `Duplicate ${category} record cannot be discarded`, 0);
            this.singletons.add(category);
        }
        let id: string | undefined, type: string = category;
        switch (record.category) {
            case 'node':
                this.nodes.push(record.value); id = record.value.id;
                if (record.bounds && !this.coldBounds.has(record.value.id)) this.coldBounds.set(record.value.id, record.bounds);
                break;
            case 'sheet':
                if (this.sheets.length >= FORMAT_LIMITS.sheets) throw new JsonReadError('limit', 'Native input exceeds one thousand sheets', 0);
                this.sheets.push(record.value); id = record.value.id; break;
            case 'media': this.media.push(record.value); id = record.value.id; break;
            case 'pen': this.ui = record.value; break;
            case 'view': this.view = record.value; this.savedView = record.savedView; break;
            case 'paper': case 'host': this.host = record.value; break;
            case 'opaque':
                this.preserved.push({ type: record.type, id: record.id, raw: record.value });
                type = record.type; id = record.id; break;
            case 'end':
                this.endSeen = true; this.end = record.value;
                this.countValid = record.count === position.ordinal;
                if (!this.countValid) this.problem('syntax', 'End count does not match the number of preceding records', position);
                break;
        }
        this.recordsRecovered++;
        this.sources.push({
            category, type, ...(id === undefined ? {} : { id }), position,
            ...(record.category === 'node' && record.bounds ? { nodeBounds: record.bounds } : {}), reencode: record.reencode || reformatted
        });
    }
    finish(closed: boolean): ReadDraft | null {
        if (!closed) this.problem('syntax', 'Native envelope is incomplete; recovered content is read-only');
        if (!this.endSeen) this.problem('syntax', 'Native input is missing its final end record');
        if (!this.header) return null;
        const kind = this.header.kind;
        let host = this.host;
        if (!host) {
            if (kind === 'whiteboard') host = { kind };
            else if (kind === 'notebook') host = { kind, paper: normalizePaper(undefined), ext: null };
            else {
                const pages = this.options.pdfPages ?? [];
                if (!pages.length || pages.length > FORMAT_LIMITS.pdfPages || pages.some(page => page.length !== 2
                    || page.some(value => !Number.isFinite(value) || value <= 0 || value > FORMAT_LIMITS.pdfPageSize))) {
                    this.problem('header', 'PDF host geometry is unavailable or invalid; the host must supply PageGeometry');
                    host = { kind, pdf: EMPTY_RAW, pages: [], ext: null };
                } else host = { kind, pdf: EMPTY_RAW, pages, ext: null };
            }
        }
        const preserved: PreservedBlock = { version: this.header.version, fields: this.header.fields, records: this.preserved, end: this.end };
        const input = {
            kind, sheets: this.sheets, nodes: this.nodes, media: this.media, ui: this.ui, view: this.view, host, preserved,
            preservedMediaRefs: new Map<MediaId, number>()
        };
        const draft: ReadDraft = {
            input, sources: this.sources, unmapped: this.unmapped, coldBounds: this.coldBounds,
            ...(this.savedView ? { savedView: this.savedView } : {})
        };
        input.preservedMediaRefs = new Map(retainedMedia(draft));
        return draft;
    }
}

function recordType(root: JsonSpan): string | null {
    if (root.kind !== 'object') return null;
    for (const [key, value] of root.fields()) if (key === 'type') return value.kind === 'string' ? value.string(128) : null;
    return null;
}
async function headerLine(text: string, cooperate?: () => Promise<void>): Promise<JsonSpan | null> {
    if (!text.endsWith('[')) return null;
    try {
        const root = cooperate ? await parseJsonIncremental(text + ']}', cooperate) : parseJson(text + ']}');
        let last: readonly [string, JsonSpan] | undefined;
        for (const field of root.fields()) last = field;
        return last?.[0] === 'records' && last[1].kind === 'array' ? root : null;
    } catch (error) { if (!(error instanceof JsonReadError)) throw error; return null; }
}

/** Pure native admission. The host retains its original File/bytes whenever readOnly is true,
 * and owns every sample lease until transferring the repaired draft into a document or releasing it.
 * Filename/kind never authorizes a legacy fallback after a native format marker was recognized. */
export async function readNative(source: ByteSource, options: ReadOptions): Promise<NativeReadResult> {
    const state: StreamState = {
        bytesRead: 0, whitespaceOnly: true, fallback: [], fallbackBytes: 0,
        probe: new Uint8Array(CHUNK_BYTES), probeBytes: 0
    };
    const safeOptions: ReadOptions = {
        ...options, admitEncoded: (pts, header) => {
            try {
                const ref = options.admitEncoded(pts, header);
                if (!Number.isSafeInteger(ref) || ref < 0) throw new Error('Invalid sample reference');
                return ref;
            } catch { throw new AdmissionFailure('Stroke backing could not be admitted; keep the original file read-only'); }
        }
    };
    let records = new Records(safeOptions);
    let native = false, streaming = false, recordLines = false, closed = false, arrayClosed = false;
    let first = true, rootLine = true, lastComma = false, haveRecord = false, reformatted = false, ioComplete = false;
    let fatal = false;
    const result = (format: NativeReadResult['format'], draft: ReadDraft | null, complete: boolean): NativeReadResult => ({
        format, draft, complete, reformatted, readOnly: records.readOnly || format === 'other', issues: records.issues,
        issueCount: records.issueCount, recordsSeen: records.recordsSeen, recordsRecovered: records.recordsRecovered, bytesRead: state.bytesRead,
    });
    try {
        if (options.byteLength !== undefined && (!Number.isSafeInteger(options.byteLength) || options.byteLength < 0)) throw new ReadFailure('io', 'Invalid source byte-length fact');
        if ((options.byteLength ?? 0) > FORMAT_LIMITS.fileBytes) throw new ReadFailure('limit', 'Native file exceeds 1 GiB');
        for await (const line of lines(source, state, options)) {
            if (options.signal?.aborted) throw new ReadFailure('io', 'Opening the board was cancelled');
            if (line.text === null) {
                if (streaming) {
                    if (records.recordsSeen >= FORMAT_LIMITS.records) throw new ReadFailure('limit', 'Native input exceeds five million records');
                    const position = { ordinal: records.recordsSeen, line: line.line, byteOffset: line.byteOffset, byteLength: line.byteLength };
                    records.recordsSeen++;
                    records.problem(line.byteLength > FORMAT_LIMITS.recordBytes ? 'limit' : 'syntax', line.error!, position);
                }
                continue;
            }
            let text = white(line.text);
            if (first) {
                first = false;
                if (text.startsWith('\ufeff')) { text = white(text.slice(1)); reformatted = true; }
            }
            if (!text) continue;
            if (!streaming) {
                // Only the root's first nonempty line can open the line-oriented grammar. Never
                // mistake a compact nested object in a pretty legacy snapshot for an envelope.
                if (rootLine) {
                    rootLine = false;
                    native ||= options.cooperate ? await hasNativeMarkerIncremental(text, options.cooperate) : hasNativeMarker(text);
                    const header = await headerLine(text, options.cooperate);
                    if (header && (options.cooperate ? await hasNativeMarkerIncremental(header.source, options.cooperate) : hasNativeMarker(header.source))) {
                        native = true; streaming = true; records.open(header);
                    }
                }
                continue;
            }
            if (closed) { records.problem('syntax', 'Unexpected content after native envelope'); continue; }
            if (text === ']}' || (!arrayClosed && text === ']') || (arrayClosed && text === '}')) {
                if (lastComma) records.problem('syntax', 'Trailing comma after the final record');
                arrayClosed = true;
                if (text !== ']') closed = true;
                continue;
            }
            if (arrayClosed) { records.problem('syntax', 'Unexpected content after records array'); continue; }
            if (records.recordsSeen >= FORMAT_LIMITS.records) throw new ReadFailure('limit', 'Native input exceeds five million records');
            const comma = text.endsWith(',');
            const body = comma ? white(text.slice(0, -1)) : text;
            const position: ReadPosition = { ordinal: records.recordsSeen, line: line.line, byteOffset: line.byteOffset, byteLength: line.byteLength };
            if (haveRecord && !lastComma) records.problem('syntax', 'Missing comma between native records', position);
            haveRecord = true; lastComma = comma;
            let root: JsonSpan;
            try {
                root = options.cooperate ? await parseJsonIncremental(body, options.cooperate) : parseJson(body);
                if (recordType(root) !== null) { recordLines = true; state.fallback = null; }
            } catch (error) {
                if (!(error instanceof JsonReadError)) throw error;
                records.recordsSeen++;
                records.problem(error.code, error.message, position);
                continue;
            }
            await records.record(root, position, reformatted);
            if (options.cooperate) await options.cooperate();
        }
        ioComplete = true;
        if (options.byteLength !== undefined && options.byteLength !== state.bytesRead) throw new ReadFailure('io', 'Source length changed while opening the board');
    } catch (error) {
        fatal = true;
        if (error instanceof AdmissionFailure) records.problem('model', error.message);
        else if (error instanceof ReadFailure) records.problem(error.code, error.message);
        else if (error instanceof RangeError) records.problem('limit', 'Native input could not be allocated within available memory');
        else throw error;
    }
    if (!native && state.probeBytes) {
        // A prefix may end inside a multi-byte character. This probe only recognizes the marker;
        // full line/fallback decoding is fatal and remains the authority for UTF-8 admission.
        const probe = new TextDecoder().decode(state.probe.subarray(0, state.probeBytes));
        native = options.cooperate ? await hasNativeMarkerIncremental(probe, options.cooperate) : hasNativeMarker(probe);
    }
    state.probe = new Uint8Array(0);
    if (!fatal && state.whitespaceOnly) return result('empty', null, true);
    if (!fatal && !recordLines && state.fallback !== null) {
        // Only the no-record-lines case can use whole-envelope parsing. Lexical spans, not
        // JSON.parse(envelope), keep block/point limits ahead of materializing their arrays.
        try {
            let text = decode(state.fallback);
            state.fallback = null;
            const bomBytes = text.startsWith('\ufeff') ? 3 : 0;
            if (bomBytes) { text = text.slice(1); reformatted = true; }
            if (!white(text)) return result('empty', null, true);
            const marked = options.cooperate ? await hasNativeMarkerIncremental(text, options.cooperate) : hasNativeMarker(text);
            native ||= marked;
            const root = options.cooperate ? await parseJsonIncremental(text, options.cooperate) : parseJson(text);
            if (!marked) return result('other', null, true);
            native = true;
            records = new Records(safeOptions); // Failed line guesses admitted no samples.
            records.open(root);
            const array = root.fieldMap().get('records');
            if (!array || array.kind !== 'array') throw new JsonReadError('syntax', 'Native records must be an array', root.start);
            array.length(FORMAT_LIMITS.records);
            reformatted = true;
            let cursor = 0, line = 1, offset = 0;
            for (const item of array.items()) {
                if (options.signal?.aborted) throw new ReadFailure('io', 'Opening the board was cancelled');
                offset += byteUnits(text, cursor, item.start);
                for (let i = cursor; i < item.start; i++) if (text.charCodeAt(i) === 10) line++;
                const length = byteUnits(text, item.start, item.end);
                const position = { ordinal: records.recordsSeen, line, byteOffset: offset + bomBytes, byteLength: length };
                await records.record(item, position, true);
                if (options.cooperate) await options.cooperate();
                // Advance only to the start: the next span's prefix includes this record once.
                cursor = item.start;
            }
            closed = true;
        } catch (error) {
            if (error instanceof JsonReadError) records.problem(error.code, error.message);
            else if (error instanceof AdmissionFailure) records.problem('model', error.message);
            else if (error instanceof ReadFailure) records.problem(error.code, error.message);
            else if (error instanceof RangeError) records.problem('limit', 'Reformatted native input could not be allocated');
            else if (error instanceof TypeError) records.problem('syntax', 'Reformatted native input contains invalid UTF-8');
            else throw error;
        }
    } else if (!fatal && !recordLines && state.fallback === null && !streaming) {
        records.problem('limit', 'Reformatted input exceeds the 64 MiB fallback limit');
    }
    state.fallback = null;
    if (!native) return result('other', null, ioComplete);
    const draft = records.finish(closed && ioComplete);
    return result('native', draft, closed && ioComplete && records.endSeen && records.countValid);
}
