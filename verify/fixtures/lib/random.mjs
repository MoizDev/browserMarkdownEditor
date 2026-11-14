import { uint32 } from './cli.mjs';
// Mulberry32 uses only specified 32-bit integer operations, including for seed zero.
export function seededRandom(seed) {
    let state = uint32(seed);
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
        return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
    };
}
