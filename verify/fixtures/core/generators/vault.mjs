import { parseArgs, uint32 } from '../../lib/cli.mjs';
import { fixtureWriter, jsonBytes } from '../../lib/output.mjs';
import { seededRandom } from '../../lib/random.mjs';
import { checkerPng } from '../../lib/checker.mjs';
import { allConstructs } from './notes.mjs';
const { out, seed, notes: countValue } = parseArgs(process.argv.slice(2), ['notes']);
const count = uint32(countValue, 'notes');
if (![100, 1000, 2000, 5000].includes(count))
    throw new Error('--notes must be 100, 1000, 2000 or 5000');
const random = seededRandom(seed);
const files = [];
const pathFor = i => `Folder-${String(i % 20).padStart(2, '0')}/Note-${String(i).padStart(5, '0')}.md`;
const image = checkerPng().toString('base64');
files.push({ path: 'Every construct.md', encoding: 'utf8', content: allConstructs });
files.push({ path: 'Welcome.md', encoding: 'utf8', content: '# Welcome\n\nBME-VAULT-v1\n\n[[Every construct]]\n' });
// N means N Markdown notes including the two named witnesses, not N plus helpers.
for (let i = 0; i < count - 2; i++) {
    const next = (i + 1) % (count - 2);
    const target = Math.floor(random() * (count - 2));
    files.push({
        path: pathFor(i), encoding: 'utf8',
        content: `# Note ${i}\n\nFixture seed ${seed}; note ${i}; sentinel BME-NOTE-${i}.\n\n` +
            `[[${pathFor(next).slice(0, -3)}]] [[${pathFor(target).slice(0, -3)}|Seeded alias]] [[Welcome]]\n\n` +
            `#fixture #group/${i % 7}\n\n![[checker.png]]\n\n![[checker.png|64]]\n`,
    });
}
files.push({ path: '.Assets/checker.png', encoding: 'base64', content: image });
for (let folder = 0; folder < 20; folder++) {
    files.push({ path: `Folder-${String(folder).padStart(2, '0')}/.Assets/checker.png`, encoding: 'base64', content: image });
}
await fixtureWriter(out)(`vault-${count}.json`, jsonBytes({ schema: 1, name: `Fixture-${count}`, seed, noteCount: count, files }));
