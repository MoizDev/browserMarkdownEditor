export const USER_DICTIONARY_KEY = 'bme.whiteboard.userDictionary';
export const MAX_USER_WORDS = 10_000;
export const MAX_USER_WORD_LENGTH = 64;

export function validUserWord(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_USER_WORD_LENGTH && /^[\p{L}\p{M}'’\-]+$/u.test(value);
}

/** Storage is user-editable. Preserve spelling and order, discarding invalid and duplicate entries. */
export function normalizeUserDictionary(value: unknown): readonly string[] {
    if (!Array.isArray(value)) return [];
    const words: string[] = [], seen = new Set<string>();
    for (const item of value) {
        if (!validUserWord(item)) continue;
        const key = item.toLocaleLowerCase('en-US');
        if (seen.has(key)) continue;
        seen.add(key); words.push(item);
        if (words.length === MAX_USER_WORDS) break;
    }
    return words;
}

/** The registered app storage owns persistence and cross-window notifications. */
export interface UserDictionaryStorage {
    read(): unknown;
    write(words: readonly string[]): void;
    subscribe(listener: () => void): () => void;
}
export interface UserDictionary {
    words(): readonly string[];
    add(word: string): boolean;
    remove(word: string): boolean;
    subscribe(listener: () => void): () => void;
    dispose(): void;
}
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((word, index) => word === b[index]);

/** One source for the settings list and every open board; no spelling worker is loaded here. */
export function createUserDictionary(storage: UserDictionaryStorage): UserDictionary {
    let current = Object.freeze([...normalizeUserDictionary(storage.read())]) as readonly string[], disposed = false;
    const listeners = new Set<() => void>();
    const publish = (words: readonly string[]) => {
        if (disposed || same(current, words)) return;
        current = Object.freeze([...words]);
        for (const listener of [...listeners]) listener();
    };
    const refresh = () => { if (!disposed) publish(normalizeUserDictionary(storage.read())); };
    const unsubscribe = storage.subscribe(refresh);
    const update = (word: string, add: boolean): boolean => {
        if (disposed || !validUserWord(word)) return false;
        const before = normalizeUserDictionary(storage.read()), key = word.toLocaleLowerCase('en-US');
        const index = before.findIndex(item => item.toLocaleLowerCase('en-US') === key);
        if (add ? index >= 0 || before.length >= MAX_USER_WORDS : index < 0) { publish(before); return false; }
        const next = add ? [...before, word] : before.filter((_, position) => position !== index);
        storage.write(next);
        // A storage adapter may synchronously notify or normalize its own write.
        const after = normalizeUserDictionary(storage.read());
        publish(after);
        const exists = after.some(item => item.toLocaleLowerCase('en-US') === key);
        return add ? exists : !exists;
    };
    return {
        words: () => current,
        add: word => update(word, true),
        remove: word => update(word, false),
        subscribe(listener) { if (disposed) throw new Error('Board dictionary is closed'); listeners.add(listener); return () => { listeners.delete(listener); }; },
        dispose() { if (!disposed) { disposed = true; listeners.clear(); unsubscribe(); } },
    };
}
