// How the agent should ANSWER: briefly, or by teaching one step at a time.
//
// Two problems, one control. An agent CLI left to itself writes for a terminal
// — headings, bullet storms, a recap of what it just did — and that is unreadable
// in a 400px column beside a note. And when the user is trying to LEARN
// something, the right answer is not a better-written essay: it is one idea, a
// question back, and a pause.
//
// WHERE THE RULES LIVE. The durable contract (be brief; what the two cadences
// are) is in the agents' system prompt, `helper/src/prompt.ts`, because it never
// changes within a chat — and it cannot be per-message anyway: Claude records
// the system prompt on a chat's first request and reuses it on every resume.
// What IS per-message is which cadence applies, and that rides in the
// <bme-context> block with everything else that changes between messages. The
// reminder below is short but self-contained, so a chat started before this
// existed still gets the cadence from the block alone.
//
// WHY THE EDITOR DECIDES AND NOT THE MODEL. The panel shows a lit cap when it is
// teaching. A badge the model controlled would need the model to tell us, in
// its own reply, what mode it chose — a marker to strip from a stream, wrong
// half the time, and unfixable when it lies. Deciding here keeps the badge and
// the prompt the same fact.

/** What the user pinned. `auto` is the default and what the cap shows unlit. */
export type ReplyModePref = 'auto' | 'teach' | 'direct';

/** What one message is actually sent as. */
export type ReplyMode = 'teach' | 'direct';

const KEY = 'agentReplyMode';

/**
 * App-wide, not per chat: it is how the user likes to be answered, and a mode
 * that reset every time they started a chat would have to be set every time.
 * A live store, because the composer's chip and the send path both read it.
 */
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
    try {
        localStorage.setItem(KEY, next);
    } catch { /* still applies for this session */ }
    for (const listener of listeners) listener();
}

export function subscribeReplyMode(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** The cap cycles through the three, in the order a user reaches for them. */
export function nextReplyModePref(current: ReplyModePref): ReplyModePref {
    return current === 'auto' ? 'teach' : current === 'teach' ? 'direct' : 'auto';
}

/* ───────────────────────── deciding, in `auto` ───────────────────────── */

/**
 * Asking to understand something, rather than asking for something to be done.
 *
 * Deliberately narrow: a false positive costs a reply that stops to ask a
 * question the user did not want, so only wording that is ABOUT understanding
 * counts. "How do I add a table" is a task; "how does the table parser work" is
 * not, and the verb after "how do I" is what tells them apart — hence the task
 * check below, which wins.
 */
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

/**
 * Something to DO, in the vault or on the page. Beats the learning cues above:
 * "explain this in a note at the top of the file" is a writing job, and a reply
 * that stopped to ask a comprehension question would simply not have done it.
 */
const TASK = new RegExp([
    /^\s*(add|append|insert|create|make|new|write|draft|note down|fix|correct|change|edit|update|rewrite|refactor|rename|move|delete|remove|trash|clean|sort|organi[sz]e|tidy|search|find|look for|list|open|show me the|draw|sketch|annotate|highlight|mark|circle|translate|convert|format|summari[sz]e|tl;?dr)\b/,
    // "explain this in a note at the top of the file" is a writing job wearing
    // a learning verb — measured against the cue list, which called it teaching.
    /\b(in|into|to|at) (a|an|my|the|this) (note|file|vault|drawing|notebook|canvas|pdf|page|doc|document|heading|section)\b/,
].map(re => re.source).join('|'), 'i');

export function looksLikeLearning(text: string): boolean {
    const body = text.trim();
    if (!body) return false;
    if (TASK.test(body)) return false;
    return LEARNING.test(body);
}

/**
 * The mode for one message.
 *
 * `teaching` is STICKY inside a chat: once a lesson is under way, "yes", "no
 * idea" and "why?" are the whole point of the cadence and carry none of the
 * cues above, so only an explicit task pulls it back out. That stickiness lives
 * in the chat store (in memory — a reload starts the chat neutral again).
 */
export function resolveReplyMode(prefNow: ReplyModePref, text: string, wasTeaching: boolean): ReplyMode {
    if (prefNow === 'teach') return 'teach';
    if (prefNow === 'direct') return 'direct';
    if (looksLikeLearning(text)) return 'teach';
    return wasTeaching && !TASK.test(text.trim()) ? 'teach' : 'direct';
}

/* ───────────────────────── what the model is told ───────────────────────── */

/** The last line of the <bme-context> block, so it is the closest instruction
 *  to the user's own words. Kept short: the full contract is the system prompt. */
export const REPLY_MODE_LINE: Record<ReplyMode, string> = {
    direct: 'Reply mode: DIRECT. Answer the question and stop. No preamble, no recap, no offer to help further.',
    teach: 'Reply mode: TEACHING. The user is trying to understand this, not to be handed a finished answer. '
        + 'Give ONE idea — the smallest next step — in under about 120 words of plain prose, with a concrete example '
        + '(from their own notes or what is on their screen where you can). End with exactly one short question that '
        + 'checks it landed, then STOP and wait: do not answer it yourself, and do not start the next idea. '
        + 'If they got it, take the next step; if they did not, go smaller. '
        + 'If this turns out to be a quick factual question, just answer it in one line instead.',
};
