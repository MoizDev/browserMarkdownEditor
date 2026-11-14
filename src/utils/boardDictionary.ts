import { readJSON, writeJSON } from './storage';

const KEY = 'bme.whiteboard.userDictionary';
const LIMIT = 10_000;
const WORD = /^[\p{L}\p{M}'’\-]+$/u;
const listeners = new Set<() => void>();
let snapshot: readonly string[] | null = null;
let listening = false;

export function isBoardDictionaryWord(word: string): boolean {
    return word.length > 0 && word.length <= 64 && WORD.test(word);
}

function read(): readonly string[] {
    const value = readJSON<unknown>(KEY, []);
    if (!Array.isArray(value)) return [];
    const result: string[] = [];
    const seen = new Set<string>();
    for (const word of value) {
        if (typeof word !== 'string' || !isBoardDictionaryWord(word) || seen.has(word)) continue;
        seen.add(word);
        result.push(word);
        if (result.length === LIMIT) break;
    }
    return result;
}

function publish(words: readonly string[]): void {
    snapshot = words;
    for (const listener of listeners) listener();
}

export function getBoardDictionary(): readonly string[] { return snapshot ??= read(); }
export function subscribeBoardDictionary(listener: () => void): () => void {
    listeners.add(listener);
    if (!listening && typeof window !== 'undefined') {
        listening = true;
        window.addEventListener('storage', event => {
            if (event.key === KEY || event.key === null) publish(read());
        });
    }
    return () => { listeners.delete(listener); };
}

export function addBoardDictionaryWord(word: string): 'added' | 'present' | 'invalid' | 'full' | 'failed' {
    if (!isBoardDictionaryWord(word)) return 'invalid';
    const words = getBoardDictionary();
    if (words.includes(word)) return 'present';
    if (words.length >= LIMIT) return 'full';
    const next = [...words, word];
    if (!writeJSON(KEY, next)) return 'failed';
    publish(next);
    return 'added';
}

export function removeBoardDictionaryWord(word: string): boolean {
    const words = getBoardDictionary();
    const next = words.filter(value => value !== word);
    if (next.length === words.length) return true;
    if (!writeJSON(KEY, next)) return false;
    publish(next);
    return true;
}
