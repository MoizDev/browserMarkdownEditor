declare module 'nspell' {
    interface SpellChecker {
        correct(word: string): boolean;
        suggest(word: string): string[];
        add(word: string): void;
    }
    export default function nspell(aff: string, dic: string): SpellChecker;
}
