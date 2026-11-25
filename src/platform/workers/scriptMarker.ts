/** The first bytes of a built worker script that imports nothing (build/selfContainedWorkers.ts writes it, script.ts
 *  reads it): only such a script can run from a Blob URL, where a relative import or `import.meta.url` cannot resolve. */
export const SELF_CONTAINED_WORKER = '/*bme:self-contained-worker*/';
/** The last bytes of such a script: a response cut short still starts with the first mark, but has lost this one. */
export const SELF_CONTAINED_WORKER_END = '\n/*bme:self-contained-worker-end*/';
