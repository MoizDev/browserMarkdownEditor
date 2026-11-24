import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proposeGoldens, admitGoldens } from '../lib/picture/goldens.mjs';

const options = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    if (['--propose', '--admit'].includes(argv[i])) options[argv[i]] = true;
    else if (['--expected', '--actual', '--comparison', '--store', '--out', '--proposal', '--review'].includes(argv[i]) && argv[i + 1] && options[argv[i]] === undefined) options[argv[i]] = argv[++i];
    else throw new Error(`Unknown, duplicate or missing golden option: ${argv[i]}`);
}
if (!!options['--propose'] === !!options['--admit'] || !options['--store']) throw new Error('Choose --propose or --admit and an external --store');
let result;
if (options['--propose']) {
    for (const key of ['--expected', '--actual', '--comparison', '--out']) if (!options[key]) throw new Error(`Missing ${key}`);
    result = await proposeGoldens({ expectedDir: resolve(options['--expected']), actualDir: resolve(options['--actual']), comparisonDir: resolve(options['--comparison']), store: resolve(options['--store']), outDir: resolve(options['--out']) });
} else {
    if (!options['--proposal'] || !options['--review']) throw new Error('Admission requires --proposal and an explicitly approved --review note');
    result = await admitGoldens({ proposalPath: resolve(options['--proposal']), reviewPath: resolve(options['--review']), store: resolve(options['--store']), manifestPath: fileURLToPath(new URL('../goldens.manifest.json', import.meta.url)) });
}
process.stdout.write(`${JSON.stringify(result)}\n`);
