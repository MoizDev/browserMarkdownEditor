import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINS } from './pins.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const options = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
    if (!['--out', '--dist', '--chrome'].includes(argv[i]) || !argv[i + 1] || options[argv[i]] !== undefined) throw new Error('Expected unique --out, --dist and --chrome values');
    options[argv[i]] = resolve(argv[i + 1]);
}
if (!options['--out'] || !options['--dist'] || !options['--chrome']) throw new Error('Usage: node verify/image/prepare.mjs --out <fresh external context> --dist <production dist> --chrome <verified linux64 zip>');
const out = options['--out'];
if (out === ROOT || out.startsWith(`${ROOT}/`) || options['--dist'] === ROOT || options['--dist'].startsWith(`${ROOT}/`)) throw new Error('Image context and app dist must be outside the repository');

const functionalPin = JSON.parse(await readFile(resolve(ROOT, 'verify/browser-pin.json'), 'utf8'));
if (functionalPin.version !== PINS.browser.version || functionalPin.driver !== `playwright@${PINS.playwright}`) throw new Error('Image and functional browser/driver pins disagree');
const archive = await readFile(options['--chrome']);
if (archive.length !== PINS.browser.bytes || sha256(archive) !== PINS.browser.sha256) throw new Error('Chrome archive does not match the reviewed Linux pin');
await mkdir(out, { recursive: false });
await mkdir(resolve(out, 'fonts'));
await mkdir(resolve(out, 'node_modules'));
await copyFile(options['--chrome'], resolve(out, 'chrome-linux64.zip'), constants.COPYFILE_EXCL);
for (const name of ['Dockerfile', 'fonts.conf']) await copyFile(resolve(ROOT, 'verify/image', name), resolve(out, name), constants.COPYFILE_EXCL);
await copyFile(resolve(options['--dist'], 'THIRD_PARTY_NOTICES'), resolve(out, 'THIRD_PARTY_NOTICES'), constants.COPYFILE_EXCL);

const packages = {};
for (const name of ['playwright', 'playwright-core', 'pngjs']) {
    const directory = resolve(ROOT, 'node_modules', name);
    const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
    const wanted = name === 'pngjs' ? PINS.pngjs : PINS.playwright;
    if (pkg.version !== wanted) throw new Error(`Wrong installed image tool: ${name}@${pkg.version}, expected ${wanted}`);
    await cp(directory, resolve(out, 'node_modules', name), { recursive: true, force: false, errorOnExist: true });
    packages[name] = pkg.version;
}

const fontFiles = new Map();
const walk = async (directory, prefix = '') => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
        const relative = `${prefix}${entry.name}`;
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) await walk(path, `${relative}/`);
        else if (entry.isFile() && /\.(?:woff2?|ttf|otf)$/i.test(entry.name)) {
            const bytes = await readFile(path);
            const hash = sha256(bytes);
            if (fontFiles.has(hash)) {
                fontFiles.get(hash).sources.push(relative);
                continue;
            }
            const file = `${hash}${extname(entry.name).toLowerCase()}`;
            await writeFile(resolve(out, 'fonts', file), bytes, { flag: 'wx' });
            fontFiles.set(hash, { file, sha256: hash, bytes: bytes.length, sources: [relative] });
        }
    }
};
await walk(options['--dist']);
const fonts = [...fontFiles.values()].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
if (!fonts.length) throw new Error('The production app supplied no bundled font files; system fonts must not fill the hole');
const fontManifest = { schema: 1, source: 'Only font bytes shipped in this production app build; no host/system fonts', fonts };
await writeFile(resolve(out, 'fonts.manifest.json'), json(fontManifest), { flag: 'wx' });
const proposal = {
    ...PINS, packages,
    dockerfileSha256: sha256(await readFile(resolve(out, 'Dockerfile'))),
    fontconfigSha256: sha256(await readFile(resolve(out, 'fonts.conf'))),
    fontManifestSha256: sha256(Buffer.from(json(fontManifest))),
    fonts,
};
await writeFile(resolve(out, 'IMAGE.proposal.json'), json(proposal), { flag: 'wx' });
process.stdout.write(`${JSON.stringify({ context: out, fontFiles: fonts.length, proposalSha256: sha256(Buffer.from(json(proposal))) })}\n`);
