import { fastGuard, generatedVault, documentFixtures, openDocument } from '../lib/fast.mjs';
import { forceReload } from '../lib/reload.mjs';

await fastGuard('X-START', async ({ session }) => {
    const documents = await documentFixtures();
    for (const [label, files, path] of [
        ['markdown-1000', await generatedVault(1000), 'Welcome.md'],
        ['mixed-note', { ...await generatedVault(), ...documents }, 'Welcome.md'],
        ['mixed-pdf', { ...await generatedVault(), ...documents }, 'sample.pdf'],
    ]) {
        await session({ label, files, requests: false }, async ({ page, check, meta }) => {
            await openDocument(page, path);
            // Observe the app's session write; never manufacture a restored tab.
            await page.waitForFunction(path => Object.keys(localStorage).some(key =>
                key.includes('tab') && localStorage.getItem(key)?.includes(path)), path);
            meta.restores = [];
            for (const arm of ['first-restored-start', 'warm-restored-start']) {
                const reload = await forceReload(page, { arm: 'pinned-chrome' });
                const surface = path.endsWith('.pdf') ? page.locator('.pdf-viewer-page canvas:visible').first() : page.locator('.cm-content:visible');
                await surface.waitFor();
                await check(`${arm}: first document visible`, true, await surface.isVisible());
                if (path.endsWith('.pdf')) {
                    await page.waitForFunction(() => [...document.querySelectorAll('.pdf-viewer-page canvas')].some(canvas => canvas.width > 0 && canvas.height > 0));
                } else await check(`${arm}: readable note text`, true, (await surface.innerText()).includes('BME-VAULT-v1'));
                meta.restores.push({ arm, reload, document: path });
            }
            meta.scope = 'Functional native-handle restored starts only. No startup timings, byte budgets, long-task counts or cold-profile claim; those belong to V-08.';
        });
    }
});
