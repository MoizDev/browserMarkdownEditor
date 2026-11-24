import { parseArgs } from '../../lib/cli.mjs';
import { checkerPng } from '../../lib/checker.mjs';
import { fixtureWriter, jsonBytes, sha256 } from '../../lib/output.mjs';
import { mixedNote } from './notes.mjs';

const { out, seed } = parseArgs(process.argv.slice(2));
const lines = mixedNote(seed).split('\n');
// Replace, do not insert: the pre-edit workload stays exactly 10,000 lines, and
// the single embed is visible at the top instead of requiring an untimed scroll.
lines[3] = '![[save-only.png]]';
const before = lines.join('\n');
const after = lines.filter((_, index) => index !== 3).join('\n');
const image = checkerPng();
const write = fixtureWriter(out);
await write('Mixed 10000 save-path.md', before);
await write('.Assets/save-only.png', image);
await write('save-path.oracle.json', jsonBytes({
    schema: 1, id: 'CORE-SAVE-EMBED-DROP', seed,
    note: 'Mixed 10000 save-path.md', noteLinesBefore: 10000, noteLinesAfter: 9999,
    edit: { line: 4, text: '![[save-only.png]]', action: 'Delete this entire line and its newline as one real editor edit' },
    beforeSha256: sha256(before), afterSha256: sha256(after),
    asset: { name: 'save-only.png', path: '.Assets/save-only.png', sha256: sha256(image), bytes: image.length, referencesBefore: 1, referencesAfter: 0 },
    purpose: 'V-08 save baseline and every save-path package: one autosave plus completed retirement of the one now-unreferenced image',
    gates: ['V-08/save-main-thread-time', 'SAVE-PATH/today-plus-1ms', 'X-FUNNEL'],
}));
