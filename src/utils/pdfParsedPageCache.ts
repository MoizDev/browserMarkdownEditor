// pdf.js does not expose worker/operator-list or decoded-image sizes. These are
// policy reservations, not measurements of its heap; unknown rendered pages
// are treated as heavy on hide rather than reported as known allocations.
const BUDGET = 128 * 1024 * 1024;
const UNKNOWN_RENDERED = 32 * 1024 * 1024;
const MAX_WARM_PER_DOCUMENT = 6;
const HIDDEN_GRACE_MS = 5000;

export interface ParsedPageCacheEntry {
    readonly owner: object;
    readonly index: number;
    users: number;
    visible: boolean;
    current: number;
    rendered: boolean;
    lastUsed: number;
    evict(): void;
}

const idle = new Set<ParsedPageCacheEntry>();
const hiddenTimers = new Map<object, ReturnType<typeof setTimeout>>();
const expiredHidden = new WeakSet<object>();
let clock = 0;

function remove(entry: ParsedPageCacheEntry) {
    if (!idle.delete(entry)) return;
    entry.evict();
}

function trim() {
    const entries = [...idle].sort((a, b) => {
        const aNear = a.visible && Math.abs(a.index - a.current) <= 2;
        const bNear = b.visible && Math.abs(b.index - b.current) <= 2;
        return Number(bNear) - Number(aNear) || b.lastUsed - a.lastUsed;
    });
    const counts = new Map<object, number>();
    let reserved = 0;
    for (const entry of entries) {
        const count = counts.get(entry.owner) ?? 0;
        const cost = entry.rendered ? UNKNOWN_RENDERED : 0;
        const currentHeavy = entry.visible && entry.index === entry.current && count === 0;
        if (count >= MAX_WARM_PER_DOCUMENT || (reserved + cost > BUDGET && !currentHeavy)) {
            remove(entry);
        } else {
            counts.set(entry.owner, count + 1);
            reserved += cost;
        }
    }
}

export function parsedPageReservation(owner: object): { idlePages: number; reservationBytes: number } {
    let idlePages = 0, reservationBytes = 0;
    for (const entry of idle) if (entry.owner === owner) {
        idlePages++;
        if (entry.rendered) reservationBytes += UNKNOWN_RENDERED;
    }
    return { idlePages, reservationBytes };
}

export function discardParsedPage(entry: ParsedPageCacheEntry) { idle.delete(entry); }

export function parsedPageBusy(entry: ParsedPageCacheEntry) {
    idle.delete(entry);
    entry.lastUsed = ++clock;
}

export function parsedPageIdle(entry: ParsedPageCacheEntry) {
    entry.lastUsed = ++clock;
    if (!entry.visible && (entry.rendered || expiredHidden.has(entry.owner))) { entry.evict(); return; }
    idle.add(entry);
    trim();
}

export function parsedPageVisibility(owner: object, visible: boolean, entries: Iterable<ParsedPageCacheEntry>, current: number) {
    const timer = hiddenTimers.get(owner);
    if (timer) clearTimeout(timer);
    hiddenTimers.delete(owner);
    expiredHidden.delete(owner);
    for (const entry of entries) {
        entry.visible = visible;
        entry.current = current;
        if (!visible && entry.users === 0 && entry.rendered) remove(entry);
    }
    if (!visible) {
        hiddenTimers.set(owner, setTimeout(() => {
            hiddenTimers.delete(owner);
            expiredHidden.add(owner);
            for (const entry of [...idle]) if (entry.owner === owner) remove(entry);
        }, HIDDEN_GRACE_MS));
    }
    trim();
}

export function forgetParsedPages(owner: object) {
    const timer = hiddenTimers.get(owner);
    if (timer) clearTimeout(timer);
    hiddenTimers.delete(owner);
    for (const entry of idle) if (entry.owner === owner) idle.delete(entry);
}
