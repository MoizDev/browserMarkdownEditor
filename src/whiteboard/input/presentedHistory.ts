export interface PresentedValue<T> { readonly time: number; readonly value: T }

export class PresentedHistory<T> {
    private readonly entries: PresentedValue<T>[] = [];
    present(time: number, value: T): void {
        if (!Number.isFinite(time) || time < 0 || (this.entries.length && time < this.entries[this.entries.length - 1].time)) {
            throw new RangeError('Invalid presented chrome timestamp');
        }
        this.entries.push({ time, value });
        while (this.entries.length > 64 && time - this.entries[1].time >= 250) this.entries.shift();
    }
    at(time?: number): T | null {
        if (!this.entries.length) return null;
        if (time === undefined) return this.entries[this.entries.length - 1].value;
        if (!Number.isFinite(time)) return null;
        let index = this.entries.length - 1;
        while (index > 0 && this.entries[index].time > time) index--;
        return this.entries[index].value;
    }
    clear(): void { this.entries.length = 0; }
}
