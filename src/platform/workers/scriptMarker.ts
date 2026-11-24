/** The first bytes of a built worker script that imports nothing (build/selfContainedWorkers.ts writes it, script.ts
 *  reads it): only such a script can run from a Blob URL, where a relative import or `import.meta.url` cannot resolve. */
export const SELF_CONTAINED_WORKER = '/*bme:self-contained-worker*/';
