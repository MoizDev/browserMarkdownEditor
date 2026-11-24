// Validates an agent's tool arguments against the JSON Schemas the helper
// serves the CLI (shared/vaultAgentTools.ts VAULT_TOOLS) — the SAME objects,
// so what the executor accepts can never drift from what the agent was told.
//
// Only the keywords those schemas use: type, properties, required,
// additionalProperties:false, enum, const, minimum, maximum, exclusiveMinimum,
// minLength, minItems, maxItems, items, oneOf. A schema using anything else
// would be silently under-checked, so one does not get past review unnoticed:
// an unknown keyword is reported as an internal error, not skipped.

type Schema = Record<string, unknown>;

const KNOWN = new Set([
    'type', 'properties', 'required', 'additionalProperties', 'enum', 'const', 'minimum', 'maximum',
    'exclusiveMinimum', 'minLength', 'minItems', 'maxItems', 'items', 'oneOf', 'default', 'description',
]);

const MAX_ERRORS = 8;

function typeName(v: unknown): string {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    return typeof v;
}

function show(v: unknown): string {
    return JSON.stringify(v);
}

/** The `const` discriminators of a oneOf branch, e.g. {op:'create', type:'text'}. */
function discriminators(branch: Schema): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const props = (branch.properties ?? {}) as Record<string, Schema>;
    for (const [key, sub] of Object.entries(props)) if ('const' in sub) out[key] = sub.const;
    return out;
}

function describeBranch(branch: Schema): string {
    const d = discriminators(branch);
    if (Object.keys(d).length) return show(d);
    return `{${((branch.required ?? []) as string[]).join(', ')}}`;
}

function check(schema: Schema, value: unknown, at: string, errors: string[]): void {
    if (errors.length >= MAX_ERRORS) return;
    for (const key of Object.keys(schema)) {
        if (!KNOWN.has(key)) { errors.push(`${at}: (internal) unsupported schema keyword "${key}"`); return; }
    }
    const where = at || 'arguments';

    if (Array.isArray(schema.oneOf)) {
        const branches = schema.oneOf as Schema[];
        const discriminated = branches.some(b => Object.keys(discriminators(b)).length);
        if (discriminated && value && typeof value === 'object' && !Array.isArray(value)) {
            const v = value as Record<string, unknown>;
            const candidates = branches.filter(b => Object.entries(discriminators(b)).every(([k, c]) => v[k] === c));
            if (candidates.length === 1) { check(candidates[0], value, at, errors); return; }
            errors.push(`${where}: not a valid kind; expected one of ${branches.map(describeBranch).join(', ')}`);
            return;
        }
        for (const b of branches) {
            const trial: string[] = [];
            check(b, value, at, trial);
            if (!trial.length) return;
        }
        errors.push(`${where}: must be one of ${branches.map(describeBranch).join(' or ')}`);
        return;
    }

    if ('const' in schema && value !== schema.const) {
        errors.push(`${where}: must be ${show(schema.const)}`);
        return;
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        errors.push(`${where}: must be one of ${schema.enum.map(show).join(', ')} (got ${show(value)})`);
        return;
    }

    const type = schema.type as string | undefined;
    if (type) {
        const actual = typeName(value);
        const ok = type === actual
            || (type === 'number' && actual === 'integer' && Number.isFinite(value as number))
            || (type === 'number' && actual === 'number' && Number.isFinite(value as number));
        if (!ok) { errors.push(`${where}: must be ${type === 'integer' ? 'an integer' : `a ${type}`} (got ${actual})`); return; }
    }

    if (typeof value === 'number') {
        if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${where}: must be ≥ ${schema.minimum}`);
        if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${where}: must be ≤ ${schema.maximum}`);
        if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) errors.push(`${where}: must be > ${schema.exclusiveMinimum}`);
    }
    if (typeof value === 'string' && typeof schema.minLength === 'number' && value.length < schema.minLength) {
        errors.push(`${where}: must not be empty`);
    }

    if (Array.isArray(value)) {
        if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${where}: needs at least ${schema.minItems} item(s)`);
        if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${where}: at most ${schema.maxItems} item(s) allowed (got ${value.length})`);
        if (schema.items && typeof schema.items === 'object') {
            value.forEach((item, i) => check(schema.items as Schema, item, `${at}[${i}]`, errors));
        }
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        const props = (schema.properties ?? {}) as Record<string, Schema>;
        for (const req of (schema.required ?? []) as string[]) {
            if (obj[req] === undefined) errors.push(`${at ? `${at}.` : ''}${req}: required`);
        }
        for (const [key, v] of Object.entries(obj)) {
            const sub = props[key];
            if (!sub) {
                if (schema.additionalProperties === false) {
                    errors.push(`${at ? `${at}: ` : ''}unknown argument ${show(key)} (allowed: ${Object.keys(props).join(', ') || 'none'})`);
                }
                continue;
            }
            // An explicit null for an optional argument reads as "not given".
            if (v === null && !(schema.required as string[] | undefined)?.includes(key)) continue;
            check(sub, v, at ? `${at}.${key}` : key, errors);
        }
    }
}

/** Human-readable problems with `value` against `schema`; empty = valid. */
export function validateAgainstSchema(schema: Record<string, unknown>, value: unknown): string[] {
    const errors: string[] = [];
    check(schema, value, '', errors);
    return errors.slice(0, MAX_ERRORS);
}
