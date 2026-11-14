// render.md §2/6: paint order is independent of spatial/material order. Fixed-size leaves keep
// edits to splices of touched runs; Fenwick counts provide ranks without renumbering every node.
export const PAINT_ORDER_CHUNK = 256;
const EMPTY = new Uint32Array(0);
interface Block { readonly id: number; readonly sheet: number; readonly slots: Uint32Array; size: number; index: number }
interface SheetOrder { blocks: Block[]; fenwick: Uint32Array; size: number }
export class PaintOrder {
    private readonly sheets = new Map<number, SheetOrder>();
    private readonly blocks = new Map<number, Block>();
    private locations = new Int32Array(16).fill(-1);
    private offsets = new Uint16Array(16);
    private nextBlock = 1;
    reserve(slots: number): void {
        if (slots <= this.locations.length) return;
        let size = this.locations.length;
        while (size < slots) size *= 2;
        const locations = new Int32Array(size).fill(-1); locations.set(this.locations); this.locations = locations;
        const offsets = new Uint16Array(size); offsets.set(this.offsets); this.offsets = offsets;
    }
    has(slot: number): boolean { return slot >= 0 && slot < this.locations.length && this.locations[slot] >= 0; }
    sheet(slot: number): number { return this.blocks.get(this.locations[slot])?.sheet ?? -1; }
    size(sheet: number): number { return this.sheets.get(sheet)?.size ?? 0; }
    rank(slot: number): number {
        const block = this.blocks.get(this.locations[slot]);
        if (!block) return -1;
        const sheet = this.sheets.get(block.sheet)!;
        let prefix = 0;
        for (let i = block.index; i; i -= i & -i) prefix += sheet.fenwick[i];
        return prefix + this.offsets[slot];
    }
    private locate(sheet: SheetOrder, rank: number): number {
        if (!sheet.blocks.length) return 0;
        if (rank === sheet.size) return sheet.blocks.length - 1;
        let index = 0, prefix = 0, step = 1;
        while (step * 2 < sheet.fenwick.length) step *= 2;
        for (; step; step >>= 1) {
            const next = index + step;
            if (next < sheet.fenwick.length && prefix + sheet.fenwick[next] <= rank) { index = next; prefix += sheet.fenwick[next]; }
        }
        return Math.min(index, sheet.blocks.length - 1);
    }
    private prefix(sheet: SheetOrder, block: number): number {
        let value = 0;
        for (let i = block; i; i -= i & -i) value += sheet.fenwick[i];
        return value;
    }
    at(sheetId: number, rank: number): number {
        const sheet = this.sheets.get(sheetId);
        if (!sheet || !Number.isInteger(rank) || rank < 0 || rank >= sheet.size) return -1;
        const index = this.locate(sheet, rank);
        return sheet.blocks[index].slots[rank - this.prefix(sheet, index)];
    }
    copy(sheet: number, first: number, count: number, target: Uint32Array, offset = 0): void {
        if (!Number.isInteger(first) || !Number.isInteger(count) || first < 0 || count < 0 || first + count > this.size(sheet)
            || offset < 0 || offset + count > target.length) throw new RangeError('Invalid paint-order range');
        for (let i = 0; i < count; i++) target[offset + i] = this.at(sheet, first + i);
    }
    splice(sheetId: number, first: number, deleted: number, inserted: ArrayLike<number>): void {
        let sheet = this.sheets.get(sheetId);
        if (!sheet) { sheet = { blocks: [], fenwick: new Uint32Array(1), size: 0 }; this.sheets.set(sheetId, sheet); }
        if (!Number.isInteger(first) || !Number.isInteger(deleted) || first < 0 || deleted < 0 || first + deleted > sheet.size) throw new RangeError('Invalid paint-order splice');
        if (!deleted && !inserted.length) return;
        const begin = this.locate(sheet, first), end = this.locate(sheet, first + deleted);
        const beginRank = this.prefix(sheet, begin), endRank = this.prefix(sheet, end);
        const firstBlock = sheet.blocks[begin], lastBlock = sheet.blocks[end];
        const prefix = firstBlock ? first - beginRank : 0;
        const suffixStart = lastBlock ? first + deleted - endRank : 0;
        const suffix = lastBlock ? lastBlock.size - suffixStart : 0;
        const combined = new Uint32Array(prefix + inserted.length + suffix);
        for (let i = 0; i < prefix; i++) combined[i] = firstBlock.slots[i];
        for (let i = 0; i < inserted.length; i++) {
            const slot = inserted[i];
            if (!Number.isInteger(slot) || slot < 0 || slot > 0x7fffffff) throw new RangeError('Invalid paint-order slot');
            this.reserve(slot + 1); combined[prefix + i] = slot;
        }
        for (let i = 0; i < suffix; i++) combined[prefix + inserted.length + i] = lastBlock.slots[suffixStart + i];
        const replacement: Block[] = [];
        for (let i = 0; i < combined.length; i += PAINT_ORDER_CHUNK) {
            if (this.nextBlock > 0x7fffffff) throw new RangeError('Paint-order chunk identifiers exhausted');
            const slots = new Uint32Array(PAINT_ORDER_CHUNK), size = Math.min(PAINT_ORDER_CHUNK, combined.length - i);
            for (let j = 0; j < size; j++) slots[j] = combined[i + j];
            replacement.push({ id: this.nextBlock++, sheet: sheetId, slots, size, index: 0 });
        }
        const removed = firstBlock ? end - begin + 1 : 0;
        for (let i = begin; i < begin + removed; i++) {
            const block = sheet.blocks[i]; this.blocks.delete(block.id);
            for (let j = 0; j < block.size; j++) this.locations[block.slots[j]] = -1;
        }
        sheet.blocks.splice(begin, removed, ...replacement);
        for (const block of replacement) {
            this.blocks.set(block.id, block);
            for (let i = 0; i < block.size; i++) { this.locations[block.slots[i]] = block.id; this.offsets[block.slots[i]] = i; }
        }
        sheet.size += inserted.length - deleted;
        // Only chunk headers/counts change here, never an O(N) rank/key rewrite or full re-sort.
        sheet.fenwick = new Uint32Array(sheet.blocks.length + 1);
        for (let i = 0; i < sheet.blocks.length; i++) {
            sheet.blocks[i].index = i;
            for (let j = i + 1; j < sheet.fenwick.length; j += j & -j) sheet.fenwick[j] += sheet.blocks[i].size;
        }
    }
    remove(sheet: number, first: number, count: number): void { this.splice(sheet, first, count, EMPTY); }
    *chunks(sheet: number): Iterable<Readonly<{ slots: Uint32Array; count: number }>> {
        for (const block of this.sheets.get(sheet)?.blocks ?? []) yield { slots: block.slots, count: block.size };
    }
    get byteLength(): number {
        let bytes = this.locations.byteLength + this.offsets.byteLength;
        for (const sheet of this.sheets.values()) {
            bytes += sheet.fenwick.byteLength;
            for (const block of sheet.blocks) bytes += block.slots.byteLength;
        }
        return bytes;
    }
}
