import nspell from 'nspell';
import { spellWords } from './words';

type Request =
    | { id: number; kind: 'init'; aff: string; dic: string; custom: readonly string[] }
    | { id: number; kind: 'check'; text: string }
    | { id: number; kind: 'suggest'; word: string }
    | { id: number; kind: 'dictionary'; words: readonly string[] }
    | { id: number; kind: 'cancel' };
let checker: ReturnType<typeof nspell> | null = null;
let aff = '', dic = '', checkSerial = 0;
async function checkText(text: string, active: ReturnType<typeof nspell>, serial: number) {
    const result: number[] = [];
    for (let start = 0; start < text.length;) {
        let end = Math.min(text.length, start + 16_384);
        while (end < text.length && !/\s/u.test(text[end - 1]) && !/\s/u.test(text[end])) end++;
        for (const word of spellWords(text.slice(start, end))) if (!active.correct(word.text))
            result.push(start + word.from, start + word.to);
        start = end;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (serial !== checkSerial) throw new DOMException('Spelling check superseded', 'AbortError');
    }
    return Uint32Array.from(result);
}
self.addEventListener('message', async (event: MessageEvent<Request>) => {
    const request = event.data;
    try {
        if (request.kind === 'cancel') {
            checkSerial++;
        } else if (request.kind === 'init') {
            checkSerial++;
            aff = request.aff; dic = request.dic;
            checker = nspell(aff, dic);
            for (const word of request.custom) checker.add(word);
            self.postMessage({ id: request.id, value: null });
        } else if (request.kind === 'dictionary') {
            checkSerial++;
            if (!checker) throw new Error('Spell checker is not initialized');
            checker = nspell(aff, dic);
            for (const word of request.words) checker.add(word);
            self.postMessage({ id: request.id, value: null });
        } else if (request.kind === 'check') {
            if (!checker) throw new Error('Spell checker is not initialized');
            const value = await checkText(request.text, checker, ++checkSerial);
            self.postMessage({ id: request.id, value });
        } else {
            if (!checker) throw new Error('Spell checker is not initialized');
            self.postMessage({ id: request.id, value: checker.suggest(request.word).slice(0, 5) });
        }
    } catch (error) {
        self.postMessage({ id: request.id, error: error instanceof Error ? error.message : 'Spelling worker failed' });
    }
});
