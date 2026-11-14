import type { ContentJob, JobAuthority } from './admission';

export type ImportData = null | boolean | number | string | readonly ImportData[] | { readonly [key: string]: ImportData };
declare const importBrand: unique symbol;
export interface ValidatedImport<T extends ImportData> {
    readonly kind: 'validated-import';
    readonly notices: readonly string[];
    readonly [importBrand]: T;
}
export type ImportValidation<T extends ImportData> =
    | { readonly ok: true; readonly value: T; readonly notices: readonly string[] }
    | { readonly ok: false; readonly reason: string };
export interface ProjectionLimits { readonly entries: number; readonly characters: number; readonly depth: number; }
export type AdmissionResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };
export interface ImportAdmission<T extends ImportData> {
    prepare(input: unknown, job: ContentJob): AdmissionResult<ValidatedImport<T>>;
    /** One-shot: the issuer and job must match and the session must still be current. */
    take(token: ValidatedImport<T>, job: ContentJob): T;
}

// Copy fixed-shape validator output into owned inert data. Never invoke an accessor or spread an
// attacker-controlled property bag: a future decoder reply may be forged even over a bound port.
function ownProjection(value: ImportData, limits: ProjectionLimits): ImportData {
    if (!Number.isSafeInteger(limits.entries) || limits.entries < 1 || !Number.isSafeInteger(limits.characters)
        || limits.characters < 0 || !Number.isSafeInteger(limits.depth) || limits.depth < 1 || limits.depth > 128) {
        throw new RangeError('Invalid import projection limits');
    }
    let entries = 0, characters = 0;
    const seen = new WeakSet<object>();
    const containers: object[] = [];
    const pending: { source: object; target: Record<string, ImportData> | ImportData[]; depth: number }[] = [];
    const create = (source: unknown, depth: number): ImportData => {
        if (++entries > limits.entries || depth > limits.depth) throw new RangeError('Import projection exceeds its structural budget');
        if (source === null || typeof source === 'boolean') return source;
        if (typeof source === 'number') { if (!Number.isFinite(source)) throw new TypeError('Non-finite import number'); return source; }
        if (typeof source === 'string') {
            if (source.length > limits.characters - characters) throw new RangeError('Import projection exceeds its text budget');
            characters += source.length;
            return source;
        }
        if (typeof source !== 'object' || seen.has(source)) throw new TypeError('Import projection is not an inert tree');
        seen.add(source);
        const prototype = Object.getPrototypeOf(source);
        const array = Array.isArray(source);
        if ((!array && prototype !== Object.prototype && prototype !== null) || (array && prototype !== Array.prototype)) {
            throw new TypeError('Import projection contains an unsupported object');
        }
        const target: Record<string, ImportData> | ImportData[] = array ? [] : Object.create(null) as Record<string, ImportData>;
        pending.push({ source, target, depth });
        containers.push(target);
        return target;
    };
    const root = create(value, 0);
    while (pending.length) {
        const { source, target, depth } = pending.pop()!;
        const keys = Reflect.ownKeys(source);
        const array = Array.isArray(source);
        if (keys.length > limits.entries - entries + (array ? 1 : 0)) throw new RangeError('Import projection exceeds its structural budget');
        if (array && keys.length !== source.length + 1) throw new TypeError('Import arrays must be dense and have no extra fields');
        for (const key of keys) {
            if (array && key === 'length') continue;
            if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype') {
                throw new TypeError('Import projection has a forbidden key');
            }
            if (array && (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= source.length)) throw new TypeError('Import array key is invalid');
            if (!array) {
                if (key.length > limits.characters - characters) throw new RangeError('Import projection exceeds its text budget');
                characters += key.length;
            }
            const descriptor = Object.getOwnPropertyDescriptor(source, key);
            if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Import projection has a non-data property');
            const child = create(descriptor.value, depth + 1);
            if (Array.isArray(target)) target[Number(key)] = child;
            else target[key] = child;
        }
    }
    for (let index = containers.length - 1; index >= 0; index--) Object.freeze(containers[index]);
    return root;
}

/** The caller creates one issuer with its trusted fixed-shape schema validator. The issuer keeps
 * its registry private: a marker, structurally identical object or structured-cloned reply cannot
 * authorize commit, and an issuer made by a different caller cannot mint one of its tokens. */
export function createImportAdmission<T extends ImportData>(authority: JobAuthority, limits: ProjectionLimits,
    validate: (input: unknown) => ImportValidation<T>): ImportAdmission<T> {
    const owned = new WeakMap<object, { readonly job: ContentJob; readonly value: T }>();
    return {
        prepare(input, job) {
            if (!authority.isCurrent(job)) return { ok: false, reason: 'Content job is no longer current' };
            try {
                const result = validate(input);
                if (!result.ok) return result;
                if (result.notices.length > 128 || result.notices.some(notice => typeof notice !== 'string' || notice.length > 1000)) {
                    return { ok: false, reason: 'Import notices exceed their budget' };
                }
                const value = ownProjection(result.value, limits) as T;
                if (!authority.isCurrent(job)) return { ok: false, reason: 'Content job is no longer current' };
                const token = Object.freeze({ kind: 'validated-import', notices: Object.freeze([...result.notices]) }) as ValidatedImport<T>;
                owned.set(token, { job, value });
                return { ok: true, value: token };
            } catch (error) {
                if (error instanceof TypeError || error instanceof RangeError) return { ok: false, reason: error.message };
                throw error;
            }
        },
        take(token, job) {
            const entry = owned.get(token);
            if (!entry || !authority.isCurrent(job) || entry.job.session !== job.session || entry.job.vaultEpoch !== job.vaultEpoch
                || entry.job.generation !== job.generation || entry.job.request !== job.request) throw new TypeError('Unvalidated, stale or already-consumed import');
            owned.delete(token);
            return entry.value;
        },
    };
}
