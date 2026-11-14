import nspell from 'nspell';
import { spellWords } from './words';

type Request =
    | { id: number; kind: 'init'; aff: string; dic: string; custom: readonly string[] }
    | { id: number; kind: 'check'; text: string }
    | { id: number; kind: 'suggest'; word: string }
    | { id: number; kind: 'dictionary'; words: readonly string[] };
let checker: ReturnType<typeof nspell> | null = null;
let aff = '', dic = '';
self.addEventListener('message', (event: MessageEvent<Request>) => {
    const request = event.data;
    try {
        if (request.kind === 'init') {
            aff = request.aff; dic = request.dic;
            checker = nspell(aff, dic);
            for (const word of request.custom) checker.add(word);
            self.postMessage({ id: request.id, value: null });
        } else if (request.kind === 'dictionary') {
            if (!checker) throw new Error('Spell checker is not initialized');
            checker = nspell(aff, dic);
            for (const word of request.words) checker.add(word);
            self.postMessage({ id: request.id, value: null });
        } else if (request.kind === 'check') {
            if (!checker) throw new Error('Spell checker is not initialized');
            const active = checker;
            const value = spellWords(request.text).filter(word => !active.correct(word.text))
                .map(word => ({ from: word.from, to: word.to, word: word.text }));
            self.postMessage({ id: request.id, value });
        } else {
            if (!checker) throw new Error('Spell checker is not initialized');
            self.postMessage({ id: request.id, value: checker.suggest(request.word).slice(0, 5) });
        }
    } catch (error) {
        self.postMessage({ id: request.id, error: error instanceof Error ? error.message : 'Spelling worker failed' });
    }
});
