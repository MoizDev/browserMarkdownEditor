// This shim replaces the storage library, not application code. Handles are packed
// recursively because recent-vaults stores them inside objects inside arrays.
const shim = `
const prefix = '__h_idb:';
async function pack(value) {
  if (value instanceof FileSystemHandle) {
    const path = await (await navigator.storage.getDirectory()).resolve(value);
    if (!path) throw new Error('Cannot pack a handle outside OPFS');
    return { __bmeHandle: { kind: value.kind, path } };
  }
  if (Array.isArray(value)) return Promise.all(value.map(pack));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = await pack(item);
    return result;
  }
  return value;
}
async function unpack(value) {
  if (value?.__bmeHandle) {
    const { kind, path } = value.__bmeHandle;
    let dir = await navigator.storage.getDirectory();
    for (const part of (kind === 'file' ? path.slice(0, -1) : path)) dir = await dir.getDirectoryHandle(part);
    return kind === 'file' ? dir.getFileHandle(path.at(-1)) : dir;
  }
  if (Array.isArray(value)) return Promise.all(value.map(unpack));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = await unpack(item);
    return result;
  }
  return value;
}
export async function get(key) { const raw = localStorage.getItem(prefix + key); return raw === null ? undefined : unpack(JSON.parse(raw)); }
export async function set(key, value) { localStorage.setItem(prefix + key, JSON.stringify(await pack(value))); }
export async function del(key) { localStorage.removeItem(prefix + key); }
export async function clear() { for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key); }
export async function keys() { return Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)); }
export async function values() { return Promise.all((await keys()).map(get)); }
export async function entries() { return Promise.all((await keys()).map(async key => [key, await get(key)])); }
export async function getMany(keys) { return Promise.all(keys.map(get)); }
export async function setMany(entries) { for (const [key, value] of entries) await set(key, value); }
export async function delMany(keys) { for (const key of keys) await del(key); }
export async function update(key, updater) { await set(key, updater(await get(key))); }
export function createStore() { return undefined; }
`;

/** Explicit arms only. The no-shim arm exercises native structured cloning.
 * @param {import('playwright').BrowserContext} context
 * @param {{arm: 'pinned-chrome'|'idb-shim', mode?: 'dev'|'production'|'benchmark'}} options
 */
export async function installReload(context, { arm, mode = 'dev' }) {
    if (!['pinned-chrome', 'idb-shim'].includes(arm)) throw new Error(`Name a reload arm, not ${arm}`);
    const identity = { arm, shim: arm === 'idb-shim', interceptions: 0 };
    if (arm === 'idb-shim') {
        if (mode !== 'dev') throw new Error('idb-shim routes the dev idb-keyval module; use the pinned-Chrome arm for production bundles');
        const pattern = /\/(?:[^?#]*\/deps\/idb-keyval\.js|node_modules\/idb-keyval\/[^?#]*\.js)(?:\?|$)/;
        // Raw binding owns the outer route when present; declare the same shim
        // bytes to it, rather than silently bypassing either storage or binding.
        Object.defineProperty(identity, 'moduleOverrides', { value: [{ name: 'idb-keyval reload shim', pattern, body: shim,
            contentType: 'text/javascript', onServe: () => { identity.interceptions++; } }] });
        await context.route(pattern, async route => {
            identity.interceptions++;
            await route.fulfill({ status: 200, contentType: 'text/javascript', body: shim });
        });
    }
    return identity;
}

/** A fragment-only goto preserves this marker and therefore cannot pass.
 * @param {import('playwright').Page} page
 * @param {{arm: 'pinned-chrome'|'idb-shim'}} options
 */
export async function forceReload(page, { arm }) {
    if (!['pinned-chrome', 'idb-shim'].includes(arm)) throw new Error('Reload arm must be explicit');
    const marker = `reload-${Date.now()}-${Math.random()}`;
    await page.evaluate(marker => { window.__bmeReloadMarker = marker; }, marker);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const survived = await page.evaluate(() => '__bmeReloadMarker' in window);
    if (survived) throw new Error('Not a reload: the previous document marker survived');
    const storage = await page.evaluate(async () => ({
        databases: (await indexedDB.databases()).map(db => db.name),
        shimKeys: Object.keys(localStorage).filter(key => key.startsWith('__h_idb:')),
    }));
    if (arm === 'pinned-chrome' && storage.shimKeys.length) throw new Error('Pinned-Chrome arm contains shim storage');
    if (arm === 'pinned-chrome' && !storage.databases.includes('keyval-store')) throw new Error('Native handle storage was not exercised');
    if (arm === 'idb-shim' && storage.shimKeys.length === 0) throw new Error('Shim arm did not intercept handle storage');
    return { arm, marker, markerGone: !survived, ...storage };
}
