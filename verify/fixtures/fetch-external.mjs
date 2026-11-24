import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const manifest = JSON.parse(await readFile(new URL('./external.manifest.json', import.meta.url), 'utf8'));
const repository = fileURLToPath(new URL('../../', import.meta.url));
function publicUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || !url.hostname.includes('.') || /^localhost$|^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2[0-9]|3[01])\.|\[/.test(url.hostname)) {
        throw new Error('External fixture URL must be public HTTPS without credentials, query or fragment');
    }
    return url;
}
async function cachedIdentity(path) {
    const hash = createHash('sha256');
    let bytes = 0;
    try {
        for await (const chunk of createReadStream(path)) {
            hash.update(chunk);
            bytes += chunk.length;
        }
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    return { bytes, sha256: hash.digest('hex') };
}
export async function resolveExternal(id, { cache, fetchMissing = false }) {
    const fixture = manifest.fixtures.find(fixture => fixture.id === id);
    if (!fixture)
        throw new Error(`Unknown external fixture id: ${id}`);
    if (!/^[a-f0-9]{64}$/.test(fixture.sha256) || !Number.isSafeInteger(fixture.bytes) || fixture.bytes <= 0)
        throw new Error(`Invalid manifest identity: ${id}`);
    const base = resolve(cache);
    if (base === repository || base.startsWith(`${repository}/`))
        throw new Error('Fixture cache must be outside the repository');
    const result = { id, status: 'not run', sha256: fixture.sha256, bytes: fixture.bytes };
    if (fixture.admission !== 'approved' || fixture.licence === 'NOASSERTION')
        return { ...result, reason: 'rights hold: exact file not admitted' };
    const path = resolve(base, fixture.sha256);
    const cached = await cachedIdentity(path);
    if (cached) {
        return cached.bytes === fixture.bytes && cached.sha256 === fixture.sha256
            ? { ...result, status: 'available', path }
            : { ...result, reason: 'cached size or hash mismatch; not admitted' };
    }
    if (!fetchMissing)
        return { ...result, reason: 'absent from hash cache; fetch not requested' };
    let temporary;
    let handle;
    try {
        let url = publicUrl(fixture.url);
        let response;
        for (let redirects = 0; redirects <= 5; redirects++) {
            response = await fetch(url, { redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(120000) });
            if (response.status < 300 || response.status >= 400)
                break;
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (!location || redirects === 5)
                throw new Error('Download redirect limit or missing target');
            url = publicUrl(new URL(location, url).href);
        }
        if (!response.ok || !response.body)
            throw new Error(`Download status ${response.status}`);
        const declared = response.headers.get('content-length');
        if (declared && Number(declared) !== fixture.bytes) {
            await response.body.cancel();
            throw new Error('Download size header changed');
        }
        await mkdir(base, { recursive: true });
        const candidate = `${path}.part-${process.pid}`;
        handle = await open(candidate, 'wx');
        temporary = candidate;
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of response.body) {
            bytes += chunk.length;
            if (bytes > fixture.bytes)
                throw new Error('Download exceeds manifest size');
            hash.update(chunk);
            await handle.writeFile(chunk);
        }
        if (bytes !== fixture.bytes || hash.digest('hex') !== fixture.sha256)
            throw new Error('Downloaded size or hash changed; not admitted');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, path);
        temporary = undefined;
        return { ...result, status: 'available', path };
    }
    catch (error) {
        return { ...result, reason: error.message };
    }
    finally {
        await handle?.close();
        if (temporary)
            await rm(temporary, { force: true });
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const argv = process.argv.slice(2);
    let cache;
    let fetchMissing = false;
    const ids = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--cache')
            cache = argv[++i];
        else if (argv[i] === '--fetch')
            fetchMissing = true;
        else if (argv[i].startsWith('--'))
            throw new Error(`Unknown switch ${argv[i]}`);
        else
            ids.push(argv[i]);
    }
    if (!cache || !ids.length)
        throw new Error('Usage: node verify/fixtures/fetch-external.mjs --cache <external directory> [--fetch] <id>...');
    for (const id of ids) {
        const result = await resolveExternal(id, { cache, fetchMissing });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        if (result.status === 'not run')
            process.exitCode = 2;
    }
}
