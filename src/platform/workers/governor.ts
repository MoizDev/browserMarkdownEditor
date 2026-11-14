import { now } from './clock';
import type { CpuAdmission, CpuPermit, CpuPermits, Priority } from './envelope';

const starvationMs = 2000;
type Entry = {
    admission: CpuAdmission;
    priority: Priority;
    order: number;
    started: number;
    waiting: number;
    aged: boolean;
    phase: 'queued' | 'running' | 'paused' | 'released';
};

class Governor implements CpuPermits {
    private entries = new Set<Entry>();
    private order = 0;
    private starts = 0;
    private scheduling = false;
    private changed = false;
    private timer?: ReturnType<typeof setTimeout>;
    private readonly cap: number;

    constructor() {
        const cores = typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency;
        this.cap = Math.max(2, Math.min(6, (Number.isFinite(cores) ? cores : 4) - 1));
    }

    acquire(admission: CpuAdmission): CpuPermit {
        const entry: Entry = {
            admission, priority: admission.priority, order: ++this.order, started: 0,
            waiting: now(), aged: false, phase: 'queued',
        };
        this.entries.add(entry);
        try {
            this.schedule(entry.priority === 0 ? entry : undefined);
        } catch (error) {
            this.release(entry);
            throw error;
        }
        return {
            get held() { return entry.phase === 'running'; },
            reprioritise: priority => {
                if (entry.phase === 'released' || priority === entry.priority) return;
                entry.priority = priority;
                entry.aged = false;
                if (priority === 3) entry.waiting = now();
                this.schedule(priority === 0 && entry.phase !== 'running' ? entry : undefined);
            },
            release: () => this.release(entry),
        };
    }

    private release(entry: Entry): void {
        if (entry.phase === 'released') return;
        entry.phase = 'released';
        this.entries.delete(entry);
        this.schedule();
    }

    private run(entry: Entry, time: number): void {
        const resume = entry.started !== 0;
        entry.aged = entry.priority === 3 && time - entry.waiting >= starvationMs;
        entry.phase = 'running';
        entry.started = ++this.starts;
        if (resume) entry.admission.resume();
        else entry.admission.start();
    }

    private choose(time: number): Set<Entry> {
        const entries = [...this.entries];
        const foreground = entries.some(entry => entry.priority === 0);
        const overdue = (entry: Entry) => entry.priority === 3 && entry.phase !== 'running'
            && time - entry.waiting >= starvationMs;
        // A waiting background job gets a turn ahead of 1/2 after two seconds, otherwise
        // a steady stream of visible work could keep it queued forever. It never displaces 0.
        const rank = (entry: Entry) => overdue(entry) ? 0.5 : entry.priority;
        entries.sort((a, b) => rank(a) - rank(b)
            || Number(b.phase === 'running') - Number(a.phase === 'running')
            || (a.phase === 'running' && b.phase === 'running' ? a.started - b.started : 0)
            || Number(b.phase === 'paused') - Number(a.phase === 'paused')
            || a.order - b.order);
        const selected = new Set<Entry>();
        for (const entry of entries) {
            if (entry.priority !== 0) {
                if (selected.size >= this.cap) break;
                // Do not fill the reserved core with lower-priority work while a 2 is waiting.
                if (entry.priority === 2 && selected.size >= this.cap - 1) break;
                if (entry.priority === 3 && foreground && !entry.aged && !overdue(entry)) continue;
            }
            selected.add(entry);
        }
        return selected;
    }

    private schedule(foreground?: Entry): void {
        this.changed = true;
        if (this.scheduling) {
            if (foreground) this.run(foreground, now());
            return;
        }
        this.scheduling = true;
        try {
            // Even a 0 arriving inside another admission callback starts synchronously.
            // Lower-priority workers yield after their pause reaches a slice boundary.
            if (foreground) this.run(foreground, now());
            while (this.changed) {
                this.changed = false;
                const time = now();
                const selected = this.choose(time);
                // Pause before starting replacements; no worker-to-main permission round trip
                // is needed at each slice, and equal-priority running work never churns.
                const victims = [...this.entries].filter(entry => entry.phase === 'running' && !selected.has(entry))
                    .sort((a, b) => b.priority - a.priority || b.started - a.started);
                for (const entry of victims) {
                    entry.phase = 'paused';
                    entry.waiting = time;
                    entry.aged = false;
                    entry.admission.pause();
                    if (this.changed) break;
                }
                if (this.changed) continue;
                for (const entry of selected) {
                    if (entry.phase === 'released' || entry.phase === 'running') continue;
                    this.run(entry, time);
                    // Client callbacks may cancel, dispose, or enqueue another request. Never
                    // continue an old admission plan after one of those changes.
                    if (this.changed) break;
                }
            }
        } finally {
            this.scheduling = false;
            this.armFairness();
        }
    }

    private armFairness(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        const time = now();
        let next = Infinity;
        for (const entry of this.entries) {
            if (entry.priority !== 3 || entry.phase === 'running') continue;
            const at = entry.waiting + starvationMs;
            if (at > time) next = Math.min(next, at);
        }
        // Eligibility changes once at the oldest waiter's deadline, not on a polling interval.
        // Already-aged jobs blocked by priority 0 wait for a real queue change, not a busy loop.
        if (next !== Infinity) this.timer = setTimeout(() => this.schedule(), next - time);
    }
}

// All clients in this main-thread realm share one cap, including clients loaded lazily later.
export const cpuGovernor: CpuPermits = new Governor();
