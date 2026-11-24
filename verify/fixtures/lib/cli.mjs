import { resolve } from 'node:path';
export function uint32(value, name = 'seed') {
    if (!/^(0|[1-9][0-9]*)$/.test(String(value)) || Number(value) > 0xffffffff) {
        throw new Error(`${name} must be an unsigned 32-bit integer`);
    }
    return Number(value);
}
export function parseArgs(argv, extra = []) {
    const allowed = new Set(['out', 'seed', ...extra]);
    const values = {};
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i]?.replace(/^--/, '');
        const value = argv[i + 1];
        if (!argv[i]?.startsWith('--') || !allowed.has(key) || value === undefined || key in values) {
            throw new Error(`Expected unique --${[...allowed].join(', --')} switches with values`);
        }
        values[key] = value;
    }
    if (!values.out || values.seed === undefined)
        throw new Error('--out and --seed are required');
    return { ...values, out: resolve(values.out), seed: uint32(values.seed) };
}
