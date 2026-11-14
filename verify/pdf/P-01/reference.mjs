// Independent fresh-context settled render through the real UI, with no hold
// armed. A logic mutant may never nominate itself as its pixel reference.
import { installPdfObservations } from './observe.mjs';
import { canvasFingerprint, publicGeometry, observedTrigger, waitForCanvasIdle } from './common.mjs';

export async function settledReference({ browser, tools, prepared, fixture, configuration, port }) {
    if (prepared.mutantName) throw new Error('A mutant is not an independent pixel reference');
    let server, context, binding;
    const report = { data: {} };
    try {
        server = await tools.serveApp({ root: prepared.root, scratch: prepared.scratch, port, mode: prepared.mode, build: false });
        const origin = new URL(server.url).origin;
        context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'en-US', colorScheme: 'dark' });
        await tools.installVault(context, { name: 'D1-vault' });
        await installPdfObservations(context);
        binding = await tools.bindServedBodies(context, { identity: prepared.identity, origin, mode: 'raw-route', buildMode: 'production', report,
            blockExternalOrigins: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] });
        const page = await context.newPage();
        await page.goto(server.url);
        await tools.seedVault(page, { name: 'D1-vault', files: { 'fixture.pdf': fixture, 'note.md': '# Visible note\n\nA calm window keeps every mark readable.\n' } });
        await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
        await page.locator('.tree-item').filter({ hasText: 'fixture.pdf' }).first().click();
        await page.waitForFunction(() => document.querySelector('.pdf-viewer-page canvas')?.dataset.nativeEmphasis === 'false');
        await page.evaluate(() => document.fonts.ready);
        for (let step = 0; step < configuration.warmSteps; step++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
        await waitForCanvasIdle(page, prepared, origin);
        const before = await publicGeometry(page);
        if (configuration.action === 'preference') await page.locator('.editor-slot-header').getByRole('button', { name: 'Word emphasis', exact: true }).click();
        else await page.getByRole('button', { name: configuration.action === 'out' ? 'Zoom out' : 'Zoom in', exact: true }).click();
        const scroll = page.locator('.pdf-viewer-scroll'), rectangle = await scroll.boundingBox();
        await page.mouse.move(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2);
        let delta = 1;
        if (configuration.incompatible === 'scroll') {
            const trigger = observedTrigger(before);
            delta = Math.ceil(trigger.y + trigger.h - before.need.y - before.need.h + 32);
        }
        if (configuration.incompatible === 'zoom') await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
        for (let n = 0; n < configuration.asks; n++) {
            await page.mouse.wheel(0, configuration.incompatible === 'scroll' ? delta : n % 2 ? -1 : 1);
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        }
        await waitForCanvasIdle(page, prepared, origin);
        const pixels = await canvasFingerprint(page), geometry = await publicGeometry(page), servedBinding = await binding.check();
        if (!servedBinding.modules.some(module => /\/pdf\.worker[^/]+\.mjs$/u.test(module.path))) throw new Error('Reference worker module was not bound');
        if (!pixels.painted || pixels.visibility !== 'visible') throw new Error('Independent reference has no visible glyph ink');
        return { identity: prepared.identity, pixels, geometry, delta, servedBinding };
    } finally {
        if (binding) await binding.stop();
        await context?.close();
        await server?.stop();
    }
}
