import { fastGuard, documentFixtures, openDocument, treeRow } from '../lib/fast.mjs';

await fastGuard('X-MENUS', async ({ session }) => {
    await session({ label: 'surfaces', files: await documentFixtures() }, async ({ page, check, meta }) => {
        // Added after React's listeners. No injected preventDefault: only observe
        // the actual trusted right-click once the app has handled it.
        await page.evaluate(() => {
            window.__bmeMenuEvents = [];
            window.addEventListener('contextmenu', event => {
                window.__bmeMenuEvents.push({ prevented: event.defaultPrevented, target: event.target.tagName });
            });
        });
        meta.surfaces = [];
        const rightClick = async (label, locator) => {
            await locator.click({ button: 'right' });
            const observed = await page.evaluate(() => window.__bmeMenuEvents.at(-1));
            meta.surfaces.push({ label, ...observed });
            await check(`${label} contextmenu defaultPrevented`, true, observed?.prevented);
            await page.keyboard.press('Escape');
        };
        await rightClick('tree', treeRow(page, 'Welcome.md'));
        await openDocument(page, 'Welcome.md');
        await rightClick('note', page.locator('.cm-content:visible'));
        await rightClick('tab strip', page.locator('[role="tab"]:visible').first());
        await openDocument(page, 'sample.pdf');
        await rightClick('PDF', page.locator('.pdf-viewer-page canvas:visible').first());
        await openDocument(page, 'drawing.tldraw');
        await rightClick('drawing', page.locator('.tl-canvas:visible'));
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await rightClick('settings', page.locator('.settings-title'));
        await check('no native title tooltips', 0, await page.locator('[title]').count());
    });
});
