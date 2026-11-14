import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// Composition is explicit; oracle/manifest files never become user's vault notes.
export async function loadScenarioFixture(prepared, scenario) {
    const files = {}, inputs = [];
    const add = async (record, path = record.file) => {
        const bytes = await readFile(record.path);
        if (sha(bytes) !== record.sha256 || bytes.length !== record.bytes) throw new Error(`Prepared fixture changed: ${record.id}`);
        files[path] = bytes; inputs.push({ id: record.id, path, sha256: record.sha256, bytes: bytes.length });
    };
    const find = id => {
        const record = prepared.fixtures.find(f => f.id === id);
        if (!record) throw new Error(`Missing prepared fixture ${id}`);
        return record;
    };
    const startup = scenario.startsWith('startup-');
    let composition = null;
    if (startup) {
        const mixed = scenario !== 'startup-markdown';
        const record = find(mixed ? 'core/startup-v08/startup-mixed-v08.json' : 'core/vault-1000/vault-1000.json');
        await add(record);
        const bundle = JSON.parse(files[record.file].toString('utf8')); delete files[record.file];
        if (bundle.noteCount !== (mixed ? 1001 : 1000)) throw new Error('Startup fixture note count differs from registered composition');
        composition = bundle.composition ?? { id: 'core/vault-1000', noteCount: 1000 };
        for (const entry of bundle.files) files[entry.path] = Buffer.from(entry.content, entry.encoding === 'base64' ? 'base64' : 'utf8');
    } else if (scenario.startsWith('pdf-')) await add(find('GEN-01/geometry.pdf'));
    else if (scenario.startsWith('save-')) {
        await add(find('core/save-path/Mixed 10000 save-path.md'));
        await add(find('core/save-path/.Assets/save-only.png'));
    } else await add(find('core/notes/Mixed 10000.md'));
    const target = scenario === 'startup-mixed-pdf' || scenario.startsWith('pdf-') ? 'geometry.pdf'
        : startup ? 'Welcome.md' : scenario.startsWith('save-') ? 'Mixed 10000 save-path.md' : 'Mixed 10000.md';
    const manifest = Object.entries(files).map(([path, data]) => ({ path, bytes: data.length, sha256: sha(data) }));
    return { files, target, composition, kind: target.endsWith('.pdf') ? 'pdf' : 'note', inputs, manifest,
        sha256: sha(JSON.stringify(manifest)), text: target.endsWith('.md') ? files[target].toString('utf8') : null };
}

export async function seedRestore(page, { name, id, target }) {
    // Seed ONLY existing persistence keys, on an empty reset origin before app
    // scripts run. Thus restored cold startup still has empty HTTP/code caches.
    await page.evaluate(async ({ name, id, target }) => {
        const handle = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
        await new Promise((resolve, reject) => {
            const request = indexedDB.open('keyval-store', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('keyval');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result, tx = db.transaction('keyval', 'readwrite'), store = tx.objectStore('keyval');
                store.put(handle, 'vault-directory-handle');
                store.put([{ id, name, handle, openedAt: 1, pinned: false }], 'recent-vaults');
                tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
            };
        });
        localStorage.setItem('vaultSessions', JSON.stringify({ [id]: { v: 2, paths: target ? [target] : [], groups: target ? [[target]] : [], focus: target ? [target] : [], sizes: null, active: target } }));
    }, { name, id, target });
}
