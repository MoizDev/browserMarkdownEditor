// Registration is explicit: adding a file to a directory never silently adds it to a corpus.
export const SEED = 123456789;
export const invocations = [
    { key: 'core/notes', stream: 'core', generator: 'verify/fixtures/core/generators/notes.mjs', args: [], gates: ['V-05', 'X-FUNNEL', 'TB-ED'], purpose: 'Every rendered Markdown construct, save-path mixed note, authored checker asset' },
    ...[100, 1000, 2000, 5000].map(notes => ({ key: `core/vault-${notes}`, stream: 'core', generator: 'verify/fixtures/core/generators/vault.mjs', args: ['--notes', String(notes)], gates: ['V-05', 'X-START', 'X-SESSION', 'X-FUNNEL'], purpose: `${notes} Markdown notes with seeded links, aliases, embeds, tags, folders and per-folder images` })),
    { key: 'platform/geometry', stream: 'platform', generator: 'verify/fixtures/platform/generators/geometry.mjs', args: [], gates: ['V-05', 'X-REGISTER', 'F-GEOM', 'F-LINK', 'D6'], purpose: 'GEN-01: 24 rotated/cropped/nonzero-origin/UserUnit/inherited/mixed-width pages and independent coordinate landmarks' },
    { key: 'core/save-path', stream: 'core', generator: 'verify/fixtures/core/generators/save-path.mjs', args: [], gates: ['V-05', 'V-08/save-main-thread-time', 'SAVE-PATH/today-plus-1ms', 'X-FUNNEL'], purpose: 'Separate 10000-line save-path workload: one visible line-4 embed, unique save-only.png asset, and independent before/after edit hashes for autosave plus completed retirement' },
    { key: 'core/startup-v08', stream: 'core', generator: 'verify/fixtures/core/generators/startup.mjs', args: ['--vault', '$ROOT/core/vault-1000/vault-1000.json', '--pdf', '$ROOT/platform/geometry/geometry.pdf', '--note', '$ROOT/core/notes/Mixed 10000.md'], gates: ['V-05', 'V-08', 'V-08/startup-cold-warm-restored-note-pdf', 'V-08/first-pixels-readable-bytes-requests-long-tasks-workers', 'X-START'], purpose: 'V-08 mixed startup composition: frozen vault-1000 + GEN-01 geometry PDF + frozen 10000-line note; restores Welcome.md or geometry.pdf for cold/warm first-pixels/readable, bytes/requests, long-task and worker-start baselines' },
    { key: 'platform/pictures', stream: 'platform', generator: 'verify/fixtures/platform/generators/pictures.mjs', args: [], gates: ['V-06', 'X-REGISTER'], purpose: 'Checker, translucent source-over overlap and fractional hairline picture pages' },
    { key: 'platform/damage', stream: 'platform', generator: 'verify/fixtures/platform/generators/damage.mjs', args: ['--input', '$ROOT/platform/geometry/geometry.pdf'], gates: ['V-05', 'F-ERROR'], purpose: 'Seeded truncation, bit flips, deep nesting and huge declared count mutations of GEN-01' },
];
export function fixtureMetadata(invocation, record) {
    const geometry = invocation.key === 'platform/geometry';
    const id = geometry ? `GEN-01/${record.file}` : `${invocation.key}/${record.file}`;
    return {
        id, ...record, tier: 1, licence: 'NOASSERTION', proposedLicence: 'CC0-1.0',
        sourceNotice: 'Independently authored synthetic fixture; CC0-1.0 proposed, not yet approved for redistribution. No private or third-party content.',
        purpose: invocation.purpose, gates: invocation.gates, generator: invocation.generator,
        version: 1, seed: SEED, args: invocation.args,
        ...(record.file === 'geometry.pdf' ? { pages: 24, expected: 'geometry.oracle.json' } : {}),
        ...(record.file === 'picture-pages.pdf' ? { pages: 3, expected: 'picture-pages.oracle.json' } : {}),
        ...(record.file === 'Mixed 10000 save-path.md' ? { expected: 'save-path.oracle.json' } : {}),
        ...(record.file === 'startup-mixed-v08.json' ? { composition: ['core/vault-1000/vault-1000.json', 'GEN-01/geometry.pdf', 'core/notes/Mixed 10000.md'], expected: { noteCount: 1001, restorePaths: ['Welcome.md', 'geometry.pdf'] } } : {}),
        ...(record.file.startsWith('geometry-invalid-') ? { validity: 'invalid', knownFailures: ['Intentionally invalid page box; not a renderability golden'] } : {}),
    };
}
