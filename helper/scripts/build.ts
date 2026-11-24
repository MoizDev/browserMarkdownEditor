// Compile the helper into one self-contained executable.
//
//   bun helper/scripts/build.ts                          host OS/arch → helper/dist/vaultagent[.exe]
//   bun helper/scripts/build.ts --target bun-darwin-x64 --outfile helper/dist/vaultagent-darwin-x64
//
// Baked in with --define (see src/buildInfo.ts):
//   version  --version X   or env VAULTAGENT_VERSION   (default: the source version)
//   origins  --origins "https://a,https://b" or env VAULTAGENT_ALLOWED_ORIGINS
//            — EXTRA allowed origins; the production origin is always included.
//   releases --releases-base http://127.0.0.1:47890/releases or env VAULTAGENT_RELEASES_BASE
//            — where self-update looks for releases (default: the GitHub Releases page).
//            Tests only (a fake release server); release builds never set it.

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { normalizeOrigin } from '../src/security.ts';

const argv = process.argv.slice(2);
function opt(name: string): string | undefined {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
}

const helperDir = resolve(import.meta.dir, '..');
const target = opt('--target');
const windows = target ? target.includes('windows') : process.platform === 'win32';
const outfile = resolve(opt('--outfile') ?? join(helperDir, 'dist', windows ? 'vaultagent.exe' : 'vaultagent'));
const version = (opt('--version') ?? process.env.VAULTAGENT_VERSION ?? '').replace(/^vaultagent-v/, '').replace(/^v/, '');
const originsRaw = opt('--origins') ?? process.env.VAULTAGENT_ALLOWED_ORIGINS ?? '';
const releasesRaw = opt('--releases-base') ?? process.env.VAULTAGENT_RELEASES_BASE ?? '';

if (version && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error(`bad version: ${version}`);
    process.exit(1);
}
const origins = originsRaw.split(/[\s,]+/).filter(Boolean).map(o => {
    const n = normalizeOrigin(o);
    if (!n) {
        console.error(`bad origin (want scheme://host[:port], no path): ${o}`);
        process.exit(1);
    }
    return n;
});
const releasesBase = (() => {
    if (!releasesRaw) return '';
    let u: URL | null = null;
    try {
        u = new URL(releasesRaw);
    } catch { /* reported below */ }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || u.search || u.hash) {
        console.error(`bad releases base (want an http(s) URL, no query or fragment): ${releasesRaw}`);
        process.exit(1);
    }
    return u.href.replace(/\/+$/, '');
})();

mkdirSync(dirname(outfile), { recursive: true });
const cmd = [
    process.execPath, 'build', '--compile', '--minify', '--sourcemap=none',
    ...(target ? [`--target=${target}`] : []),
    // No console window flashing up at every login on Windows.
    ...(windows ? ['--windows-hide-console'] : []),
    `--define`, `__VAULTAGENT_VERSION__=${JSON.stringify(version)}`,
    `--define`, `__VAULTAGENT_EXTRA_ORIGINS__=${JSON.stringify(origins.join(','))}`,
    `--define`, `__VAULTAGENT_RELEASES_BASE__=${JSON.stringify(releasesBase)}`,
    join(helperDir, 'src', 'main.ts'),
    '--outfile', outfile,
];
const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit' });
const code = await proc.exited;
if (code !== 0) process.exit(code);
console.log(`built ${outfile}${version ? ` (v${version})` : ''}${origins.length ? ` + origins ${origins.join(', ')}` : ''}${releasesBase ? ` + releases ${releasesBase}` : ''}`);
