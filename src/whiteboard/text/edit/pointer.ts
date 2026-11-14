import type { EditSelection } from './host';

export interface TextPointer {
    readonly id: number;
    readonly kind: 'mouse' | 'pen' | 'touch';
    readonly x: number;
    readonly y: number;
    readonly clicks: number;
    readonly shift: boolean;
    readonly accel: boolean;
}
export interface PointerSelectionServices {
    selection(): EditSelection;
    setSelection(selection: EditSelection): void;
    hit(x: number, y: number): number;
    word(offset: number): EditSelection;
    block(offset: number): EditSelection;
    autoScroll(x: number, y: number): void;
    touchHandles(show: boolean): void;
    menu(x: number, y: number): void;
    followLink(x: number, y: number): boolean;
}

// The canvas retains pointer capture while the hidden edit host retains focus.
export class TextPointerSelection {
    private active: number | null = null;
    private anchor = 0;
    private startX = 0;
    private startY = 0;
    private hold: ReturnType<typeof setTimeout> | null = null;
    private handle: 'anchor' | 'focus' | null = null;
    constructor(private readonly services: PointerSelectionServices) {}

    down(pointer: TextPointer, handle: 'anchor' | 'focus' | null = null): void {
        this.cancel();
        this.active = pointer.id;
        this.startX = pointer.x;
        this.startY = pointer.y;
        this.handle = handle;
        const hit = this.services.hit(pointer.x, pointer.y);
        if (!handle && pointer.accel && this.services.followLink(pointer.x, pointer.y)) { this.cancel(); return; }
        if (handle) {
            const selection = this.services.selection();
            this.anchor = handle === 'anchor' ? selection.focus : selection.anchor;
            return;
        }
        if (pointer.kind === 'touch') {
            this.anchor = hit;
            this.services.setSelection({ anchor: hit, focus: hit });
            this.services.touchHandles(false);
            this.hold = setTimeout(() => {
                this.hold = null;
                if (this.active !== pointer.id) return;
                const selection = this.services.word(hit);
                this.anchor = selection.anchor;
                this.services.setSelection(selection);
                this.services.touchHandles(true);
                this.services.menu(pointer.x, pointer.y);
            }, 500);
            return;
        }
        if (pointer.clicks >= 3) {
            const selection = this.services.block(hit);
            this.anchor = selection.anchor;
            this.services.setSelection(selection);
        } else if (pointer.clicks === 2) {
            const selection = this.services.word(hit);
            this.anchor = selection.anchor;
            this.services.setSelection(selection);
        } else {
            this.anchor = pointer.shift ? this.services.selection().anchor : hit;
            this.services.setSelection({ anchor: this.anchor, focus: hit });
        }
    }

    move(pointer: TextPointer): void {
        if (pointer.id !== this.active) return;
        if (Math.hypot(pointer.x - this.startX, pointer.y - this.startY) > 5) this.clearHold();
        const focus = this.services.hit(pointer.x, pointer.y);
        this.services.setSelection(this.handle === 'anchor' ? { anchor: focus, focus: this.anchor } : { anchor: this.anchor, focus });
        this.services.autoScroll(pointer.x, pointer.y);
    }

    up(id: number): void { if (id === this.active) this.cancel(); }
    cancel(): void { this.clearHold(); this.active = null; this.handle = null; }
    dispose(): void { this.cancel(); }
    private clearHold(): void { if (this.hold !== null) clearTimeout(this.hold); this.hold = null; }
}
