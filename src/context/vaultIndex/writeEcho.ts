interface WriteStamp { mtime: number; size: number; expires: number; pending: boolean; timer?: ReturnType<typeof setTimeout> }

/** Observer events carry paths, not stats. A single deferred stat closes the
 * self-write window without hiding a real outside edit made during it. */
export class WriteEchoFilter {
    private readonly writes = new Map<string, WriteStamp>();
    private closed = false;
    constructor(private readonly stat: (path: string) => Promise<{ mtime: number; size: number } | null>,
        private readonly invalidate: (paths: string[]) => void) {}

    remember(path: string, mtime: number, size: number): void {
        const previous = this.writes.get(path);
        if (previous?.timer) clearTimeout(previous.timer);
        const stamp: WriteStamp = { mtime, size, expires: Date.now() + 10_000, pending: previous?.pending ?? false };
        this.writes.set(path, stamp);
        this.defer(path, stamp);
    }
    hints(paths: readonly string[]): void {
        const immediate: string[] = [];
        for (const path of new Set(paths)) {
            const stamp = this.writes.get(path);
            if (!stamp || stamp.expires <= Date.now()) {
                if (stamp?.timer) clearTimeout(stamp.timer);
                this.writes.delete(path);
                immediate.push(path);
            } else stamp.pending = true;
        }
        if (immediate.length && !this.closed) this.invalidate(immediate);
    }
    private defer(path: string, stamp: WriteStamp): void {
        stamp.timer = setTimeout(() => {
            stamp.timer = undefined;
            if (stamp.pending) void this.check(path, stamp);
            else if (this.writes.get(path) === stamp) this.writes.delete(path);
        }, Math.max(0, stamp.expires - Date.now()));
    }
    private async check(path: string, stamp: WriteStamp): Promise<void> {
        let stat: { mtime: number; size: number } | null;
        try { stat = await this.stat(path); } catch { stat = null; }
        if (this.closed || this.writes.get(path) !== stamp) return;
        this.writes.delete(path);
        if (!stat || stat.mtime !== stamp.mtime || stat.size !== stamp.size) this.invalidate([path]);
    }
    dispose(): void {
        this.closed = true;
        for (const stamp of this.writes.values()) if (stamp.timer) clearTimeout(stamp.timer);
        this.writes.clear();
    }
}
