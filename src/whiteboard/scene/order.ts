// render.md §2/6: paint order is independent of spatial/material order. Fixed-size leaves keep
// edits to splices of touched runs; Fenwick counts provide ranks without renumbering every node.
export const PAINT_ORDER_CHUNK = 256;
const EMPTY = new Uint32Array(0);
export interface PaintOrderChunk { readonly slots: Uint32Array; readonly count: number }
interface Block extends PaintOrderChunk { readonly id: number; readonly sheet: number; index: number }
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
            || !Number.isInteger(offset) || offset < 0 || offset + count > target.length) throw new RangeError('Invalid paint-order range');
        const order = this.sheets.get(sheet);
        if (!order || !count) return;
        let block = this.locate(order, first), local = first - this.prefix(order, block), remaining = count;
        while (remaining) {
            const chunk = order.blocks[block++], take = Math.min(remaining, chunk.count - local);
            for (let i = 0; i < take; i++) target[offset++] = chunk.slots[local + i];
            remaining -= take; local = 0;
        }
    }
    splice(sheetId: number, first: number, deleted: number, inserted: ArrayLike<number>): void {
        for (const _ of this.spliceSteps(sheetId, first, deleted, inserted)) { /* synchronous callers finish the same mutation */ }
    }
    *spliceSteps(sheetId: number, first: number, deleted: number, inserted: ArrayLike<number>): Generator<void, void> {
        let sheet = this.sheets.get(sheetId);
        if (!sheet) { sheet = { blocks: [], fenwick: new Uint32Array(1), size: 0 }; this.sheets.set(sheetId, sheet); }
        if (!Number.isInteger(first) || !Number.isInteger(deleted) || first < 0 || deleted < 0 || first + deleted > sheet.size
            || !Number.isSafeInteger(inserted.length) || inserted.length < 0) throw new RangeError('Invalid paint-order splice');
        if (!deleted && !inserted.length) return;
        let work = 0, maxSlot = -1;
        const added = new Set<number>(), incoming = new Uint32Array(inserted.length);
        for (let i = 0; i < incoming.length; i++) {
            const slot = inserted[i];
            if (!Number.isInteger(slot) || slot < 0 || slot > 0x7fffffff || added.has(slot)) throw new RangeError('Duplicate or invalid paint-order slot');
            if (this.has(slot) && (this.sheet(slot) !== sheetId || this.rank(slot) < first || this.rank(slot) >= first + deleted)) {
                throw new RangeError('Paint-order slot already belongs to another interval');
            }
            added.add(slot); incoming[i] = slot; maxSlot = Math.max(maxSlot, slot);
            if ((++work & 255) === 0) yield;
        }
        // Growing the location table must also be sliced; TypedArray.fill/set on
        // a million entries would otherwise defeat a cooperative splice.
        if (maxSlot >= this.locations.length) {
            let size = this.locations.length;
            while (size <= maxSlot) size *= 2;
            const locations = new Int32Array(size), offsets = new Uint16Array(size);
            for (let i = 0; i < size; i++) {
                locations[i] = i < this.locations.length ? this.locations[i] : -1;
                if (i < this.offsets.length) offsets[i] = this.offsets[i];
                if ((++work & 255) === 0) yield;
            }
            this.locations = locations; this.offsets = offsets;
        }
        const begin = this.locate(sheet, first), end = this.locate(sheet, first + deleted);
        const beginRank = this.prefix(sheet, begin), endRank = this.prefix(sheet, end);
        const firstBlock = sheet.blocks[begin], lastBlock = sheet.blocks[end];
        const prefix = firstBlock ? first - beginRank : 0;
        const suffixStart = lastBlock ? first + deleted - endRank : 0;
        const suffix = lastBlock ? lastBlock.count - suffixStart : 0;
        const combined = new Uint32Array(prefix + incoming.length + suffix);
        for (let i = 0; i < prefix; i++) { combined[i] = firstBlock.slots[i]; if ((++work & 255) === 0) yield; }
        for (let i = 0; i < incoming.length; i++) { combined[prefix + i] = incoming[i]; if ((++work & 255) === 0) yield; }
        for (let i = 0; i < suffix; i++) { combined[prefix + incoming.length + i] = lastBlock.slots[suffixStart + i]; if ((++work & 255) === 0) yield; }
        const replacement: Block[] = [];
        for (let i = 0; i < combined.length; i += PAINT_ORDER_CHUNK) {
            if (this.nextBlock > 0x7fffffff) throw new RangeError('Paint-order chunk identifiers exhausted');
            const slots = new Uint32Array(PAINT_ORDER_CHUNK), size = Math.min(PAINT_ORDER_CHUNK, combined.length - i);
            for (let j = 0; j < size; j++) { slots[j] = combined[i + j]; if ((++work & 255) === 0) yield; }
            replacement.push({ id: this.nextBlock++, sheet: sheetId, slots, count: size, index: 0 });
        }
        const removed = firstBlock ? end - begin + 1 : 0;
        const blocks: Block[] = [];
        for (let i = 0; i < begin; i++) { blocks.push(sheet.blocks[i]); if ((++work & 255) === 0) yield; }
        for (const block of replacement) { blocks.push(block); if ((++work & 255) === 0) yield; }
        for (let i = begin + removed; i < sheet.blocks.length; i++) { blocks.push(sheet.blocks[i]); if ((++work & 255) === 0) yield; }
        for (let i = begin; i < begin + removed; i++) {
            const block = sheet.blocks[i]; this.blocks.delete(block.id);
            for (let j = 0; j < block.count; j++) { this.locations[block.slots[j]] = -1; if ((++work & 255) === 0) yield; }
        }
        sheet.blocks = blocks;
        for (const block of replacement) {
            this.blocks.set(block.id, block);
            for (let i = 0; i < block.count; i++) {
                this.locations[block.slots[i]] = block.id; this.offsets[block.slots[i]] = i;
                if ((++work & 255) === 0) yield;
            }
        }
        sheet.size += incoming.length - deleted;
        sheet.fenwick = new Uint32Array(sheet.blocks.length + 1);
        for (let i = 0; i < sheet.blocks.length; i++) {
            sheet.blocks[i].index = i;
            const index = i + 1, parent = index + (index & -index);
            sheet.fenwick[index] += sheet.blocks[i].count;
            if (parent < sheet.fenwick.length) sheet.fenwick[parent] += sheet.fenwick[index];
            if ((++work & 255) === 0) yield;
        }
    }
    *moveSteps(fromSheet: number, first: number, count: number, toSheet: number, toRank: number): Generator<void, void> {
        const source = this.sheets.get(fromSheet), size = source?.size ?? 0, destinationSize = this.size(toSheet);
        if (!Number.isInteger(first) || !Number.isInteger(count) || first < 0 || count < 0 || first + count > size
            || !Number.isInteger(toRank) || toRank < 0 || toRank > destinationSize) throw new RangeError('Invalid paint-order move');
        if (!count || (fromSheet === toSheet && toRank >= first && toRank <= first + count)) return;
        const slots = new Uint32Array(count);
        let block = this.locate(source!, first), local = first - this.prefix(source!, block), offset = 0;
        while (offset < count) {
            const chunk = source!.blocks[block++], take = Math.min(count - offset, chunk.count - local);
            for (let i = 0; i < take; i++) { slots[offset++] = chunk.slots[local + i]; if ((offset & 255) === 0) yield; }
            local = 0;
        }
        yield* this.spliceSteps(fromSheet, first, count, EMPTY);
        const target = fromSheet === toSheet && toRank > first + count ? toRank - count : toRank;
        yield* this.spliceSteps(toSheet, target, 0, slots);
    }
    /** Cold construction only; callers seal before exposing ranks or accepting edits. */
    appendBootstrap(sheetId: number, input: ArrayLike<number>, first: number, count: number): void {
        if (!Number.isInteger(count) || count < 0 || count > PAINT_ORDER_CHUNK || first < 0 || first + count > input.length) throw new RangeError('Invalid bootstrap order chunk');
        if (!count) return;
        let sheet = this.sheets.get(sheetId);
        if (!sheet) { sheet = { blocks: [], fenwick: new Uint32Array(1), size: 0 }; this.sheets.set(sheetId, sheet); }
        if (this.nextBlock > 0x7fffffff) throw new RangeError('Paint-order chunk identifiers exhausted');
        const slots = new Uint32Array(PAINT_ORDER_CHUNK), id = this.nextBlock++;
        const seen = new Set<number>();
        for (let i = 0; i < count; i++) {
            const slot = input[first + i];
            if (!Number.isInteger(slot) || slot < 0 || slot > 0x7fffffff || this.has(slot) || seen.has(slot)) throw new RangeError('Duplicate or invalid bootstrap slot');
            seen.add(slot); slots[i] = slot;
        }
        for (let i = 0; i < count; i++) {
            const slot = slots[i]; this.reserve(slot + 1); this.locations[slot] = id; this.offsets[slot] = i;
        }
        const block: Block = { id, sheet: sheetId, slots, count, index: sheet.blocks.length };
        sheet.blocks.push(block); sheet.size += count; this.blocks.set(id, block);
    }
    sealBootstrap(sheetId: number): void {
        const sheet = this.sheets.get(sheetId);
        if (!sheet) return;
        sheet.fenwick = new Uint32Array(sheet.blocks.length + 1);
        for (let i = 0; i < sheet.blocks.length; i++) {
            const index = i + 1, parent = index + (index & -index);
            sheet.fenwick[index] += sheet.blocks[i].count;
            if (parent < sheet.fenwick.length) sheet.fenwick[parent] += sheet.fenwick[index];
        }
    }
    remove(sheet: number, first: number, count: number): void { this.splice(sheet, first, count, EMPTY); }
    *chunks(sheet: number): Iterable<PaintOrderChunk> {
        for (const block of this.sheets.get(sheet)?.blocks ?? []) yield block;
    }
    forEachChunk(sheet: number, visit: (chunk: PaintOrderChunk) => void): void {
        const order = this.sheets.get(sheet);
        if (order) for (const block of order.blocks) visit(block);
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
