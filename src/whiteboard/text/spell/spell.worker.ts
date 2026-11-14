import nspell from 'nspell';
import { serve } from '../../../platform/workers';
import type { WorkerContext } from '../../../platform/workers';
import { normalizeUserDictionary } from './dictionary';
import { spellWords } from './words';

let checker: ReturnType<typeof nspell> | null = null;
let aff = '', dic = '', dictionarySerial = 0;

function object(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function current(context: WorkerContext): void {
    context.signal.throwIfAborted();
    if (context.cancelled) throw new DOMException('Spelling check cancelled', 'AbortError');
}
function initialized(): ReturnType<typeof nspell> {
    if (!checker) throw new Error('Spell checker is not initialized');
    return checker;
}
async function addCustom(next: ReturnType<typeof nspell>, words: unknown, serial: number, context: WorkerContext): Promise<boolean> {
    let count = 0;
    for (const word of normalizeUserDictionary(words)) {
        current(context);
        if (serial !== dictionarySerial) return false;
        next.add(word);
        if (++count % 128 === 0) await context.slice();
    }
    current(context);
    return serial === dictionarySerial;
}
async function checkText(text: string, active: ReturnType<typeof nspell>, context: WorkerContext): Promise<Uint32Array> {
    const result: number[] = [];
    for (let start = 0; start < text.length;) {
        current(context);
        let end = Math.min(text.length, start + 16_384), scanned = 0;
        // A word may cross the nominal slice boundary. Do not change tokenization just to yield.
        while (end < text.length && !/\s/u.test(text[end - 1]) && !/\s/u.test(text[end])) {
            end++;
            if (++scanned % 4096 === 0) await context.slice();
        }
        let count = 0;
        for (const word of spellWords(text.slice(start, end))) {
            current(context);
            if (!active.correct(word.text)) result.push(start + word.from, start + word.to);
            if (++count % 256 === 0) await context.slice();
        }
        start = end;
        await context.slice();
    }
    current(context);
    return Uint32Array.from(result);
}

serve({
    protocol: 1,
    buildId: 'whiteboard-spell-2',
    handlers: {
        ready: () => null,
        init: async (args, context) => {
            if (!object(args) || typeof args.aff !== 'string' || typeof args.dic !== 'string'
                || args.aff.length > 1_000_000 || args.dic.length > 4_000_000 || !Array.isArray(args.custom))
                throw new TypeError('Invalid spelling dictionary');
            current(context);
            const nextAff = args.aff, nextDic = args.dic, serial = ++dictionarySerial, next = nspell(nextAff, nextDic);
            if (!await addCustom(next, args.custom, serial, context)) return null;
            aff = nextAff; dic = nextDic; checker = next;
            return null;
        },
        dictionary: async (args, context) => {
            if (!object(args) || !Array.isArray(args.words)) throw new TypeError('Invalid personal dictionary');
            initialized(); current(context);
            const serial = ++dictionarySerial, next = nspell(aff, dic);
            if (!await addCustom(next, args.words, serial, context)) return null;
            checker = next;
            return null;
        },
        check: async (args, context) => {
            if (!object(args) || typeof args.text !== 'string') throw new TypeError('Invalid spelling text');
            const value = await checkText(args.text, initialized(), context);
            if (value.buffer instanceof ArrayBuffer) context.transfer(value.buffer);
            return value;
        },
        suggest: (args, context) => {
            if (!object(args) || typeof args.word !== 'string' || args.word.length > 64) throw new TypeError('Invalid spelling word');
            current(context);
            const result = initialized().suggest(args.word).slice(0, 5);
            current(context);
            return result;
        },
    },
});
