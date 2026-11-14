export interface SpellWord { readonly from: number; readonly to: number; readonly text: string }

const segments = new Intl.Segmenter(undefined, { granularity: 'word' });
const latinLetters = /^(?:\p{Script=Latin}|\p{M}|['’])+$/u;
const letter = /\p{L}/u;
const upper = /\p{Lu}/u;
const lower = /\p{Ll}/u;
const bareDomain = /^(?:https?:\/\/|mailto:|(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?:[^\p{L}\p{N}-]|$))/iu;

// COV-34: URLs, addresses and paths are skipped before word segmentation;
// otherwise their fragments would be offered as spelling corrections.
export function spellWords(text: string): SpellWord[] {
    const words: SpellWord[] = [];
    for (const run of text.matchAll(/\S+/gu)) {
        const value = run[0];
        if (value.includes('://') || value.includes('@') || value.includes('/') || value.includes('\\') || value.startsWith('~') || bareDomain.test(value.replace(/^[([{“‘"']+/u, ''))) continue;
        for (const part of segments.segment(value)) {
            if (!part.isWordLike) continue;
            const word = part.segment;
            if (!latinLetters.test(word) || !letter.test(word)) continue;
            const letters = Array.from(word).filter(char => letter.test(char));
            if (letters.slice(1).some(char => upper.test(char)) || (letters.length >= 2 && letters.every(char => upper.test(char) && !lower.test(char)))) continue;
            const from = (run.index ?? 0) + part.index;
            words.push({ from, to: from + word.length, text: word });
        }
    }
    return words;
}
