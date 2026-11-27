import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from '../model/textLimits';
import { finishTextSteps, finishTextStepsCooperative } from './cooperative';

export interface PlainTextOptions {
    readonly signal?: AbortSignal;
    readonly cooperate: () => Promise<void>;
    readonly sliceMilliseconds?: number;
}

function* normalizeSteps(value: string): Generator<void, string> {
    if (value.length > MAX_TEXT_LENGTH * 2) throw new RangeError('Rich text exceeds limits');
    let blocks = 1, length = 0, last = 0, checkpoint = 4096;
    const pieces: string[] = [];
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code === 13) {
            pieces.push(value.slice(last, index), '\n');
            if (value.charCodeAt(index + 1) === 10) index++;
            last = index + 1;
            if (++blocks > MAX_TEXT_BLOCKS) throw new RangeError('Rich text exceeds limits');
            length++;
        } else if (code === 10) {
            if (++blocks > MAX_TEXT_BLOCKS) throw new RangeError('Rich text exceeds limits');
            length++;
        } else if (code < 32 && code !== 9) throw new RangeError('Text contains an unsupported control character');
        else if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) throw new RangeError('Text contains an unpaired surrogate');
            index++; length += 2;
        } else if (code >= 0xdc00 && code <= 0xdfff) throw new RangeError('Text contains an unpaired surrogate');
        else length++;
        if (length > MAX_TEXT_LENGTH) throw new RangeError('Rich text exceeds limits');
        if (index >= checkpoint) { checkpoint = index + 4096; yield; }
    }
    if (!pieces.length) return value;
    pieces.push(value.slice(last));
    return pieces.join('');
}

export function normalizePlainInsertion(value: string): string {
    return finishTextSteps(normalizeSteps(value));
}

export function normalizePlainInsertionCooperative(value: string, options: PlainTextOptions): Promise<string> {
    return finishTextStepsCooperative(normalizeSteps(value), options);
}
