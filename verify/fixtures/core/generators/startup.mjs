import { readFile } from 'node:fs/promises';
import { parseArgs } from '../../lib/cli.mjs';
import { fixtureWriter, jsonBytes, sha256 } from '../../lib/output.mjs';

const { out, seed, vault: vaultPath, pdf: pdfPath, note: notePath } = parseArgs(process.argv.slice(2), ['vault', 'pdf', 'note']);
if (!vaultPath || !pdfPath || !notePath) throw new Error('--vault, --pdf and --note inputs are required');
const vaultBytes = await readFile(vaultPath);
const pdf = await readFile(pdfPath);
const note = await readFile(notePath);
const vault = JSON.parse(vaultBytes);
const input = (id, bytes) => ({ id, sha256: sha256(bytes), bytes: bytes.length });
const files = [...vault.files,
    { path: 'Mixed 10000.md', encoding: 'utf8', content: note.toString('utf8') },
    { path: 'geometry.pdf', encoding: 'base64', content: pdf.toString('base64') },
];
await fixtureWriter(out)('startup-mixed-v08.json', jsonBytes({
    schema: 1, name: 'V08-Mixed-Startup', seed, noteCount: vault.noteCount + 1,
    composition: {
        id: 'CORE-V08-MIXED-STARTUP', purpose: 'V-08 mixed start-up with a restored note or PDF; not an anonymous replacement for a measured real vault',
        inputs: [input('core/vault-1000/vault-1000.json', vaultBytes), input('GEN-01/geometry.pdf', pdf), input('core/notes/Mixed 10000.md', note)],
        restorePaths: ['Welcome.md', 'geometry.pdf'],
        metrics: ['startup-cold-restored-note', 'startup-warm-restored-note', 'startup-cold-restored-pdf', 'startup-warm-restored-pdf', 'first-document-first-pixels', 'first-document-readable', 'bytes-before-readable', 'requests-before-readable', 'long-tasks', 'workers-started'],
        gates: ['V-08', 'X-START'],
    },
    files,
}));
