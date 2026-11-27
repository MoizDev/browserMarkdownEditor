import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HELPER_APP_ID, RELEASE_MANIFEST } from '../../shared/vaultAgentProtocol.ts';
import { UPDATE_ASSET_NAMES, isReleaseVersion, parseManifest, type Manifest } from '../src/update.ts';

async function sha256File(path: string): Promise<string> {
    const hasher = new Bun.CryptoHasher('sha256');
    for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
    return hasher.digest('hex');
}

export async function buildManifest(version: string, dir: string, names: readonly string[] = UPDATE_ASSET_NAMES): Promise<Manifest> {
    if (!isReleaseVersion(version)) throw new Error(`bad version: ${version}`);
    const assets: Manifest['assets'] = {};
    for (const name of names) {
        const path = join(dir, name);
        if (!existsSync(path) || statSync(path).size === 0) throw new Error(`missing release asset: ${name}`);
        assets[name] = { sha256: await sha256File(path), size: statSync(path).size };
    }
    return parseManifest({ app: HELPER_APP_ID, version, assets });
}

if (import.meta.main) {
    const [rawVersion, dir] = process.argv.slice(2);
    if (!rawVersion || !dir) {
        console.error('usage: bun helper/scripts/release-manifest.ts <version> <assets-dir>');
        process.exit(2);
    }
    const version = rawVersion.replace(/^vaultagent-v/, '').replace(/^v/, '');
    try {
        const manifest = await buildManifest(version, dir);
        const out = join(dir, RELEASE_MANIFEST);
        writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
        console.log(`wrote ${out} (v${version}, ${Object.keys(manifest.assets).length} assets)`);
    } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
    }
}
