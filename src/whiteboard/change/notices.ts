import type { Applied, BoardKey, TouchedSet } from './ops';
import type { NodeId, SheetId } from '../model/ids';
import type { MediaId } from '../model/media';
import type { ChangeNotice } from '../session/BoardSession';

interface MutableNotice {
    rev: number;
    readonly nodes: Set<NodeId>;
    readonly sheets: Set<SheetId>;
    readonly board: Set<BoardKey>;
    readonly media: Set<MediaId>;
    sheetChanged: boolean;
    selectionChanged: boolean;
}
export interface NoticeScheduler {
    /** Invalidate one visible platform pane; no private requestAnimationFrame. */
    invalidateFrame(): void;
    hasVisiblePane(): boolean;
    reportError(error: unknown): void;
}
function blank(rev: number): MutableNotice {
    return { rev, nodes: new Set(), sheets: new Set(), board: new Set(), media: new Set(), sheetChanged: false, selectionChanged: false };
}
function merge(into: MutableNotice, touched: TouchedSet): void {
    for (const id of touched.nodes) into.nodes.add(id);
    for (const id of touched.sheets) into.sheets.add(id);
    for (const id of touched.board) into.board.add(id);
    for (const id of touched.media) into.media.add(id);
}

/** One application dispatcher serves visible and hidden sessions in platform frame order. */
export class NoticeDispatcher {
    private readonly pending = new Set<NoticeChannel>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private lastFrame = -1;
    private disposed = false;
    constructor(private readonly scheduler: NoticeScheduler) {}
    createChannel(revision: () => number): NoticeChannel { return new NoticeChannel(this, revision); }
    enqueue(channel: NoticeChannel): void {
        if (this.disposed) return;
        this.pending.add(channel);
        this.schedule();
    }
    remove(channel: NoticeChannel): void { this.pending.delete(channel); }
    /** Call when visible-pane registrations change. */
    visibilityChanged(): void { if (this.pending.size) this.schedule(); }
    private schedule(): void {
        if (this.scheduler.hasVisiblePane()) {
            clearTimeout(this.timer); this.timer = undefined;
            this.scheduler.invalidateFrame();
        } else if (this.timer === undefined) {
            this.timer = setTimeout(() => {
                this.timer = undefined;
                if (this.scheduler.hasVisiblePane()) this.schedule(); else this.deliver();
            }, 100);
        }
    }
    /** Call from the first ordered platform layer's prepare, once per budget.frameId. */
    flushFrame(frameId: number): void {
        if (this.disposed || this.lastFrame === frameId) return;
        this.lastFrame = frameId;
        clearTimeout(this.timer); this.timer = undefined;
        this.deliver();
    }
    private deliver(): void {
        if (this.disposed || !this.pending.size) return;
        const channels = [...this.pending];
        this.pending.clear();
        // Snapshot all sessions before invoking any listener: reentrant applies always
        // wait for the next platform frame, even when they target another session.
        const batch = channels.map(channel => ({ channel, notice: channel.take() }));
        for (const { channel, notice } of batch) if (notice) channel.publish(notice, error => this.scheduler.reportError(error));
        if (this.pending.size) this.schedule();
    }
    dispose(): void {
        this.disposed = true;
        clearTimeout(this.timer); this.timer = undefined;
        this.pending.clear();
    }
}

export class NoticeChannel {
    private pending: MutableNotice | undefined;
    private readonly listeners = new Set<(notice: ChangeNotice) => void>();
    private disposed = false;
    constructor(private readonly dispatcher: NoticeDispatcher, private readonly revision: () => number) {}
    subscribe(listener: (notice: ChangeNotice) => void): () => void {
        if (this.disposed) return () => {};
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    private current(): MutableNotice {
        if (!this.pending) this.pending = blank(this.revision());
        this.pending.rev = this.revision();
        return this.pending;
    }
    /** Apply's last internal consumer; it only accumulates, never calls listeners. */
    record(applied: Applied): void {
        if (this.disposed) return;
        const pending = this.current();
        merge(pending, applied.touched);
        if (applied.forward.some(op => op.t === 'sheet')) pending.sheetChanged = true;
        this.dispatcher.enqueue(this);
    }
    selectionChanged(): void {
        if (this.disposed) return;
        this.current().selectionChanged = true;
        this.dispatcher.enqueue(this);
    }
    sheetChanged(): void {
        if (this.disposed) return;
        this.current().sheetChanged = true;
        this.dispatcher.enqueue(this);
    }
    /** Dispatcher-only snapshot; later applies get a new accumulation. */
    take(): ChangeNotice | undefined {
        const value = this.pending;
        this.pending = undefined;
        if (!value || this.disposed) return;
        return { rev: value.rev, touched: { nodes: value.nodes, sheets: value.sheets, board: value.board, media: value.media },
            sheetChanged: value.sheetChanged, selectionChanged: value.selectionChanged };
    }
    publish(notice: ChangeNotice, reportError: (error: unknown) => void): void {
        if (this.disposed) return;
        for (const listener of [...this.listeners]) {
            try { listener(notice); } catch (error) { reportError(error); }
        }
    }
    dispose(): void { this.disposed = true; this.pending = undefined; this.listeners.clear(); this.dispatcher.remove(this); }
}
