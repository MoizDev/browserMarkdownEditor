import { writeStoredValue } from './storage';

export type ReplyModePref = 'auto' | 'teach' | 'direct';

export type ReplyMode = 'teach' | 'direct';

const KEY = 'agentReplyMode';

let pref: ReplyModePref = (() => {
    try {
        const stored = localStorage.getItem(KEY);
        return stored === 'teach' || stored === 'direct' ? stored : 'auto';
    } catch {
        return 'auto';
    }
})();
const listeners = new Set<() => void>();

export function getReplyModePref(): ReplyModePref {
    return pref;
}

export function setReplyModePref(next: ReplyModePref): void {
    if (next === pref) return;
    pref = next;
    writeStoredValue(KEY, next);
    for (const listener of listeners) listener();
}

export function subscribeReplyMode(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function nextReplyModePref(current: ReplyModePref): ReplyModePref {
    return current === 'auto' ? 'teach' : current === 'teach' ? 'direct' : 'auto';
}

const LEARNING = new RegExp([
    /\b(teach|tutor|eli5|quiz me|test me)\b/,
    /\b(explain|explanation)\b/,
    /\bwalk me through\b/,
    /\bhelp me (understand|get|learn|see)\b/,
    /\b(i|we) (don'?t|do not|can'?t|cannot) (get|understand|follow|see) (this|that|it|why|how|what)\b/,
    /\bi'?m (lost|confused|stuck on the idea)\b/,
    /\b(confused|unclear) about\b/,
    /\b(intuition|idea) (behind|for|of)\b/,
    /\bwhy (does|do|is|are|isn'?t|can'?t|would|should)\b/,
    /\bhow (does|do|did) .{0,40}\b(work|happen|come|end up)\b/,
    /\bwhat (is|are|does) .{0,40}\b(mean|do|actually)\b/,
    /\b(derive|derivation|prove|proof of|first principles)\b/,
    /\b(learn|learning|study|studying|revise|revision) (this|that|it|about|for)\b/,
].map(re => re.source).join('|'), 'i');

const TASK = new RegExp([
    /^\s*(add|append|insert|create|make|new|write|draft|note down|fix|correct|change|edit|update|rewrite|refactor|rename|move|delete|remove|trash|clean|sort|organi[sz]e|tidy|search|find|look for|list|open|show me the|draw|sketch|annotate|highlight|mark|circle|translate|convert|format|summari[sz]e|tl;?dr)\b/,
    /\b(in|into|to|at) (a|an|my|the|this) (note|file|vault|drawing|notebook|canvas|pdf|page|doc|document|heading|section)\b/,
].map(re => re.source).join('|'), 'i');

export function looksLikeLearning(text: string): boolean {
    const body = text.trim();
    if (!body) return false;
    if (TASK.test(body)) return false;
    return LEARNING.test(body);
}

export function resolveReplyMode(prefNow: ReplyModePref, text: string, wasTeaching: boolean): ReplyMode {
    if (prefNow === 'teach') return 'teach';
    if (prefNow === 'direct') return 'direct';
    if (looksLikeLearning(text)) return 'teach';
    return wasTeaching && !TASK.test(text.trim()) ? 'teach' : 'direct';
}

const MATHS = ' Maths as LaTeX, never Unicode: $x^2$ inline, $$ ... $$ on its own line.';

export const REPLY_MODE_LINE: Record<ReplyMode, string> = {
    direct: 'Reply mode: DIRECT. Answer the question and stop; no preamble, no recap.' + MATHS,
    teach: 'Reply mode: TEACHING. The user is learning this, not asking for a finished answer. '
        + 'Give ONE idea in under about 120 words, with a concrete example, then exactly one short question that '
        + 'checks it landed, then stop and wait. Do not cover the whole topic or answer your own question. '
        + 'A quick factual question still gets a one-line answer.' + MATHS,
};
