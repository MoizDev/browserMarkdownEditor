import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { prepareApp } from '../../lib/serve.mjs';
import { scratchRoot } from '../../lib/paths.mjs';

const kind = process.argv[2];
if (process.argv.length !== 4 || !['hyphen', 'abort'].includes(kind)) throw new Error('Usage: mutant.mjs <hyphen|abort> <fresh scratch root>');
const base = resolve(process.argv[3]), sourceRoot = resolve('.');
if (!base.startsWith(`${scratchRoot}/`)) throw new Error(`Mutants stay under the scratch folder ${scratchRoot}`);
await mkdir(base);
const root = resolve(base, 'source'), scratch = resolve(base, 'build');
await mkdir(root);
for (const file of ['src', 'shared', 'public', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'THIRD_PARTY_NOTICES']) {
    await cp(resolve(file), resolve(root, file), { recursive: true });
}
if (process.platform === 'darwin') execFileSync('/bin/cp', ['-cR', resolve('node_modules'), resolve(root, 'node_modules')]);
else await cp(resolve('node_modules'), resolve(root, 'node_modules'), { recursive: true, verbatimSymlinks: true });
const changes = [];
async function patch(file, before, after) {
    const path = resolve(root, file), text = await readFile(path, 'utf8');
    if (text.split(before).length !== 2) throw new Error(`Mutant patch no longer applies uniquely: ${file}`);
    const changed = text.replace(before, after);
    await writeFile(path, changed);
    changes.push({ file, before, after, originalSha256: createHash('sha256').update(text).digest('hex'), modifiedSha256: createHash('sha256').update(changed).digest('hex') });
}
if (kind === 'hyphen') await patch('src/utils/pdfFind.ts', 'if (lineEnd) { emit(LINE_HYPHEN, start);', 'if (false && lineEnd) { emit(LINE_HYPHEN, start);');
else {
    await patch('src/utils/pdfFind.ts', '            current?.abort();\n', '            // Mutant: the previous scan is not aborted.\n');
    await patch('src/components/PdfReadingText.tsx', 'findAbort.current?.abort(); const cancel = new AbortController();', 'const cancel = new AbortController();');
}
await writeFile(resolve(root, '.bme-mutant.json'), JSON.stringify({ name: kind, sourceRoot, changes }, null, 2) + '\n');
const prepared = await prepareApp({ root, scratch, mode: 'production' });
console.log(JSON.stringify({ kind, root, scratch, identity: prepared.identity.manifestSha256 }));
